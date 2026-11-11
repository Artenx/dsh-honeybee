import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sharedWorldResolver } from '../router/resolve.js'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { sharedAuditLogger } from './audit.js'
import { KnownHostsStore } from './known-hosts.js'
import { NodeRegistry } from './node-registry.js'
import { registerNodeRoutes, registerSshConfigRoutes } from './routes.js'
import { registerWorkspaceRoutes, registerRemoteDownloadRoutes } from './workspaces.js'
import { registerWorkspaceInstructionRoutes } from './workspace-instruction-routes.js'
import { testNode, type DockerNodeTester, type SshHandshakeTester } from './test.js'
import { WorkspaceBindingsStore } from './workspace-bindings.js'
import { sharedWorkspaceInstructionStore } from './workspace-instructions.js'
import { registerWorkspaceInstructionInjector } from './workspace-instruction-context.js'
import { SyncPeerManager } from './sync/peer-manager.js'
import { registerSyncInternalRoutes } from './sync/internal-routes.js'
import { registerSyncPeerRoutes } from './sync/routes.js'
import { SyncSshTransport } from './sync/ssh-transport.js'
import { SyncCoordinator } from './sync/coordinator.js'
import { SyncScheduler } from './sync/scheduler.js'
import { SyncNodeService } from './sync/node-sync.js'
import { SyncSessionService, type WorkspaceRegistryLike } from './sync/session-sync.js'
import { registerSyncSessionRoutes } from './sync/session-routes.js'
import { registerSyncSessionOpenRoutes } from './sync/session-open-routes.js'
import { SyncOfflineArchiveService } from './sync/offline-archive.js'
import { registerSyncOfflineRoutes } from './sync/offline-routes.js'
import { registerRelayTicketRoutes } from './sync/relay-auth.js'
import { RemoteRelayService, registerRemoteRelayRoutes } from './sync/remote-relay.js'
import { SyncPeerStore, SyncStateStore } from './sync/stores.js'
import { SyncSessionJournalStore } from './sync/session-journal.js'
import { SyncPeerImportStore } from './sync/peer-imports.js'
import { sharedSessionInstructionSnapshotStore } from './workspace-instructions.js'

export const name = 'dshb-core'

export const inject = ['webServer', 'credentials']

