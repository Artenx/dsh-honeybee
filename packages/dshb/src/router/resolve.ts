import type { WorldRegistry, WorkspaceBindings, WorldRef } from './types.js'

export interface BindingHit {
  nodeId: string
  remotePath: string
}

export function resolveWorld(absPath: string, bindings?: WorkspaceBindings): { kind: 'local' } | ({ kind: 'remote' } & BindingHit) {
  if (!bindings) return { kind: 'local' }
  const hit = bindings.resolve(absPath)
  if (!hit) return { kind: 'local' }
  return { kind: 'remote', ...hit }
}

export class WorldResolver {
  private bindings?: WorkspaceBindings
  private registries: WorldRegistry[] = []

  setBindings(bindings: WorkspaceBindings): void {
    this.bindings = bindings
  }

  setRegistry(registry: WorldRegistry): void {
    this.registries.push(registry)
  }

  resolve(absPath: string): WorldRef {
    const r = resolveWorld(absPath, this.bindings)
    if (r.kind === 'local') return { kind: 'local' }
    for (const reg of this.registries) {
      const provider = reg.get(r.nodeId)
      if (provider) return { kind: 'remote', provider, remotePath: r.remotePath }
    }
    return { kind: 'unrouted', nodeId: r.nodeId }
  }
}

let shared: WorldResolver | null = null

export function sharedWorldResolver(): WorldResolver {
  if (!shared) shared = new WorldResolver()
  return shared
}
