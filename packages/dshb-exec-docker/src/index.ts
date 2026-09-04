import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DockerBackend } from './docker-backend.js'
import { DockerWorldRegistry } from './world.js'
import { RemoteDockerCli } from './remote-docker-cli.js'
import { DockerClient } from './docker-client.js'
import { registerDockerRoutes } from './docker-routes.js'
import { listContainers, provisionContainer } from './provision.js'
import { resolveHostRunner, type DockerNodeLike } from './host-runner.js'

interface NodeRegistryLike {
  get(id: string): { id: string; type: string; ssh?: { host: string; port: number; username: string }; docker?: { containerId?: string; image?: string; mode?: 'existing' | 'managed'; resources?: { cpus?: number; memoryMB?: number } } } | undefined
}

interface SshExecutorLike {
  exec(argv: string[], cwd: string, env?: Record<string, string>, stdinData?: Buffer): Promise<{ code: number; stdout: string; stderr: string }>
}

export const name = 'dshb-exec-docker'

export const inject = ['nodeRegistry', 'webServer']

export interface ProvisionStatus {
  state: 'provisioning' | 'ready' | 'failed'
  error?: string
  containerId?: string
  updatedAt: string
}

export function apply(ctx: Context): void {
  const worlds = new DockerWorldRegistry()
  const provisionStatuses = new Map<string, ProvisionStatus>()
  ctx.provide('dshbDockerWorlds', worlds)
  ctx.provide('dshbDockerWorldsGeneric', {
    ensure: async (nodeId: string) => {
      const nodeRegistry = ctx.get('nodeRegistry') as NodeRegistryLike | undefined
      const node = nodeRegistry?.get(nodeId)
      if (!node) return undefined
      if (node.type === 'local-docker' && node.docker?.containerId) {
        return worlds.ensure(nodeId, new DockerClient(node.docker.containerId))
      }
      if (node.type === 'remote-docker' && node.docker?.containerId && node.ssh) {
        const sshPool = ctx.get('dshbSshPool') as { acquire(target: unknown, secrets: unknown): { getClient(): Promise<unknown> } } | undefined
        if (!sshPool) return undefined
        const sshWorlds = ctx.get('dshbSshWorlds') as { ensure(nodeId: string): Promise<{ executor: SshExecutorLike } | undefined> } | undefined
        if (!sshWorlds) return undefined
        const sshWorld = await sshWorlds.ensure(nodeId)
        if (!sshWorld) return undefined
        return worlds.ensure(nodeId, new RemoteDockerCli(sshWorld.executor, node.docker.containerId))
      }
      return undefined
    },
  })
  ctx.provide('dshbDockerProvisioner', {
    provision: async (nodeId: string) => {
      const nodeRegistry = ctx.get('nodeRegistry') as NodeRegistryLike | undefined
      const node = nodeRegistry?.get(nodeId)
      if (!node) throw new Error(`node ${nodeId} not found`)
      if (node.type !== 'local-docker' && node.type !== 'remote-docker') throw new Error('节点不是 Docker 类型')
      const image = node.docker?.image
      if (!image) throw new Error('节点未配置镜像')
      const runner = await resolveHostRunner(ctx, node)
      if (!runner) throw new Error('节点执行通道未就绪')
      const name = `dshb-${nodeId}`
      provisionStatuses.set(nodeId, { state: 'provisioning', updatedAt: new Date().toISOString() })
      try {
        const result = await provisionContainer(runner, {
          image,
          cpus: node.docker?.resources?.cpus,
          memoryMB: node.docker?.resources?.memoryMB,
          name,
        })
        const registry = ctx.get('nodeRegistry') as { update(id: string, input: { docker: Record<string, unknown> }): Promise<unknown> } | undefined
        await registry?.update(nodeId, { docker: { ...node.docker, containerId: result.containerId, mode: 'managed' } })
        provisionStatuses.set(nodeId, { state: 'ready', containerId: result.containerId, updatedAt: new Date().toISOString() })
        return result
      } catch (err) {
        provisionStatuses.set(nodeId, { state: 'failed', error: err instanceof Error ? err.message : String(err), updatedAt: new Date().toISOString() })
        throw err
      }
    },
    status: (nodeId: string) => provisionStatuses.get(nodeId),
  })
  ctx.provide('dshbDockerTester', {
    test: async (node: DockerNodeLike) => {
      try {
        const runner = await resolveHostRunner(ctx, node)
        if (!runner) return { ok: false, reachable: false, error: '执行通道未就绪', category: 'network' }
        const info = await runner.run(['docker', 'info', '--format', '{{.ServerVersion}}'])
        if (info.code !== 0) return { ok: false, reachable: false, error: `Docker 守护进程不可用: ${(info.stderr || info.stdout).trim()}`, category: 'unknown' }
        const containerId = node.docker?.containerId
        if (containerId) {
          const inspect = await runner.run(['docker', 'inspect', '--format', '{{.State.Running}}', containerId])
          if (inspect.code !== 0) return { ok: false, reachable: false, error: '容器不存在或已删除' }
          if (inspect.stdout.trim() !== 'true') return { ok: false, reachable: false, error: '容器已停止' }
        }
        return { ok: true, reachable: true }
      } catch (err) {
        return { ok: false, reachable: false, error: err instanceof Error ? err.message : String(err), category: 'unknown' }
      }
    },
  })
  registerDockerRoutes(ctx)
}

export { DockerClient } from './docker-client.js'
export { RemoteDockerCli } from './remote-docker-cli.js'
export { DockerExecutionWorld, DockerWorldRegistry } from './world.js'
export { DockerFileSystem } from './fs-provider.js'
export { DockerShellExecutor, DockerSubprocessRuntime } from './process-provider.js'
export { provisionContainer, listContainers, removeContainer } from './provision.js'
export type { ProvisionConfig, ProvisionResult, ProvisionStage } from './provision.js'
export type { DockerBackend, HostCommandRunner } from './docker-backend.js'
