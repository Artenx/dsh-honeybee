import type { Context } from '@deepseek-ai/cordis'
import { decorateFileSystem } from './decorate-fs.js'
import { decorateSubprocess } from './decorate-subprocess.js'
import { decorateShell } from './decorate-shell.js'
import { sharedWorldResolver } from './resolve.js'

export const name = 'dshb-router'

export const inject = ['fs', 'subprocess', 'shell']

export function apply(ctx: Context): void {
  ctx.provide('dshbRouter', sharedWorldResolver())
  decorateFileSystem(ctx.fs)
  decorateSubprocess(ctx.subprocess)
  decorateShell(ctx.shell)
}

export { sharedWorldResolver } from './resolve.js'
export type { ExecutionWorldProvider, WorkspaceBindings, WorldRegistry, WorldRef, NodeTestReport } from './types.js'