export function apply(ctx: Context): void {
  const knownHosts = new KnownHostsStore()
  const registry = new NodeRegistry(ctx)
  const bindings = new WorkspaceBindingsStore()
  const syncPeers = new SyncPeerStore()
  const syncState = new SyncStateStore()
  const syncPeerManager = new SyncPeerManager(syncPeers, syncState, ctx.credentials as never)
  const syncPeerImports = new SyncPeerImportStore(process.env.DSH_HOME)
  const syncSshTransport = new SyncSshTransport(syncPeerManager)
  let workspaceRegistry: WorkspaceRegistryLike | undefined
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry'], (workspaceCtx: Context) => {
      workspaceRegistry = (workspaceCtx as unknown as { workspaceRegistry?: typeof workspaceRegistry }).workspaceRegistry
    })
  }
  const syncNodes = new SyncNodeService(registry, bindings, syncState, () => workspaceRegistry, (nodeId) => {
    const sshWorlds = ctx.get('dshbSshWorlds') as { remove?: (id: string) => void } | undefined
    const dockerWorlds = ctx.get('dshbDockerWorlds') as { remove?: (id: string) => void } | undefined
    sshWorlds?.remove?.(nodeId)
    dockerWorlds?.remove?.(nodeId)
  })
  const syncSessions = new SyncSessionService(
    syncState,
    syncNodes,
    registry,
    bindings,
    () => workspaceRegistry,
    () => ctx.get('sessionPersistence') as never,
    () => ctx.get('attachments') as never,
    () => ctx.get('spillStore') as never,
    sharedSessionInstructionSnapshotStore(),
    undefined,
    undefined,
    process.env.DSH_HOME,
    undefined,
    (header: SessionHeader) => {
      const cache = ctx.get('sessionProjectionCache') as {
        cachedSnapshot?: (meta: SessionHeader, keys?: readonly string[]) => { values?: Record<string, unknown> } | undefined
      } | undefined
      const snapshot = cache?.cachedSnapshot?.(header, ['title', 'sessionListMetadata'])
      const values = snapshot?.values as Record<string, unknown> | undefined
      let title = values?.title
      let listMeta = values?.sessionListMetadata as { blank?: boolean } | undefined
      // 进程内投影视图可能缺 sessionListMetadata（host 注册表差异），回退读持久化投影缓存文件。
      if (!listMeta || typeof title !== 'string' || !title.trim()) {
        try {
          const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
          const file = join(home, 'storages', 'session_projcache', 'sessions', String(header.id) + '.json')
          const stored = JSON.parse(readFileSync(file, 'utf8')) as { record?: { rows?: Record<string, { val?: unknown }> } }
          const rows = stored.record?.rows ?? {}
          const row = (rows.sessionListMetadata?.val ?? undefined) as { blank?: boolean } | undefined
          const titleRow = rows.title?.val
          if (!listMeta && row) listMeta = row
          if ((typeof title !== 'string' || !title.trim()) && typeof titleRow === 'string' && titleRow.trim()) title = titleRow
        } catch {
          // 投影文件缺失/损坏：按「不标记」处理，仅影响目录过滤精度。
        }
      }
      const result = {
        ...(typeof title === 'string' && title.trim() ? { title } : {}),
        ...(listMeta?.blank === true ? { blank: true } : {}),
      }
      return result
    },
  )
  const syncOfflineArchives = new SyncOfflineArchiveService(syncNodes, syncSessions, undefined, undefined, syncState)
  try {
    syncOfflineArchives.cleanupStagingDirectories()
    syncSessions.cleanupOrphanedStaging()
  } catch {
    ctx.logger.warn('sync staging cleanup failed')
  }
  const syncCoordinator = new SyncCoordinator(syncPeerManager, syncState, syncNodes, syncSshTransport, Date.now, syncSessions)
  const syncScheduler = new SyncScheduler(syncPeerManager, syncCoordinator)
  ctx.provide('nodeRegistry', registry)
  ctx.provide('knownHosts', knownHosts)
  ctx.provide('workspaceBindings', bindings)
  ctx.provide('syncPeerStore', syncPeers)
  ctx.provide('syncStateStore', syncState)
  ctx.provide('syncNodeService', syncNodes)
  ctx.provide('syncSessionService', syncSessions)
  ctx.provide('syncOfflineArchiveService', syncOfflineArchives)
  ctx.provide('syncPeerManager', syncPeerManager)
  ctx.provide('syncSshTransport', syncSshTransport)
  ctx.provide('syncCoordinator', syncCoordinator)
  ctx.provide('syncScheduler', syncScheduler)
  ctx.provide('dshbAudit', sharedAuditLogger())
  sharedWorldResolver().setBindings(bindings)
  void registerNodeRoutes(ctx, registry, bindings, () => workspaceRegistry, syncNodes)
  void registerSshConfigRoutes(ctx, knownHosts)
  void registerWorkspaceRoutes(ctx, registry, bindings, syncNodes)
  void registerRemoteDownloadRoutes(ctx, registry, bindings)
  void registerWorkspaceInstructionRoutes(ctx, sharedWorkspaceInstructionStore())
  registerSyncPeerRoutes(
    ctx,
    syncPeerManager,
    syncSshTransport,
    syncCoordinator,
    async (peer, remoteInstanceId) => {
      if (peer.mode !== 'metadata') return { sessionsArchived: 0, workspacesRemoved: 0, workspacesDetached: 0 }
      const sameNamePeers = (await syncPeerManager.list()).filter((candidate) => candidate.name === peer.name)
      const fallbackSourceName = sameNamePeers.length === 1 ? peer.name : undefined
      return syncSessions.removeMetadataPeerImports(remoteInstanceId, syncPeerImports.list(peer.id), fallbackSourceName)
    },
    (peerId) => syncPeerImports.clear(peerId),
  )
  registerSyncInternalRoutes(ctx, syncState, syncNodes, syncSessions)
  registerSyncSessionRoutes(ctx, syncSessions)
  registerSyncSessionOpenRoutes(ctx, syncPeerManager, syncSshTransport, syncSessions, syncState, syncPeerImports, syncCoordinator, () => workspaceRegistry)
  registerSyncOfflineRoutes(ctx, syncOfflineArchives)
  // 元数据同步（wss 方案）：远端侧铸造短时效凭据；本地侧经 SSH direct-tcpip
  // 转发 Remote unary 调用。凭据仅存内存，路由由既有登录门保护。
  registerRelayTicketRoutes(ctx, ctx.credentials as never)
  const remoteRelay = new RemoteRelayService(syncPeerManager, syncSshTransport)
  ctx.provide('remoteRelayService', remoteRelay)
  // 会话数据面（manifest/entries）优先经 wss 中继通道读取，省去逐 RPC 的 SSH 握手与 helper 启动。
  syncSshTransport.setRelayDataPlane(remoteRelay)
  const sessionJournal = new SyncSessionJournalStore(process.env.DSH_HOME)
  registerRemoteRelayRoutes(ctx, remoteRelay, {
    resolveSessionOrigin: (sessionId: string) => {
      const state = syncState.read()
      let recordKey: string | undefined
      let remoteSessionId: string | undefined
      for (const [key, meta] of Object.entries(state.records)) {
        if (meta.kind !== 'session' || meta.localEntityId !== sessionId) continue
        recordKey = key
        remoteSessionId = meta.originEntityId
        break
      }
      if (!recordKey || !remoteSessionId) {
        const archive = Object.values(state.archives).find((a) => a.localSessionId === sessionId)
        if (!archive) return undefined
        remoteSessionId = archive.originSessionId
        recordKey = archive.branchId
      }
      const peerId = sessionJournal.peerIdForRecordKey(recordKey)
      if (!peerId) return undefined
      return syncPeers.list().some((p) => p.id === peerId && p.enabled) ? { peerId, remoteSessionId } : undefined
    },
  })
  ctx.effect(() => {
    const stopScheduler = syncScheduler.start()
    // 带外对象收件箱 TTL 清扫：apply 失败/进程中断留下的孤儿文件按天回收。
    const inboxSweeper = setInterval(() => {
      void syncSessions.objectInbox.sweep().catch(() => {})
    }, 60 * 60 * 1000)
    inboxSweeper.unref()
    let disposed = false
    setImmediate(() => {
      if (disposed) return
      void (async () => {
        try {
          await syncSessions.recoverPending()
        } catch {
          ctx.logger.warn('sync session recovery remains pending')
        }
        try {
          await syncOfflineArchives.recoverPending()
        } catch {
          ctx.logger.warn('offline archive recovery remains pending')
        }
      })()
    })
    return () => {
      disposed = true
      clearInterval(inboxSweeper)
      stopScheduler()
    }
  })
  registerWorkspaceInstructionInjector(ctx)
  warmupWorlds(ctx, registry, bindings)
  startHeartbeat(ctx, registry)
  reprovisionDockerNodes(ctx, registry)
}

