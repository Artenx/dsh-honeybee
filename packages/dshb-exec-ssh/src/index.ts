import type { Context } from '@deepseek-ai/cordis'
import { sharedWorldResolver } from 'dshb-router/resolve'
import { SshConnectionPool } from './connection-pool.js'
import { SshWorldRegistry } from './world.js'

export const name = 'dshb-exec-ssh'

export const inject = ['nodeRegistry']

export function apply(ctx: Context): void {
  const pool = new SshConnectionPool(ctx)
  const nodeRegistry = ctx.get('nodeRegistry') as ConstructorParameters<typeof SshWorldRegistry>[1]
  const audit = ctx.get('dshbAudit') as { log(nodeId: string, op: string, target: string, result: string): void } | undefined
  const worlds = new SshWorldRegistry(pool, nodeRegistry, audit ? (id, op, t, r) => audit.log(id, op, t, r) : undefined)
  ctx.provide('dshbSshPool', pool)
  ctx.provide('dshbSshWorlds', worlds)
  ctx.provide('dshbWorlds', {
    ensure: (nodeId: string) => worlds.ensure(nodeId),
  })
  sharedWorldResolver().setRegistry({
    get: (nodeId: string) => {
      const node = nodeRegistry?.get(nodeId)
      if (node && (node.type === 'remote-docker' || node.type === 'local-docker')) return undefined
      return worlds.get(nodeId)
    },
  })
}

export { SshConnectionPool } from './connection-pool.js'
export { classifySshError, toConnectionError } from './connection.js'
export type { SshConnectionError, SshErrorCategory, SshTarget, SshSecrets } from './connection.js'
export { shouldScrubVar, scrubEnv } from './env-scrub.js'
export { SshExecutor } from './executor.js'
export { SshFileSystem } from './fs-provider.js'
export { SshShellExecutor, SshSubprocessRuntime } from './process-provider.js'
export { SshExecutionWorld, SshWorldRegistry } from './world.js'
export type { SshNodeConfig } from './world.js'
export { encodeRunnerPayload, REMOTE_RUNNER_COMMAND, REMOTE_RUNNER_SCRIPT } from './runner.js'
