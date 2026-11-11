import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SyncCoordinator } from './coordinator.js'
import { SyncPeerManager } from './peer-manager.js'
import { SyncPeerImportStore } from './peer-imports.js'
import type { SyncStateStore } from './stores.js'
import { SyncSshTransport } from './ssh-transport.js'
import {
  makeSyncSessionBundle,
  SyncSessionError,
  SyncSessionService,
  syncSessionEntryKey,
  validateSyncSessionBundle,
  validateSyncSessionManifest,
  type SyncSessionApplyResult,
  type WorkspaceRegistryLike,
} from './session-sync.js'

const MAX_BODY_BYTES = 16 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      resolve(null)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail()
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          fail()
          return
        }
        settled = true
        resolve(value as Record<string, unknown>)
      } catch {
        fail()
      }
    })
    req.on('error', fail)
  })
}

/**
 * 按需导入单个远端会话（POST /api/dshb/sync/open-session，body: {peerId, sessionId}）。
 * 元数据同步模式下点击远端会话时，走与全量同步相同的
 * manifest → entries → applyBundle 链路只拉取这一个会话，导入完成后返回
 * 本地 sessionId，客户端随后用 uiWorkspace.openSession 原生打开——
 * 不再嵌套远端 DSH 主页 iframe。工作区/节点绑定由 ensureWorkspace 自动建立。
 */
