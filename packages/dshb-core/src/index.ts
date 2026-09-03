import type { Context } from '@deepseek-ai/cordis'
import { KnownHostsStore } from './known-hosts.js'
import { NodeRegistry } from './node-registry.js'
import { registerNodeRoutes, registerSshConfigRoutes } from './routes.js'

export const name = 'dshb-core'

export const inject = ['webServer', 'credentials']

export function apply(ctx: Context): void {
  const knownHosts = new KnownHostsStore()
  const registry = new NodeRegistry(ctx)
  ctx.provide('nodeRegistry', registry)
  ctx.provide('knownHosts', knownHosts)
  void registerNodeRoutes(ctx, registry)
  void registerSshConfigRoutes(ctx, knownHosts)
}