const HEARTBEAT_MS = 5 * 60 * 1000

function startHeartbeat(ctx: Context, registry: NodeRegistry): void {
  const tick = async (): Promise<void> => {
    const sshTester = ctx.get('dshbSshPool') as SshHandshakeTester | undefined
    const dockerTester = ctx.get('dshbDockerTester') as DockerNodeTester | undefined
    for (const node of registry.list()) {
      try {
        await testNode(registry, node.id, sshTester, undefined, dockerTester)
      } catch {
        // 单节点心跳失败不影响其他节点
      }
    }
  }
  const timer = setInterval(() => void tick(), HEARTBEAT_MS)
  ctx.effect(() => () => clearInterval(timer))
  setImmediate(() => void tick())
}

function reprovisionDockerNodes(ctx: Context, registry: NodeRegistry): void {
  setImmediate(() => {
    void (async () => {
      const provisioner = ctx.get('dshbDockerProvisioner') as { provision(nodeId: string): Promise<unknown> } | undefined
      if (!provisioner) return
      for (const node of registry.list()) {
        if (node.type !== 'local-docker' && node.type !== 'remote-docker') continue
        if (!node.docker?.image) continue
        if (node.docker?.containerId) continue
        try {
          await provisioner.provision(node.id)
        } catch {
          // 失败已记录到 provisionStatuses
        }
      }
    })()
  })
}

interface WarmupWorldsLike {
  ensure(nodeId: string): Promise<{ ensureDir(path: string): Promise<void> } | undefined>
}

function warmupWorlds(ctx: Context, registry: NodeRegistry, bindings: WorkspaceBindingsStore): void {
  setImmediate(() => {
    void (async () => {
      for (const b of bindings.list()) {
        const node = registry.get(b.nodeId)
        if (!node || node.type === 'local-host') continue
        try {
          const isDocker = node.type === 'local-docker' || node.type === 'remote-docker'
          const worlds = isDocker
            ? (ctx.get('dshbDockerWorldsGeneric') as WarmupWorldsLike | undefined)
            : (ctx.get('dshbWorlds') as WarmupWorldsLike | undefined)
          if (!worlds) continue
          const world = await worlds.ensure(b.nodeId)
          if (world) await world.ensureDir(b.remotePath)
        } catch {
          // 预热失败不应阻塞启动；运行时可再次 ensure
        }
      }
    })()
  })
}