export function registerSyncSessionOpenRoutes(
  ctx: Context,
  peers: SyncPeerManager,
  transport: SyncSshTransport,
  sessions: SyncSessionService,
  state: SyncStateStore,
  peerImports: SyncPeerImportStore,
  coordinator: SyncCoordinator,
  getWorkspaces: () => WorkspaceRegistryLike | undefined,
): void {
  const inFlight = new Map<string, Promise<string>>()

  const openSession = async (peerId: string, sessionId: string): Promise<string> => {
    const peer = await peers.get(peerId)
    if (!peer) throw new SyncSessionError('workspace-unmapped', '同步节点不存在')
    if (!peer.enabled) throw new SyncSessionError('workspace-unmapped', '同步节点已停用')
    // 秒开快路径：本机已有该会话的活跃导入记录。传入的 sessionId 是远端 localEntityId：
    // 对远端原始会话，本机记录的 originEntityId 即它；对远端的导入副本，localEntityId 同名。
    // 命中后直接复用本地副本，不做任何远端 RPC——重复打开从数十秒降到毫秒级。
    // （对 metadata 与 full 模式同样生效：full 模式的同步副本也记录在 records 里。）
    {
      const reused = Object.values(state.read().records).find((item) =>
        item.kind === 'session' && !item.deleted &&
        (item.originEntityId === sessionId || item.localEntityId === sessionId))
      if (reused) {
        // 幂等补挂：历史迁移/导入可能未把会话挂到工作区（此时 UI retain 会失败）。
        const wsOrigin = reused.workspaceOrigin
        const mapping = wsOrigin === undefined ? undefined : Object.values(state.read().workspaces).find((item) =>
          item.originInstanceId === wsOrigin.originInstanceId && item.originWorkspaceId === wsOrigin.originEntityId)
        if (mapping) {
          await sessions.adoptMigratedSession(reused, reused.localEntityId, mapping.localWorkspaceId, peer.name)
        }
        return reused.localEntityId
      }
    }
    // 元数据模式不会传输会话体，但 applyBundle 依赖「远端 workspace → 本机节点/工作区」
    // 的 origin 映射。全量 coordinator.run 每次数十秒；快路径：本地已存在该远端实例的
    // workspace 映射时直接跳过，applyBundle 若因映射缺失失败，再回退跑一次全量同步重试。
    const manifest = validateSyncSessionManifest(await transport.fetchSessionManifest(peerId))
    const entry = manifest.entries.find((item) =>
      !item.branchId && !item.metadata.deleted && item.metadata.localEntityId === sessionId)
    if (!entry) throw new SyncSessionError('workspace-unmapped', '远端会话不存在或已归档')
    const key = syncSessionEntryKey(entry)
    // 对象（图片/附件/spill）走带外流：entries 只传摘要描述符，载荷经对象流
    // 流式落收件箱后 applyBundle 水合——避免大会话的全部附件内联传输阻塞首开。
    const bundle = validateSyncSessionBundle(await transport.fetchSessionEntries(
      peerId, [key], manifest.digest, undefined, true,
    ))
    if (bundle.instanceId !== manifest.instanceId) {
      throw new SyncSessionError('manifest-invalid', '远端会话内容与 manifest 实例不一致')
    }
    const picked = bundle.entries.filter((item) => syncSessionEntryKey(item) === key && !item.metadata.deleted)
    if (picked.length === 0) {
      // 超限降级：事件文本总量超过单条导出上限的会话无法走 entries 协议。
      // 显式打开时改为「整文件迁移」：远端 file 端点返回原始 session.v4.jsonl.zstd，
      // 本机改写 header.cwd 为本机镜像路径后落盘，并写入同步记录。
      const tooLarge = manifest.skipped.some((item) =>
        item.sessionId === sessionId && item.reason === 'session-payload-too-large')
      if (!tooLarge) throw new SyncSessionError('workspace-unmapped', '远端会话内容不可用')
      const originWorkspaceId = entry.metadata.workspaceOrigin?.originEntityId
      const mapping = originWorkspaceId === undefined ? undefined : Object.values(state.read().workspaces).find(
        (item) => item.originInstanceId === manifest.instanceId && item.originWorkspaceId === originWorkspaceId)
      if (!mapping) throw new SyncSessionError('workspace-unmapped',
        '会话内容超过单次传输上限，且本机尚未建立其工作区映射；请先在同步设置中执行一次全量同步')
      const zstd = (await Promise.resolve().then(() => import('node:zlib'))) as unknown as {
        zstdDecompressSync?: (data: Buffer) => Buffer
        zstdCompressSync?: (data: Buffer) => Buffer
      }
      if (zstd.zstdDecompressSync === undefined || zstd.zstdCompressSync === undefined) {
        throw new SyncSessionError('session-format', '运行时 node 缺少 zstd 支持，无法迁移超限会话')
      }
      const compressed = await transport.fetchSessionFileViaInternal(peerId, sessionId, mapping.remotePath)
      // 会话日志文件由数千个独立 zstd 帧拼接而成（persistence 分代写入）。
      // 只改写第一帧（generation header）的 cwd 为本机镜像路径，其余帧原样保留——
      // 单帧重压缩会破坏 persistence 的分帧结构，导致 workspace plugin 组合失败。
      const frameMagic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
      const firstFrameEnd = compressed.indexOf(frameMagic, 4)
      if (firstFrameEnd < 0) throw new SyncSessionError('session-format', '远端会话文件缺少帧边界')
      const firstFrame = compressed.subarray(0, firstFrameEnd)
      const firstDecompressed = zstd.zstdDecompressSync!(firstFrame)
      const newlineIndex = firstDecompressed.indexOf(10)
      if (newlineIndex < 0) throw new SyncSessionError('session-format', '远端会话文件缺少 generation header')
      let headerLine = firstDecompressed.subarray(0, newlineIndex).toString('utf8')
      try {
        const header = JSON.parse(headerLine) as Record<string, unknown>
        header.cwd = mapping.localPath
        headerLine = JSON.stringify(header)
      } catch {
        throw new SyncSessionError('session-format', '远端会话 generation header 无法解析')
      }
      const rewrittenFirst = Buffer.concat([
        Buffer.from(headerLine, 'utf8'),
        firstDecompressed.subarray(newlineIndex),
      ])
      const recompressedFirst = zstd.zstdCompressSync!(rewrittenFirst)
      // 重组：重压缩的第一帧 + 原样保留的后续帧。
      const recompressed = Buffer.concat([recompressedFirst, compressed.subarray(firstFrameEnd)])
      const sessionsRootName = `--${mapping.localPath.split('/').filter(Boolean).join('-')}--`
      const sessionDir = join(homedir(), '.dsh', 'sessions', sessionsRootName, sessionId)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), recompressed)
      writeFileSync(join(sessionDir, 'session.lock'), Buffer.alloc(0))
      // 记录按远端 metadata 记账；本地文件已按远端字节落盘（仅 header.cwd 改写为本机镜像路径）。
      // 下次全量同步时两端 digest 一致，不会产生冲突。
      state.update((draft) => {
        draft.records[key] = { ...entry.metadata }
      })
      // 必须挂到 dsh 的工作区：否则 UI 打开时报 sessions.retain: unknown session。
      // 走 sessions 服务的 membership 收尾（registry 由服务内部持有，不再依赖注入时点）。
      await sessions.adoptMigratedSession(entry.metadata, sessionId, mapping.localWorkspaceId, peer.name)
      peerImports.add(peerId, sessionId)
      return sessionId
    }
    const deferredObjects = picked.flatMap((item) => (item.objects ?? []).filter((object) => object.deferred === true))
    if (deferredObjects.length > 0) {
      await sessions.ingestObjectStream(transport.fetchSessionObjects(peerId, deferredObjects))
    }
    // 本机可能残留该 origin 的墓碑（用户曾删除同步节点时生成，其修订晚于远端活跃条目）。
    // 按向量时间规则远端条目会被墓碑永久压制；但 open-session 是显式重新导入意图，先清除墓碑。
    const currentRecord = state.read().records[key]
    if (currentRecord?.deleted) {
      state.update((draft) => {
        delete draft.records[key]
      })
    }
    // 本机还可能有同 ID 的旧镜像会话文件（内容与远端分叉），触发 session-prefix-conflict。
    // 显式重导入以远端为准：把本地残留会话目录改名备份后重试。
    const quarantineStaleLocalSession = (): void => {
      // 冲突的本地文件是「本机导入副本」的目录（records[key].localEntityId），
      // 不一定与远端 localEntityId 同名——必须按本机 ID 定位。
      const localId = state.read().records[key]?.localEntityId
        ?? picked[0]?.metadata.localEntityId
      const mapping = Object.values(state.read().workspaces).find(
        (item) => item.originInstanceId === manifest.instanceId)
      if (!localId || !mapping) return
      const sessionsRootName = `--${mapping.localPath.split('/').filter(Boolean).join('-')}--`
      const staleDir = join(homedir(), '.dsh', 'sessions', sessionsRootName, localId)
      // 备份必须移出 sessions 扫描根目录：dsh 启动时扫描该根下所有会话目录，
      // 改名后的目录内 header id/cwd 与新路径不符会让 workspace plugin 组合失败，
      // 导致 workspaceRegistry 无法注入（本机所有会话功能瘫痪）。
      const backupRoot = join(homedir(), '.dsh', 'dshb', 'conflict-backups')
      try {
        mkdirSync(backupRoot, { recursive: true })
        renameSync(staleDir, join(backupRoot, `${localId}-${Date.now()}`))
      } catch {
        // 残留目录不存在或其他占用：继续重试，冲突会再次暴露。
      }
      state.update((draft) => {
        delete draft.records[key]
      })
    }
    const applyOnce = async (): Promise<SyncSessionApplyResult> => {
      return await sessions.applyBundle(
        makeSyncSessionBundle(manifest.instanceId, picked, bundle.skipped),
        peer.name,
        peerId,
      )
    }
    const mappingExists = peer.mode === 'metadata' &&
      Object.values(state.read().workspaces).some((mapping) => mapping.originInstanceId === manifest.instanceId)
    // prefix-conflict 可能从任意一次 applyBundle（含 fallback 全量同步内的批次）抛出，
    // 因此隔离+重试必须包住整个「apply → fallback 同步 → 再 apply」流程。
    const openWithRecovery = async (): Promise<SyncSessionApplyResult> => {
      try {
        let applied: SyncSessionApplyResult | undefined = await applyOnce().catch((error: unknown) => {
          const unmapped = error instanceof SyncSessionError && error.code === 'workspace-unmapped'
          if (peer.mode !== 'metadata' || (!unmapped && mappingExists)) throw error
          return undefined
        })
        const appliedTarget = applied !== undefined && applied.unmapped === 0 &&
          (applied.created > 0 || applied.updated > 0)
        if (appliedTarget && applied !== undefined) return applied
        // 映射缺失（首次打开该 peer 或远端新增工作区）：跑一次全量同步建立映射后重试。
        if (peer.mode === 'metadata') await coordinator.run(peerId)
        applied = await applyOnce()
        if (applied.unmapped > 0 || (applied.created === 0 && applied.updated === 0)) {
          const ws = picked[0]?.workspace
          throw new SyncSessionError('workspace-unmapped',
            `导入会话被跳过（unmapped=${applied.unmapped} skipped=${applied.skipped} created=${applied.created} updated=${applied.updated}）`
            + ` nodeOrigin=${JSON.stringify(ws?.nodeOrigin)} remotePath=${ws?.remotePath ?? '?'}`)
        }
        return applied
      } catch (error) {
        // prefix-conflict 可能以 SyncSessionError 或被 journal/apply 层包装（errorChain）冒泡，
        // 统一沿 cause 链按消息特征识别。
        let cursor: unknown = error
        let isPrefixConflict = false
        for (let depth = 0; cursor instanceof Error && depth < 8; depth += 1) {
          if (cursor.message.includes('已提交事件与导入前缀不同') ||
            cursor.message.includes('前缀比导入记录更长') ||
            (cursor as { code?: string }).code === 'session-prefix-conflict') {
            isPrefixConflict = true
            break
          }
          cursor = (cursor as Error & { cause?: unknown }).cause
        }
        if (!isPrefixConflict) throw error
        // 本机残留的镜像会话与远端内容分叉：以远端为准，隔离本地旧文件后重试一次。
        quarantineStaleLocalSession()
        return await applyOnce()
      }
    }
    const applied = await openWithRecovery()
    if (applied.unmapped > 0 || (applied.created === 0 && applied.updated === 0)) {
      const ws = picked[0]?.workspace
      throw new SyncSessionError('workspace-unmapped',
        `导入会话被跳过（unmapped=${applied.unmapped} skipped=${applied.skipped} created=${applied.created} updated=${applied.updated}）`
        + ` nodeOrigin=${JSON.stringify(ws?.nodeOrigin)} remotePath=${ws?.remotePath ?? '?'}`)
    }
    const record = state.read().records[key]
    if (!record || record.deleted) throw new SyncSessionError('workspace-unmapped', '会话导入后本地记录不可用')
    if (peer.mode === 'metadata') peerImports.add(peerId, record.localEntityId)
    return record.localEntityId
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/dshb/sync/open-session',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readBody(req)
        const peerId = typeof body?.peerId === 'string' ? body.peerId : ''
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (!/^p-[a-f0-9]{24}$/.test(peerId) || !sessionId || sessionId.length > 512) {
          sendJson(res, 400, { ok: false, error: 'peerId and sessionId are required' })
          return
        }
        const flightKey = `${peerId}:${sessionId}`
        try {
          let promise = inFlight.get(flightKey)
          if (!promise) {
            promise = openSession(peerId, sessionId).finally(() => inFlight.delete(flightKey))
            inFlight.set(flightKey, promise)
          }
          const localSessionId = await promise
          sendJson(res, 200, { ok: true, sessionId: localSessionId })
        } catch (error) {
          const code = error instanceof SyncSessionError ? error.code : 'session-open-failed'
          const status = code === 'bundle-too-large' ? 413
            : code === 'workspace-unmapped' ? 409
              : code === 'manifest-invalid' || code === 'session-format' ? 400 : 502
          // 带出根因链：applyBundle 会把底层异常包进 cause，排障需要最内层消息。
          const causes: string[] = []
          let cursor: unknown = error
          while (cursor instanceof Error && causes.length < 4) {
            causes.push(cursor.message)
            cursor = cursor.cause
          }
          sendJson(res, status, {
            ok: false,
            code,
            error: causes.join(' ← ').slice(0, 400) || '远端会话打开失败',
          })
        }
      },
    }),
  )
}