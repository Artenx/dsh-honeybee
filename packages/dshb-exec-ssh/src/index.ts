import type { Context } from '@deepseek-ai/cordis'
import { sharedWorldResolver } from 'dshb-router/resolve'
import { SshConnectionPool } from './connection-pool.js'
import { SshWorldRegistry } from './world.js'

export const name = 'dshb-exec-ssh'

export function apply(ctx: Context): void {
  const pool = new SshConnectionPool(ctx)
  const worlds = new SshWorldRegistry(pool)
  ctx.provide('dshbSshPool', pool)
  ctx.provide('dshbSshWorlds', worlds)
  sharedWorldResolver().setRegistry({
    get: (nodeId: string) => worlds.get(nodeId),
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
