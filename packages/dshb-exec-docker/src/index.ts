import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DockerBackend } from './docker-backend.js'
import { DockerWorldRegistry } from './world.js'
import { RemoteDockerCli } from './remote-docker-cli.js'
import { DockerClient } from './docker-client.js'
import { registerDockerRoutes } from './docker-routes.js'
import { listContainers, provisionContainer } from './provision.js'

interface NodeRegistryLike {
  get(id: string): { id: string; type: string; ssh?: { host: string; port: number; username: string }; docker?: { containerId?: string; image?: string; mode?: 'existing' | 'managed'; resources?: { cpus?: number; memoryMB?: number } } } | undefined
}

interface SshExecutorLike {
  exec(argv: string[], cwd: string, env?: Record<string, string>, stdinData?: Buffer): Promise<{ code: number; stdout: string; stderr: string }>
}

export const name = 'dshb-exec-docker'

export const inject = ['nodeRegistry', 'webServer']

export function apply(ctx: Context): void {
  const worlds = new DockerWorldRegistry()
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
