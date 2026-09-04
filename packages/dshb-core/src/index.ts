import type { Context } from '@deepseek-ai/cordis'
import { sharedWorldResolver } from 'dshb-router/resolve'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { sharedAuditLogger } from './audit.js'
import { KnownHostsStore } from './known-hosts.js'
import { NodeRegistry } from './node-registry.js'
import { registerNodeRoutes, registerSshConfigRoutes } from './routes.js'
import { registerWorkspaceRoutes } from './workspaces.js'
import { testNode, type DockerNodeTester, type SshHandshakeTester } from './test.js'
import { WorkspaceBindingsStore } from './workspace-bindings.js'

export const name = 'dshb-core'

export const inject = ['webServer', 'credentials']

export function apply(ctx: Context): void {
  const knownHosts = new KnownHostsStore()
  const registry = new NodeRegistry(ctx)
  const bindings = new WorkspaceBindingsStore()
  ctx.provide('nodeRegistry', registry)
  ctx.provide('knownHosts', knownHosts)
  ctx.provide('workspaceBindings', bindings)
  ctx.provide('dshbAudit', sharedAuditLogger())
  sharedWorldResolver().setBindings(bindings)
  void registerNodeRoutes(ctx, registry)
  void registerSshConfigRoutes(ctx, knownHosts)
  void registerWorkspaceRoutes(ctx, registry, bindings)
  warmupWorlds(ctx, registry, bindings)
  startHeartbeat(ctx, registry)
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

interface WarmupWorldsLike {
  ensure(nodeId: string): Promise<unknown>
}

function warmupWorlds(ctx: Context, registry: NodeRegistry, bindings: WorkspaceBindingsStore): void {
  setImmediate(() => {
    void (async () => {
      const seen = new Set<string>()
      for (const b of bindings.list()) {
        if (seen.has(b.nodeId)) continue
        const node = registry.get(b.nodeId)
        if (!node || node.type === 'local-host') continue
        seen.add(b.nodeId)
        try {
          const isDocker = node.type === 'local-docker' || node.type === 'remote-docker'
          const worlds = isDocker
            ? (ctx.get('dshbDockerWorldsGeneric') as WarmupWorldsLike | undefined)
            : (ctx.get('dshbWorlds') as WarmupWorldsLike | undefined)
          if (worlds) await worlds.ensure(b.nodeId)
        } catch {
          // 预热失败不应阻塞启动；运行时可再次 ensure
        }
      }
    })()
  })
}
