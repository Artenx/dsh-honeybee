import type { Context } from '@deepseek-ai/cordis'
import { sharedWorldResolver } from 'dshb-router/resolve'
import { DockerWorldRegistry } from './world.js'

export const name = 'dshb-exec-docker'

export const inject = ['nodeRegistry']

export function apply(ctx: Context): void {
  const worlds = new DockerWorldRegistry()
  ctx.provide('dshbDockerWorlds', worlds)
  ctx.provide('dshbDockerWorldsGeneric', {
    ensure: async (nodeId: string) => {
      const nodeRegistry = ctx.get('nodeRegistry') as { get(id: string): { id: string; docker?: { containerId?: string } } | undefined } | undefined
      const node = nodeRegistry?.get(nodeId)
      if (!node?.docker?.containerId) return undefined
      return worlds.ensure(nodeId, node.docker.containerId)
    },
  })
}

export { DockerClient } from './docker-client.js'
export { DockerExecutionWorld, DockerWorldRegistry } from './world.js'
export { DockerFileSystem } from './fs-provider.js'
export { DockerShellExecutor, DockerSubprocessRuntime } from './process-provider.js'
