import type { Context } from '@deepseek-ai/cordis'
import { SshConnectionPool } from './connection-pool.js'

export const name = 'dshb-exec-ssh'

export function apply(ctx: Context): void {
  const pool = new SshConnectionPool(ctx)
  ctx.provide('dshbSshPool', pool)
}

export { SshConnectionPool } from './connection-pool.js'
export { classifySshError, toConnectionError } from './connection.js'
export type { SshConnectionError, SshErrorCategory, SshTarget, SshSecrets } from './connection.js'
export { shouldScrubVar, scrubEnv } from './env-scrub.js'
