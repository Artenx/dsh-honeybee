import type { Context } from '@deepseek-ai/cordis'
import { sharedWorldResolver } from '../router/resolve.js'
import type {} from '@deepseek-ai/dsh-host-webserver'
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
import { SyncOfflineArchiveService } from './sync/offline-archive.js'
import { registerSyncOfflineRoutes } from './sync/offline-routes.js'
import { SyncPeerStore, SyncStateStore } from './sync/stores.js'
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
  registerSyncPeerRoutes(ctx, syncPeerManager, syncSshTransport, syncCoordinator)
  registerSyncInternalRoutes(ctx, syncState, syncNodes, syncSessions)
  registerSyncSessionRoutes(ctx, syncSessions)
  registerSyncOfflineRoutes(ctx, syncOfflineArchives)
  ctx.effect(() => {
    const stopScheduler = syncScheduler.start()
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
