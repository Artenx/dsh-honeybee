import { createHash } from 'node:crypto'
import { SyncNodeManifestError, type SyncNodeApplyResult, type SyncNodeEntry, type SyncNodeService } from './node-sync.js'
import { SyncHostKeyChallengeError } from './host-key.js'
import { compareSyncRevision } from './revision.js'
import { syncRecordKey, type SyncCatalog, type SyncPeer } from './model.js'
import { SyncPeerManager, SyncPeerNotFoundError } from './peer-manager.js'
import type { SyncStateStore } from './stores.js'
import { SyncSessionDeltaPrefixError, SyncSshProbeError, SyncSshTransport } from './ssh-transport.js'
import {
  makeSyncSessionBundle,
  planSessionTransfers,
  SyncSessionError,
  SyncSessionService,
  sessionEventListDigest,
  syncSessionEntryKey,
  validateSyncSessionBundle,
  validateSyncSessionManifest,
} from './session-sync.js'
import type {
  SyncSessionApplyResult,
  SyncSessionBundle,
  SyncSessionEntry,
  SyncSessionEventPrefix,
  SyncSessionObject,
  SyncSessionManifest,
  SyncSessionManifestEntry,
} from './session-sync.js'
import { SYNC_CATALOG_CAPABILITY, SYNC_SESSION_BUNDLE_OBJECTS_CAPABILITY, SYNC_SESSION_EVENT_TAIL_CAPABILITY, SYNC_SESSION_MANIFEST_CAPABILITY, SYNC_SESSION_OBJECT_STREAM_CAPABILITY } from './protocol.js'
import { resolveSyncSelection, selectionIncludesNode, selectionIncludesSession } from './selection.js'

const EMPTY_APPLY_RESULT: SyncNodeApplyResult = { created: 0, updated: 0, deleted: 0, pendingRemoval: 0, skipped: 0 }
const TRANSPORT_RETRY_DELAY_MS = 250
// 会话分批交换的目标批体积与单批 key 数上限：目标值 ≈ JSON.parse 后对象图的
// 堆占用仍远小于宿主堆上限（桌面端约 1.4GB）；单批 key 上限限制批内的
// 条目数，避免 manifest 条目本身过大。
const SESSION_CHUNK_TARGET_BYTES = 12 * 1024 * 1024
const SESSION_CHUNK_MAX_KEYS = 8

export interface NodeTransferPlan {
  toLocal: SyncNodeEntry[]
  toRemote: SyncNodeEntry[]
  skipped: number
}

export interface SyncRunSummary {
  peerId: string
  direction: SyncPeer['direction']
  startedAt: string
  finishedAt: string
  remoteInstanceId: string
  imported: number
  exported: number
  skipped: number
  pendingRemoval: number
  importedSessions: number
  exportedSessions: number
  skippedSessions: number
}

export class SyncCoordinatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SyncCoordinatorError'
  }
}

function addCount(result: SyncNodeApplyResult): number {
  return result.created + result.updated + result.deleted
}

