import type { Context } from '@deepseek-ai/cordis'
import { NodeRegistry } from './node-registry.js'
import { registerNodeRoutes } from './routes.js'

export const name = 'dshb-core'

export const inject = ['webServer', 'credentials']

export function apply(ctx: Context): void {
  const registry = new NodeRegistry(ctx)
  ctx.provide('nodeRegistry', registry)
  void registerNodeRoutes(ctx, registry)
}
