import type { Context } from '@deepseek-ai/cordis'
import { sharedWorldResolver } from './resolve.js'

export const name = 'dshb-router'

export function apply(ctx: Context): void {
  ctx.provide('dshbRouter', sharedWorldResolver())
}

export { sharedWorldResolver } from './resolve.js'
export type { ExecutionWorldProvider, WorkspaceBindings, WorldRegistry, WorldRef, NodeTestReport } from './types.js'
