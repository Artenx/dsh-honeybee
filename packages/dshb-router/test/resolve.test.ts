import { describe, expect, it } from 'vitest'
import { resolveWorld, WorldResolver } from 'dshb-router/resolve'
import type { ExecutionWorldProvider, WorkspaceBindings, WorldRegistry } from 'dshb-router/types'

function mockProvider(nodeId: string, remotePath = '/remote'): ExecutionWorldProvider {
  return {
    nodeId,
    fs: {
      resolve: async (p: string) => p,
      processPath: (t: string) => t,
      fileUrl: (t: string) => `file://${t}`,
      contains: (p: string, c: string) => c === p || c.startsWith(`${p}/`),
      stat: async () => undefined,
      lstat: async () => undefined,
      readText: async () => '',
      streamText: async () => (async function* () {})(),
      readBytes: async () => new Uint8Array(),
      listDir: async () => [],
      writeText: async () => ({ ok: true }),
      editText: async () => ({ ok: true }),
    } as never,
    subprocess: { spawn: () => ({}), spawnTerminal: async () => ({}) } as never,
    shell: { resolve: (r: unknown) => r, run: async () => ({}), start: () => ({}) } as never,
    ensureDir: async () => {},
    testConnection: async () => ({ ok: true, reachable: true }),
  }
}

function bindings(map: Record<string, { nodeId: string; remotePath: string }>): WorkspaceBindings {
  return {
    resolve: (mirrorPath: string) => map[mirrorPath],
  }
}

describe('resolveWorld 纯函数', () => {
  it('无绑定时返回 local', () => {
    const ref = resolveWorld('/any/path')
    expect(ref.kind).toBe('local')
  })

  it('镜像路径命中绑定返回 remote', () => {
    const ref = resolveWorld('/mirror/proj', bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } }))
    expect(ref.kind).toBe('remote')
    expect((ref as { remotePath: string }).remotePath).toBe('/remote/proj')
  })

  it('镜像路径外返回 local', () => {
    const ref = resolveWorld('/other/path', bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } }))
    expect(ref.kind).toBe('local')
  })
})

describe('WorldResolver', () => {
  it('绑定存在但无世界时返回 unrouted', () => {
    const r = new WorldResolver()
    r.setBindings(bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } }))
    const ref = r.resolve('/mirror/proj')
    expect(ref.kind).toBe('unrouted')
  })

  it('绑定与世界都存在时返回 remote', () => {
    const r = new WorldResolver()
    r.setBindings(bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } }))
    const registry: WorldRegistry = { get: (id: string) => (id === 'n1' ? mockProvider('n1') : undefined) }
    r.setRegistry(registry)
    const ref = r.resolve('/mirror/proj')
    expect(ref.kind).toBe('remote')
    expect((ref as { provider: ExecutionWorldProvider }).provider.nodeId).toBe('n1')
  })

  it('绑定存在但节点无世界时返回 unrouted', () => {
    const r = new WorldResolver()
    r.setBindings(bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } }))
    const registry: WorldRegistry = { get: () => undefined }
    r.setRegistry(registry)
    const ref = r.resolve('/mirror/proj')
    expect(ref.kind).toBe('unrouted')
  })

  it('绑定与世界都存在时 remote provider 含三件套', () => {
    const r = new WorldResolver()
    r.setBindings(bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } }))
    const registry: WorldRegistry = { get: (id: string) => (id === 'n1' ? mockProvider('n1') : undefined) }
    r.setRegistry(registry)
    const ref = r.resolve('/mirror/proj')
    expect(ref.kind).toBe('remote')
    const provider = (ref as { provider: ExecutionWorldProvider }).provider
    expect(provider.fs).toBeDefined()
    expect(provider.subprocess).toBeDefined()
    expect(provider.shell).toBeDefined()
  })
})