function manifestDigest(entries: readonly SyncNodeEntry[]): string {
  const versions = entries
    .map((entry) => ({
      key: syncRecordKey('node', entry.metadata),
      revision: entry.metadata.revision,
      contentDigest: entry.metadata.contentDigest,
      deleted: Boolean(entry.metadata.deleted),
    }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  return `sha256:${createHash('sha256').update(JSON.stringify(versions)).digest('hex')}`
}

export function planNodeTransfers(
  direction: SyncPeer['direction'],
  localEntries: readonly SyncNodeEntry[],
  remoteEntries: readonly SyncNodeEntry[],
): NodeTransferPlan {
  const toLocal: SyncNodeEntry[] = []
  const toRemote: SyncNodeEntry[] = []
  if (direction === 'pull') return { toLocal: [...remoteEntries], toRemote, skipped: 0 }

  const localByKey = new Map(localEntries.map((entry) => [syncRecordKey('node', entry.metadata), entry]))
  const remoteByKey = new Map(remoteEntries.map((entry) => [syncRecordKey('node', entry.metadata), entry]))
  const keys = new Set([...localByKey.keys(), ...remoteByKey.keys()])
  let skipped = 0

  for (const key of keys) {
    const local = localByKey.get(key)
    const remote = remoteByKey.get(key)
    if (!local) {
      toLocal.push(remote!)
      continue
    }
    if (!remote) {
      toRemote.push(local)
      continue
    }

    const comparison = compareSyncRevision(local.metadata.revision, remote.metadata.revision)
    if (comparison > 0) {
      toRemote.push(local)
    } else if (comparison < 0) {
      toLocal.push(remote)
    } else if (
      local.metadata.contentDigest === remote.metadata.contentDigest &&
      Boolean(local.metadata.deleted) === Boolean(remote.metadata.deleted)
    ) {
      skipped += 1
    } else {
      throw new SyncCoordinatorError('revision-conflict', 'Equal node revisions contain different content')
    }
  }
  return { toLocal, toRemote, skipped }
}

function mapFailure(error: unknown): SyncCoordinatorError {
  if (error instanceof SyncCoordinatorError) return error
  if (error instanceof SyncPeerNotFoundError) return new SyncCoordinatorError('peer-not-found', '同步节点已不存在')
  if (error instanceof SyncHostKeyChallengeError) {
    const code = error.decision === 'changed' ? 'host-key-changed' : 'host-key-untrusted'
    return new SyncCoordinatorError(code, error.message)
  }
  if (error instanceof SyncSshProbeError) {
    const messages: Record<string, string> = {
      auth: 'SSH 认证失败',
      network: 'SSH 节点不可达',
      timeout: 'SSH 连接超时',
      hostkey: 'SSH 主机密钥校验失败',
      helper: '远端同步 helper 不可用',
      protocol: '同步协议不兼容',
    }
    const baseMsg = messages[error.category] ?? 'SSH 同步失败'
    const detail = (error as Error & { detail?: string }).detail
    return new SyncCoordinatorError(`ssh-${error.category}`, detail ? `${baseMsg}：${detail}` : baseMsg)
  }
  if (error instanceof SyncNodeManifestError) return new SyncCoordinatorError('manifest-invalid', '节点 manifest 校验失败')
  if (error instanceof SyncSessionError) {
    return new SyncCoordinatorError(error.code.startsWith('session-') ? error.code : `session-${error.code}`, error.message)
  }
  return new SyncCoordinatorError('sync-failed', '同步作业失败')
}

function resultCount(result: SyncNodeApplyResult): { applied: number; skipped: number; pendingRemoval: number } {
  return {
    applied: addCount(result),
    skipped: result.skipped,
    pendingRemoval: result.pendingRemoval,
  }
}

function emptySessionResult(): SyncSessionApplyResult {
  return { created: 0, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }
}

function sessionResultCount(result: SyncSessionApplyResult): number {
  return result.created + result.updated + result.deleted
}

function addSessionResults(target: SyncSessionApplyResult, delta: SyncSessionApplyResult): SyncSessionApplyResult {
  return {
    created: target.created + delta.created,
    updated: target.updated + delta.updated,
    archived: target.archived + delta.archived,
    deleted: target.deleted + delta.deleted,
    skipped: target.skipped + delta.skipped,
    unmapped: target.unmapped + delta.unmapped,
  }
}

function mergeSessionSkipped(...reports: Array<readonly { sessionId: string; reason: string }[]>): Array<{ sessionId: string; reason: string }> {
  const merged = new Map<string, { sessionId: string; reason: string }>()
  for (const report of reports) {
    for (const entry of report) merged.set(JSON.stringify([entry.sessionId, entry.reason]), entry)
  }
  return [...merged.values()]
}

function assertSelectedSessionEntries(
  expectedEntries: readonly SyncSessionManifestEntry[],
  selectedEntries: readonly SyncSessionEntry[],
  side: string,
): void {
  const expected = new Map(expectedEntries.map((entry) => [syncSessionEntryKey(entry), entry]))
  const selected = new Map(selectedEntries.map((entry) => [syncSessionEntryKey(entry), entry]))
  if (selected.size !== selectedEntries.length || selected.size !== expected.size) {
    throw new SyncCoordinatorError('session-manifest-stale', `${side}会话内容与 manifest 清单不一致`)
  }
  for (const [key, expectedEntry] of expected) {
    const metadata = expectedEntry.metadata
    const currentEntry = selected.get(key)
    const current = currentEntry?.metadata
    const eventSummary = currentEntry?.eventDelta
      ? {
          eventCount: currentEntry.eventDelta.fullEventCount,
          eventDigest: currentEntry.eventDelta.fullEventDigest,
          inheritedEventCount: currentEntry.inheritedEventCount,
        }
      : currentEntry?.events
        ? {
            eventCount: currentEntry.events.length,
            eventDigest: sessionEventListDigest(currentEntry.events),
            inheritedEventCount: currentEntry.inheritedEventCount,
          }
        : undefined
    const hasExpectedEventSummary = expectedEntry.eventCount !== undefined || expectedEntry.eventDigest !== undefined ||
      expectedEntry.inheritedEventCount !== undefined
    const expectedWorkspace = metadata.workspaceOrigin
    const currentWorkspace = current?.workspaceOrigin
    const mismatches: string[] = []
    if (!current) mismatches.push('entry-missing')
    else {
      if (current.localEntityId !== metadata.localEntityId) mismatches.push('localEntityId')
      if (compareSyncRevision(current.revision, metadata.revision) !== 0) mismatches.push('revision')
      if (current.contentDigest !== metadata.contentDigest) mismatches.push('contentDigest')
      if (current.stateDigest !== metadata.stateDigest) mismatches.push('stateDigest')
      if (Boolean(current.deleted) !== Boolean(metadata.deleted)) mismatches.push('deleted')
      if (expectedWorkspace?.originInstanceId !== currentWorkspace?.originInstanceId ||
        expectedWorkspace?.originEntityId !== currentWorkspace?.originEntityId) mismatches.push('workspaceOrigin')
      if (hasExpectedEventSummary && (!eventSummary || eventSummary.eventCount !== expectedEntry.eventCount ||
        eventSummary.eventDigest !== expectedEntry.eventDigest || eventSummary.inheritedEventCount !== expectedEntry.inheritedEventCount)) {
        mismatches.push('eventSummary')
      }
    }
    if (mismatches.length > 0) {
      const detail = current && hasExpectedEventSummary
        ? ` expected(eventCount=${expectedEntry.eventCount}, inherited=${expectedEntry.inheritedEventCount}, digest=${expectedEntry.eventDigest})` +
          ` actual(${eventSummary ? `eventCount=${eventSummary.eventCount}, inherited=${eventSummary.inheritedEventCount}, digest=${eventSummary.eventDigest}` : 'no-events'})`
        : ''
      throw new SyncCoordinatorError('session-manifest-stale', `${side}会话内容在 manifest 之后发生变化（key=${key}，字段=${mismatches.join(',')}）${detail}`)
    }
  }
}

function sessionEventPrefixesFor(
  selectedEntries: readonly SyncSessionManifestEntry[],
  receiverEntries: readonly SyncSessionManifestEntry[],
): SyncSessionEventPrefix[] {
  const receiverByKey = new Map(receiverEntries.map((entry) => [syncSessionEntryKey(entry), entry]))
  const prefixes: SyncSessionEventPrefix[] = []
  for (const selected of selectedEntries) {
    if (selected.branchId || selected.metadata.deleted) continue
    const receiver = receiverByKey.get(syncSessionEntryKey(selected))
    if (!receiver || receiver.branchId || receiver.metadata.deleted || receiver.eventCount === undefined ||
      receiver.eventDigest === undefined || receiver.inheritedEventCount === undefined) continue
    prefixes.push({
      key: syncSessionEntryKey(selected),
      eventCount: receiver.eventCount,
      eventDigest: receiver.eventDigest,
      inheritedEventCount: receiver.inheritedEventCount,
    })
  }
  return prefixes
}

export class SyncCoordinator {
  private readonly inFlight = new Map<string, { promise: Promise<SyncRunSummary>; controller: AbortController }>()

  constructor(
    private readonly peers: SyncPeerManager,
    private readonly state: SyncStateStore,
    private readonly nodes: SyncNodeService,
    private readonly transport: SyncSshTransport,
    private readonly now: () => number = Date.now,
    private readonly sessions?: SyncSessionService,
  ) {}

  run(peerId: string): Promise<SyncRunSummary> {
    const active = this.inFlight.get(peerId)
    if (active) return active.promise
    const controller = new AbortController()
    const run = this.execute(peerId, controller.signal)
    this.inFlight.set(peerId, { promise: run, controller })
    void run.then(() => this.clear(peerId, run), () => this.clear(peerId, run))
    return run
  }

  /**
   * 手动停止运行中的同步：在最近的安全边界（批次之间）中止。
   * 返回是否确有运行中的作业。中止后丢弃本对端未完成的 journal 批次
   * （未应用条目不落地、重启不回放），水位保持不变，状态记为 stopped。
   */
  stop(peerId: string): boolean {
    const active = this.inFlight.get(peerId)
    if (!active) return false
    active.controller.abort()
    // 立即关闭该对端的活跃 SSH 通道：等待中的 readFrames 随即返回，
    // 不必等空闲超时（沙箱代理冻结场景下可能长达 60s）。
    try {
      this.transport.stopActiveSessions(peerId)
    } catch {}
    return true
  }

  /** 是否已手动停止：错误分类与收尾路径共用。 */
  private stopped(error: unknown): boolean {
    return error instanceof SyncCoordinatorError && error.code === 'stopped'
  }

  private throwIfStopped(signal: AbortSignal): void {
    if (signal.aborted) throw new SyncCoordinatorError('stopped', '同步已被手动停止')
  }

  /** 进度错误消息必须满足校验器限制（≤256、无控制字符），否则收尾写失败会卡住状态。 */
  private progressMessage(text: string): string {
    return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 256)
  }

  private async execute(peerId: string, signal: AbortSignal): Promise<SyncRunSummary> {
    const peer = await this.peers.get(peerId)
    if (!peer) throw new SyncCoordinatorError('peer-not-found', '同步节点已不存在')
    if (!peer.enabled) throw new SyncCoordinatorError('peer-disabled', '此同步节点已停用')
    if (signal.aborted) throw new SyncCoordinatorError('stopped', '同步已被手动停止')

    const startedAt = new Date(this.now()).toISOString()
    this.peers.updateProgress(peer.id, {
      lastRunAt: startedAt,
      lastRunStatus: 'running',
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    })

    try {
      if (peer.syncSessions && peer.mode !== 'metadata' && !this.sessions) {
        throw new SyncCoordinatorError('sessions-unavailable', '会话同步服务不可用')
      }
      const remoteNodeManifest = await this.retryTransport(signal, () => this.transport.fetchNodeManifest(peer.id))
      if (remoteNodeManifest.protocolVersion !== 1 || remoteNodeManifest.instanceId === this.state.instanceId()) {
        throw new SyncCoordinatorError('protocol-invalid', '同步 peer 协议版本或实例身份无效')
      }
      const remoteEntries = this.nodes.validateManifest(remoteNodeManifest.records)
      const localManifest = await this.nodes.exportManifest()
      const localEntries = this.nodes.validateManifest(localManifest.records)
      let catalog: SyncCatalog = {
        protocolVersion: 1,
        instanceId: remoteNodeManifest.instanceId,
        nodes: [],
        workspaces: [],
        sessions: [],
      }
      if (peer.mode === 'metadata' && peer.syncSessions) {
        // 元数据同步：只拉目录（节点/工作区/会话列表），不交换会话内容；
        // 点击同步来的会话时经远端会话通道（wss）实时操作远端 DSH。
        if (!remoteNodeManifest.capabilities?.includes(SYNC_CATALOG_CAPABILITY)) {
          throw new SyncCoordinatorError('metadata-catalog-unavailable', '目标同步节点需要升级以支持元数据同步')
        }
        catalog = await this.retryTransport(signal, () => this.transport.fetchCatalog(peer.id))
        if (catalog.instanceId !== remoteNodeManifest.instanceId) {
          throw new SyncCoordinatorError('protocol-invalid', '节点与目录清单的实例身份不一致')
        }
      } else if (peer.selection?.mode === 'selected' && peer.syncSessions &&
        (peer.selection.workspaces.length > 0 || peer.selection.sessions.length > 0)) {
        if (!remoteNodeManifest.capabilities?.includes(SYNC_CATALOG_CAPABILITY)) {
          throw new SyncCoordinatorError('selection-catalog-unavailable', '目标同步节点需要升级以支持自选范围')
        }
        catalog = await this.retryTransport(signal, () => this.transport.fetchCatalog(peer.id))
        if (catalog.instanceId !== remoteNodeManifest.instanceId) {
          throw new SyncCoordinatorError('protocol-invalid', '节点与目录清单的实例身份不一致')
        }
      }
      const selection = resolveSyncSelection(peer.mode === 'metadata' ? undefined : peer.selection, catalog)
      // 节点配置交换：全量模式恒开（会话导入依赖节点/工作区映射）；元数据模式
      // 可由「同步工作节点」关闭——关闭后仅校验对端身份并拉取目录。
      const syncNodes = peer.mode !== 'metadata' || peer.syncNodes !== false
      // 节点配置固定从远端拉取（同步语义简化后方向仅作用于会话内容交换）。
      const fullNodePlan: NodeTransferPlan = syncNodes ? planNodeTransfers('pull', localEntries, remoteEntries) : { toLocal: [], toRemote: [], skipped: 0 }
      const plan = !syncNodes || selection.all ? fullNodePlan : {
        ...fullNodePlan,
        toLocal: fullNodePlan.toLocal.filter((entry) => selectionIncludesNode(entry.metadata, selection)),
        toRemote: fullNodePlan.toRemote.filter((entry) => selectionIncludesNode(entry.metadata, selection)),
      }

      const localResult = plan.toLocal.length > 0
        ? await this.nodes.applyManifest(plan.toLocal, peer.name, 'peer')
        : EMPTY_APPLY_RESULT
      const remoteResult = plan.toRemote.length > 0
        ? await this.retryTransport(signal, () => this.transport.applyNodeManifest(peer.id, plan.toRemote, localManifest.instanceId))
        : EMPTY_APPLY_RESULT
      const localCounts = resultCount(localResult)
      const remoteCounts = resultCount(remoteResult)
      let importedSessions = 0
      let exportedSessions = 0
      let skippedSessions = 0
      let digest = manifestDigest(remoteEntries)
      if (peer.mode === 'metadata' && peer.syncSessions) {
        // 每次同步实时拉取目录并报告计数；会话内容交换整体跳过。
      } else if (peer.syncSessions) {
        const sessionService = this.sessions!
        let plan: ReturnType<typeof planSessionTransfers>
        let remoteSkipped = 0
        let remoteSessionDigest = ''
        let localSessionDigest = ''
        let localInstanceId = ''
        let sessionLocalResult = emptySessionResult()
        let sessionRemoteResult = emptySessionResult()
        if (remoteNodeManifest.capabilities?.includes(SYNC_SESSION_MANIFEST_CAPABILITY)) {
          const remoteManifest = validateSyncSessionManifest(
            await this.retryTransport(signal, () => this.transport.fetchSessionManifest(peer.id)),
          )
          if (remoteManifest.instanceId !== remoteNodeManifest.instanceId) {
            throw new SyncCoordinatorError('protocol-invalid', '节点与会话 manifest 的实例身份不一致')
          }
          const localManifest = await sessionService.exportManifest()
          const fullSessionPlan = planSessionTransfers(peer.direction, localManifest.entries, remoteManifest.entries)
          plan = selection.all ? fullSessionPlan : {
            ...fullSessionPlan,
            toLocal: fullSessionPlan.toLocal.filter((entry) => selectionIncludesSession(entry.metadata, selection)),
            toRemote: fullSessionPlan.toRemote.filter((entry) => selectionIncludesSession(entry.metadata, selection)),
          }
          remoteSessionDigest = remoteManifest.digest
          localSessionDigest = localManifest.digest
          localInstanceId = localManifest.instanceId
          const useEventDeltas = remoteNodeManifest.capabilities.includes(SYNC_SESSION_EVENT_TAIL_CAPABILITY)
          const useSharedObjects = remoteNodeManifest.capabilities.includes(SYNC_SESSION_BUNDLE_OBJECTS_CAPABILITY)
          const useObjectStream = remoteNodeManifest.capabilities.includes(SYNC_SESSION_OBJECT_STREAM_CAPABILITY)
          const remoteSkippedReports: Array<readonly { sessionId: string; reason: string }[]> = [remoteManifest.skipped]

          // 分批交换：首次同步（或长时间未同步后）plan 可能包含全部会话，一次性
          // fetch/export/apply 会让两端同时把整包内容驻留堆内（桌面端 1.4GB 堆
          // OOM 崩溃的根因，2026-11-01 崩溃日志）。按观测到的单 key 体积自适应
          // 分批：每批 fetch → 断言 → apply，批间释放内存；小计划（≤ 单批上限）
          // 仍只发一次请求，行为与旧实现一致。

          // 拉取方向（远端 → 本地）
          if (plan.toLocal.length > 0) {
            let perKeyBytes = 0
            let firstChunk = true
            let cursor = 0
            const keys = plan.toLocal.map(syncSessionEntryKey)
            while (cursor < keys.length) {
              const take = perKeyBytes > 0
                ? Math.max(1, Math.min(SESSION_CHUNK_MAX_KEYS, Math.floor(SESSION_CHUNK_TARGET_BYTES / perKeyBytes)))
                : SESSION_CHUNK_MAX_KEYS
              const chunkKeys = keys.slice(cursor, cursor + take)
              cursor += chunkKeys.length
              const chunkKeySet = new Set(chunkKeys)
              const chunkManifest = plan.toLocal.filter((entry) => chunkKeySet.has(syncSessionEntryKey(entry)))
              const prefixes = useEventDeltas ? sessionEventPrefixesFor(chunkManifest, localManifest.entries) : []
              this.throwIfStopped(signal)
              let fetched = validateSyncSessionBundle(await this.retryTransport(signal, () =>
                this.transport.fetchSessionEntries(peer.id, chunkKeys, remoteManifest.digest, prefixes, useObjectStream),
              ))
              this.throwIfStopped(signal)
              if (fetched.instanceId !== remoteManifest.instanceId) {
                throw new SyncCoordinatorError('protocol-invalid', '远端会话内容与 manifest 实例不一致')
              }
              assertSelectedSessionEntries(chunkManifest, fetched.entries, '远端')
              remoteSkippedReports.push(fetched.skipped)
              if (useObjectStream) {
                // 带外对象：bundle 里 deferred 描述符的载荷经对象流 RPC 拉到本地
                // 收件箱（磁盘流式，内存 O(帧)），随后 applyBundle 按摘要水合。
                const deferredObjects = fetched.entries.flatMap((entry) => (entry.objects ?? []).filter((object) => object.deferred === true))
                if (deferredObjects.length > 0) {
                  await this.retryTransport(signal, async () => {
                    await sessionService.ingestObjectStream(this.transport.fetchSessionObjects(peer.id, deferredObjects))
                  })
                }
              }
              const applySkipped = firstChunk ? mergeSessionSkipped(remoteManifest.skipped, fetched.skipped) : fetched.skipped
              try {
                const applied = await sessionService.applyBundle(
                  makeSyncSessionBundle(remoteManifest.instanceId, fetched.entries, applySkipped),
                  peer.name,
                  peer.id,
                )
                sessionLocalResult = addSessionResults(sessionLocalResult, applied)
              } catch (error) {
                if (!(error instanceof SyncSessionError && error.code === 'session-delta-prefix')) throw error
                // 回退拉全量内容：不带 deferred 标记，载荷内联（与既有回退语义一致，
                // 且不依赖已入库的收件箱对象）。
                const fullRemoteEntries = validateSyncSessionBundle(await this.retryTransport(signal, () =>
                  this.transport.fetchSessionEntries(peer.id, chunkKeys, remoteManifest.digest, undefined, false),
                ))
                if (fullRemoteEntries.instanceId !== remoteManifest.instanceId) {
                  throw new SyncCoordinatorError('protocol-invalid', '远端会话内容与 manifest 实例不一致')
                }
                assertSelectedSessionEntries(chunkManifest, fullRemoteEntries.entries, '远端')
                remoteSkippedReports.push(fullRemoteEntries.skipped)
                const applied = await sessionService.applyBundle(
                  makeSyncSessionBundle(
                    remoteManifest.instanceId,
                    fullRemoteEntries.entries,
                    firstChunk ? mergeSessionSkipped(remoteManifest.skipped, fullRemoteEntries.skipped) : fullRemoteEntries.skipped,
                  ),
                  peer.name,
                  peer.id,
                )
                sessionLocalResult = addSessionResults(sessionLocalResult, applied)
                fetched = fullRemoteEntries
              }
              const chunkBytes = Buffer.byteLength(JSON.stringify(fetched), 'utf8')
              if (chunkKeys.length > 0) perKeyBytes = Math.max(perKeyBytes, Math.ceil(chunkBytes / chunkKeys.length))
              firstChunk = false
            }
          } else if (remoteManifest.skipped.length > 0) {
            const applied = await sessionService.applyBundle(
              makeSyncSessionBundle(remoteManifest.instanceId, [], remoteManifest.skipped),
              peer.name,
              peer.id,
            )
            sessionLocalResult = addSessionResults(sessionLocalResult, applied)
          }
          remoteSkipped = mergeSessionSkipped(...remoteSkippedReports).length

          // 推送方向（本地 → 远端）
          if (plan.toRemote.length > 0) {
            const keys = plan.toRemote.map(syncSessionEntryKey)
            let perKeyBytes = 0
            let firstChunk = true
            let cursor = 0
            while (cursor < keys.length) {
              const take = perKeyBytes > 0
                ? Math.max(1, Math.min(SESSION_CHUNK_MAX_KEYS, Math.floor(SESSION_CHUNK_TARGET_BYTES / perKeyBytes)))
                : SESSION_CHUNK_MAX_KEYS
              const chunkKeys = keys.slice(cursor, cursor + take)
              cursor += chunkKeys.length
              const chunkKeySet = new Set(chunkKeys)
              const chunkManifest = plan.toRemote.filter((entry) => chunkKeySet.has(syncSessionEntryKey(entry)))
              const prefixes = useEventDeltas ? sessionEventPrefixesFor(chunkManifest, remoteManifest.entries) : []
              this.throwIfStopped(signal)
              const exported = await sessionService.exportEntries(
                chunkKeys,
                localManifest.digest,
                prefixes,
                { sharedObjects: useSharedObjects, deferredObjects: useObjectStream },
              )
              this.throwIfStopped(signal)
              assertSelectedSessionEntries(chunkManifest, exported.entries, '本地')
              const wireSkipped = firstChunk ? mergeSessionSkipped(localManifest.skipped, exported.skipped) : exported.skipped
              let wireBundle = exported.objects !== undefined
                ? makeSyncSessionBundle(exported.instanceId, exported.entries, wireSkipped, exported.objects)
                : makeSyncSessionBundle(exported.instanceId, exported.entries, wireSkipped)
              if (useObjectStream) {
                // 带外对象：先把 deferred 载荷推送进对端收件箱（磁盘流式，
                // 内存 O(帧)），再发 bundle；对端 apply 时按摘要水合。
                const deferredObjects = ((wireBundle.objects ?? wireBundle.entries.flatMap((entry) => entry.objects ?? [])) as SyncSessionObject[])
                  .filter((object) => object.deferred === true)
                if (deferredObjects.length > 0) {
                  await this.retryTransport(signal, () =>
                    this.transport.pushSessionObjects(peer.id, sessionService.streamObjects(deferredObjects)),
                  )
                }
              }
              try {
                const applied = await this.retryTransport(signal, () =>
                  this.transport.applySessionBundle(peer.id, wireBundle, localInstanceId),
                )
                sessionRemoteResult = addSessionResults(sessionRemoteResult, applied)
              } catch (error) {
                if (!(error instanceof SyncSessionDeltaPrefixError)) throw error
                // 回退推全量内容：不带 deferred 标记，载荷内联。
                const fullLocalEntries = await sessionService.exportEntries(
                  chunkKeys,
                  localManifest.digest,
                  [],
                  { sharedObjects: wireBundle.objects !== undefined, deferredObjects: false },
                )
                assertSelectedSessionEntries(chunkManifest, fullLocalEntries.entries, '本地')
                const skippedReport = firstChunk ? mergeSessionSkipped(localManifest.skipped, fullLocalEntries.skipped) : fullLocalEntries.skipped
                wireBundle = fullLocalEntries.objects !== undefined
                  ? makeSyncSessionBundle(fullLocalEntries.instanceId, fullLocalEntries.entries, skippedReport, fullLocalEntries.objects)
                  : makeSyncSessionBundle(fullLocalEntries.instanceId, fullLocalEntries.entries, skippedReport)
                const applied = await this.retryTransport(signal, () =>
                  this.transport.applySessionBundle(peer.id, wireBundle, localInstanceId),
                )
                sessionRemoteResult = addSessionResults(sessionRemoteResult, applied)
              }
              const chunkBytes = Buffer.byteLength(JSON.stringify(wireBundle), 'utf8')
              if (chunkKeys.length > 0) perKeyBytes = Math.max(perKeyBytes, Math.ceil(chunkBytes / chunkKeys.length))
              firstChunk = false
            }
          }
        } else {
          this.throwIfStopped(signal)
          const remoteBundle = validateSyncSessionBundle(await this.retryTransport(signal, () => this.transport.fetchSessionBundle(peer.id)))
          this.throwIfStopped(signal)
          if (remoteBundle.instanceId !== remoteNodeManifest.instanceId) {
            throw new SyncCoordinatorError('protocol-invalid', '节点与会话 manifest 的实例身份不一致')
          }
          const localBundle = await sessionService.exportBundle()
          plan = planSessionTransfers(peer.direction, localBundle.entries, remoteBundle.entries)
          remoteSkipped = remoteBundle.skipped.length
          remoteSessionDigest = remoteBundle.digest
          localSessionDigest = localBundle.digest
          localInstanceId = localBundle.instanceId
          if (plan.toLocal.length > 0 || remoteSkipped > 0) {
            sessionLocalResult = await sessionService.applyBundle(
              makeSyncSessionBundle(remoteBundle.instanceId, plan.toLocal, remoteBundle.skipped),
              peer.name,
              peer.id,
            )
          }
          if (plan.toRemote.length > 0) {
            sessionRemoteResult = await this.retryTransport(signal, () =>
              this.transport.applySessionBundle(
                peer.id,
                makeSyncSessionBundle(localBundle.instanceId, plan.toRemote, localBundle.skipped),
                localInstanceId,
              ),
            )
          }
        }
        importedSessions = sessionResultCount(sessionLocalResult)
        exportedSessions = sessionResultCount(sessionRemoteResult)
        skippedSessions = plan.skipped + sessionLocalResult.skipped + sessionRemoteResult.skipped
        digest = `sha256:${createHash('sha256').update(`${digest}\0${remoteSessionDigest}\0${localSessionDigest}`).digest('hex')}`
      }
      const finishedAt = new Date(this.now()).toISOString()
      const summary: SyncRunSummary = {
        peerId,
        direction: peer.direction,
        startedAt,
        finishedAt,
        remoteInstanceId: remoteNodeManifest.instanceId,
        imported: localCounts.applied,
        exported: remoteCounts.applied,
        skipped: plan.skipped + localCounts.skipped + remoteCounts.skipped + skippedSessions,
        pendingRemoval: localCounts.pendingRemoval + remoteCounts.pendingRemoval,
        importedSessions,
        exportedSessions,
        skippedSessions,
      }

      // 成功路径的进度写也不得抛出（否则 promise 拒绝被路由吞掉，状态卡 running）。
      try {
        this.peers.updateProgress(peer.id, {
          lastRunAt: finishedAt,
          lastRunStatus: 'succeeded',
          lastSuccessAt: finishedAt,
          lastManifestDigest: digest,
          watermark: digest,
          lastErrorCode: undefined,
          lastErrorMessage: undefined,
          lastResult: {
            imported: summary.imported,
            exported: summary.exported,
            skipped: summary.skipped,
            pendingRemoval: summary.pendingRemoval,
            importedSessions,
            exportedSessions,
            skippedSessions,
            ...(peer.mode === 'metadata' && peer.syncSessions ? {
              catalogNodes: catalog.nodes.length,
              catalogWorkspaces: catalog.workspaces.length,
              catalogSessions: catalog.sessions.length,
            } : {}),
          },
        })
      } catch {}
      return summary
    } catch (error) {
      if (this.stopped(error)) {
        // 手动停止：丢弃本对端未完成的 journal 批次（进行中的批不再落地、
        // 重启不回放），水位保持不变，状态记为 stopped。
        let discarded = 0
        try {
          discarded = this.sessions?.discardPendingBatches(peerId) ?? 0
        } catch {}
        const finishedAt = new Date(this.now()).toISOString()
        // 进度写失败不得遮蔽停止本身（校验器曾拒绝 stopped 值导致状态卡 running）。
        try {
          this.peers.updateProgress(peer.id, {
            lastRunAt: finishedAt,
            lastRunStatus: 'stopped',
            lastErrorCode: 'stopped',
            lastErrorMessage: discarded > 0 ? `已停止：丢弃 ${discarded} 个未完成批次，已完成的会话保留` : '已停止：已完成的会话保留',
          })
        } catch {}
        const summary: SyncRunSummary = {
          peerId,
          direction: peer.direction,
          startedAt,
          finishedAt,
          remoteInstanceId: '',
          imported: 0,
          exported: 0,
          skipped: 0,
          pendingRemoval: 0,
          importedSessions: 0,
          exportedSessions: 0,
          skippedSessions: 0,
        }
        return summary
      }
      const failure = mapFailure(error)
      if (!(error instanceof SyncCoordinatorError) && !(error instanceof SyncSshProbeError) && !(error instanceof SyncSessionError) && !(error instanceof SyncNodeManifestError) && !(error instanceof SyncHostKeyChallengeError) && !(error instanceof SyncPeerNotFoundError)) {
        failure.message = `${failure.message}：${error instanceof Error ? error.message : String(error)}`
      }
      try {
        this.peers.updateProgress(peer.id, {
          lastRunAt: new Date(this.now()).toISOString(),
          lastRunStatus: 'failed',
          lastErrorCode: failure.code,
          lastErrorMessage: this.progressMessage(failure.message),
        })
      } catch {}
      throw failure
    }
  }

  private clear(peerId: string, run: Promise<SyncRunSummary>): void {
    if (this.inFlight.get(peerId)?.promise === run) this.inFlight.delete(peerId)
  }

  private async retryTransport<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    this.throwIfStopped(signal)
    try {
      return await operation()
    } catch (error) {
      if (signal.aborted) throw new SyncCoordinatorError('stopped', '同步已被手动停止')
      if (!(error instanceof SyncSshProbeError) || !['network', 'timeout', 'helper'].includes(error.category)) throw error
      this.throwIfStopped(signal)
      await new Promise((resolve) => setTimeout(resolve, TRANSPORT_RETRY_DELAY_MS))
      this.throwIfStopped(signal)
      return operation()
    }
  }
}
