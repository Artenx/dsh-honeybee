import { describe, expect, it } from 'vitest'
import { resolveWorld, WorldResolver } from '../src/resolve.js'
import type { ExecutionWorldProvider, WorkspaceBindings } from '../src/types.js'

function mockProvider(nodeId: string): ExecutionWorldProvider {
  return {
    nodeId,
    fs: { resolve: async (p: string) => p, processPath: (t: string) => t, fileUrl: (t: string) => `file://${t}`, contains: () => false, stat: async () => undefined, lstat: async () => undefined, readText: async () => 'remote-content', streamText: async () => (async function* () { yield 'remote' })(), readBytes: async () => new Uint8Array(), listDir: async () => [], writeText: async () => ({ ok: true }), editText: async () => ({ ok: true }) } as never,
    subprocess: { spawn: () => ({}), spawnTerminal: async () => ({}) } as never,
    shell: { resolve: (r: unknown) => r, run: async () => ({}), start: () => ({}) } as never,
    ensureDir: async () => {},
    testConnection: async () => ({ ok: true, reachable: true }),
  }
}

function bindings(map: Record<string, { nodeId: string; remotePath: string }>): WorkspaceBindings {
  return {
    resolve: (p: string) => {
      let best: { nodeId: string; remotePath: string } | undefined
      let bestLen = 0
      for (const [root, hit] of Object.entries(map)) {
        if (p === root || p.startsWith(root + '/')) {
          if (root.length > bestLen) {
            const suffix = p === root ? '' : p.slice(root.length)
            best = { nodeId: hit.nodeId, remotePath: hit.remotePath + suffix }
            bestLen = root.length
          }
        }
      }
      return best
    },
  }
}

describe('本地 passthrough 属性（设计正确性属性 2/6）', () => {
  it('无绑定时全部返回 local', () => {
    for (const path of ['/tmp/a', '/home/user/proj', '/etc', '/any/deep/path/file.ts']) {
      expect(resolveWorld(path).kind).toBe('local')
    }
  })

  it('绑定存在但路径在镜像根外 → local', () => {
    const b = bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } })
    expect(resolveWorld('/other/path', b).kind).toBe('local')
    expect(resolveWorld('/mirror', b).kind).toBe('local')
    expect(resolveWorld('/mirror/proj-other', b).kind).toBe('local')
  })

  it('路径在镜像根内 → remote', () => {
    const b = bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } })
    expect(resolveWorld('/mirror/proj', b).kind).toBe('remote')
    expect(resolveWorld('/mirror/proj/src/a.ts', b).kind).toBe('remote')
  })

  it('WorldResolver 无世界时返回 unrouted（非 local）', () => {
    const r = new WorldResolver()
    r.setBindings(bindings({ '/mirror/p': { nodeId: 'n1', remotePath: '/remote/p' } }))
    const ref = r.resolve('/mirror/p')
    expect(ref.kind).toBe('unrouted')
    expect((ref as { nodeId: string }).nodeId).toBe('n1')
  })

  it('WorldResolver 有绑定时镜像根外仍 local', () => {
    const r = new WorldResolver()
    r.setBindings(bindings({ '/mirror/p': { nodeId: 'n1', remotePath: '/remote/p' } }))
    r.setRegistry({ get: () => mockProvider('n1') })
    expect(r.resolve('/unrelated/path').kind).toBe('local')
  })

  it('多绑定最长前缀匹配', () => {
    const b = bindings({
      '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' },
      '/mirror/proj/sub': { nodeId: 'n2', remotePath: '/remote/sub' },
    })
    const ref = resolveWorld('/mirror/proj/sub/deep.ts', b)
    expect(ref.kind).toBe('remote')
    expect((ref as { remotePath: string }).remotePath).toBe('/remote/sub/deep.ts')
  })

  it('模型视角路径翻译（设计正确性属性 3）', () => {
    const r = new WorldResolver()
    r.setBindings(bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } }))
    r.setRegistry({ get: () => mockProvider('n1') })
    const ref = r.resolve('/mirror/proj/src/a.ts')
    expect(ref.kind).toBe('remote')
    expect((ref as { remotePath: string }).remotePath).toBe('/remote/proj/src/a.ts')
  })

  it('Provider 返回远端路径（模型视角为远端真实路径）', async () => {
    const r = new WorldResolver()
    r.setBindings(bindings({ '/mirror/proj': { nodeId: 'n1', remotePath: '/remote/proj' } }))
    const provider = mockProvider('n1')
    r.setRegistry({ get: () => provider })
    const ref = r.resolve('/mirror/proj')
    expect(ref.kind).toBe('remote')
    const content = await (ref as { provider: ExecutionWorldProvider }).provider.fs.readText('/remote/proj/file.txt')
    expect(content).toBe('remote-content')
  })
})
