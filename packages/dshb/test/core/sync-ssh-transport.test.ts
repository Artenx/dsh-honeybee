import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { SyncSessionDeltaPrefixError, SyncSshSession, SyncSshTransport, buildRemoteProbeScript, parseRemoteProbeOutput } from '../../src/core/sync/ssh-transport.js'
import { SyncFrameDecoder, encodeSyncControlFrame, encodeSyncDataFrame } from '../../src/core/sync/protocol.js'
import type { SyncPeer } from '../../src/core/sync/model.js'

const peer: SyncPeer = {
  id: 'p-0123456789abcdef01234567',
  name: 'Remote peer',
  host: 'sync.example.com',
  port: 22,
  username: 'sync',
  authKind: 'password',
  direction: 'pull',
  schedule: 'manual',
  syncSessions: false,
  enabled: true,
  remoteWebPort: 3090,
}

function createSession(inbound: Buffer[]): { session: SyncSshSession; writes: Buffer[]; closed: () => boolean } {
  const writes: Buffer[] = []
  const channel = Object.assign(new EventEmitter(), {
    stdout: Readable.from(inbound),
    write(frame: Buffer) { writes.push(Buffer.from(frame)); return true },
    end() {},
    destroy() {},
  })
  let clientClosed = false
  const session = new SyncSshSession({ end() { clientClosed = true } } as never, channel as never)
  return { session, writes, closed: () => clientClosed }
}

class TestTransport extends SyncSshTransport {
  constructor(private readonly session: SyncSshSession) {
    super({} as never)
  }

  override async openSession(): Promise<{ peer: SyncPeer; session: SyncSshSession }> {
    return { peer, session: this.session }
  }
}

function decodeWrites(writes: Buffer[]) {
  const decoder = new SyncFrameDecoder()
  const frames = writes.flatMap((frame) => decoder.push(frame))
  decoder.finish()
  return frames
}

describe('SSH framed node transport', () => {
  it('receives a chunked node manifest from the remote helper protocol', async () => {
    const manifest = {
      protocolVersion: 1,
      instanceId: 'i-remote',
      records: [{ metadata: { kind: 'node', originInstanceId: 'i-remote', originEntityId: 'n1' } }],
    }
    const capabilities = ['node-sync', 'session-manifest-v1', 'session-event-tail-delta-v1']
    const json = Buffer.from(JSON.stringify({ ok: true, manifest, capabilities }))
    const middle = Math.floor(json.length / 2)
    const frames = [
      encodeSyncControlFrame({ kind: 'response', status: 200, bodyMode: 'data' }),
      encodeSyncDataFrame(0, json.subarray(0, middle)),
      encodeSyncDataFrame(1, json.subarray(middle)),
      encodeSyncControlFrame({ kind: 'response-end' }),
    ]
    const { session, writes, closed } = createSession(frames)
    const transport = new TestTransport(session)

    const result = await transport.fetchNodeManifest(peer.id)

    expect(result).toEqual({ ...manifest, capabilities })
    expect(closed()).toBe(true)
    expect(decodeWrites(writes)).toEqual([{
      kind: 'control',
      value: { kind: 'request', protocolVersion: 1, operation: 'node-manifest', port: 3090 },
    }])
  })

  it('sends node apply data in ordered, digest-checked chunks', async () => {
    const result = { created: 1, updated: 2, deleted: 0, pendingRemoval: 0, skipped: 3 }
    const { session, writes, closed } = createSession([
      encodeSyncControlFrame({ kind: 'response', status: 200, body: { ok: true, result } }),
    ])
    const transport = new TestTransport(session)

    await expect(transport.applyNodeManifest(peer.id, [], 'Source instance')).resolves.toEqual(result)

    const frames = decodeWrites(writes)
    expect(frames[0]).toEqual({
      kind: 'control',
      value: { kind: 'request', protocolVersion: 1, operation: 'node-apply', port: 3090 },
    })
    expect(frames[1]).toMatchObject({ kind: 'data', sequence: 0 })
    expect(frames[2]).toEqual({ kind: 'control', value: { kind: 'request-end' } })
    expect(closed()).toBe(true)
  })

  it('receives a chunked session bundle from the remote helper protocol', async () => {
    const bundle = { protocolVersion: 1, instanceId: 'i-remote', entries: [], skipped: [], digest: 'sha256:test' }
    const json = Buffer.from(JSON.stringify({ ok: true, bundle }))
    const { session, writes, closed } = createSession([
      encodeSyncControlFrame({ kind: 'response', status: 200, bodyMode: 'data' }),
      encodeSyncDataFrame(0, json),
      encodeSyncControlFrame({ kind: 'response-end' }),
    ])
    const transport = new TestTransport(session)

    await expect(transport.fetchSessionBundle(peer.id)).resolves.toEqual(bundle)
    expect(decodeWrites(writes)).toEqual([{
      kind: 'control',
      value: { kind: 'request', protocolVersion: 1, operation: 'session-bundle', port: 3090 },
    }])
    expect(closed()).toBe(true)
  })

  it('receives a session manifest from the remote helper protocol', async () => {
    const manifest = { protocolVersion: 1, instanceId: 'i-remote', entries: [], skipped: [], digest: 'sha256:manifest' }
    const json = Buffer.from(JSON.stringify({ ok: true, manifest }))
    const { session, writes } = createSession([
      encodeSyncControlFrame({ kind: 'response', status: 200, bodyMode: 'data' }),
      encodeSyncDataFrame(0, json),
      encodeSyncControlFrame({ kind: 'response-end' }),
    ])
    const transport = new TestTransport(session)

    await expect(transport.fetchSessionManifest(peer.id)).resolves.toEqual(manifest)
    expect(decodeWrites(writes)).toEqual([{
      kind: 'control',
      value: { kind: 'request', protocolVersion: 1, operation: 'session-manifest', port: 3090 },
    }])
  })

  it('posts a selected session entry key to the remote helper protocol', async () => {
    const bundle = { protocolVersion: 1, instanceId: 'i-remote', entries: [], skipped: [], digest: 'sha256:empty' }
    const json = Buffer.from(JSON.stringify({ ok: true, bundle }))
    const { session, writes } = createSession([
      encodeSyncControlFrame({ kind: 'response', status: 200, bodyMode: 'data' }),
      encodeSyncDataFrame(0, json),
      encodeSyncControlFrame({ kind: 'response-end' }),
    ])
    const transport = new TestTransport(session)

    await expect(transport.fetchSessionEntries(peer.id, ['entry-key'], 'sha256:manifest')).resolves.toEqual(bundle)

    const frames = decodeWrites(writes)
    expect(frames[0]).toEqual({
      kind: 'control',
      value: { kind: 'request', protocolVersion: 1, operation: 'session-entries', port: 3090 },
    })
    expect(frames[1]?.kind).toBe('data')
    const body = Buffer.concat(frames.filter((frame) => frame.kind === 'data').map((frame) => frame.kind === 'data' ? frame.data : Buffer.alloc(0)))
    expect(JSON.parse(body.toString('utf8'))).toEqual({
      keys: ['entry-key'],
      manifestDigest: 'sha256:manifest',
      prefixes: [],
      deferredObjects: false,
    })
    expect(frames.at(-1)).toEqual({ kind: 'control', value: { kind: 'request-end' } })
  })

  it('sends a session apply bundle and validates all durable counts', async () => {
    const result = { created: 1, updated: 2, archived: 3, deleted: 4, skipped: 5, unmapped: 6 }
    const { session, writes, closed } = createSession([
      encodeSyncControlFrame({ kind: 'response', status: 200, body: { ok: true, result } }),
    ])
    const transport = new TestTransport(session)
    const bundle = { protocolVersion: 1, instanceId: 'i-source', entries: [], skipped: [], digest: 'sha256:test' }

    await expect(transport.applySessionBundle(peer.id, bundle, 'source')).resolves.toEqual(result)

    const frames = decodeWrites(writes)
    expect(frames[0]).toEqual({
      kind: 'control',
      value: { kind: 'request', protocolVersion: 1, operation: 'session-apply', port: 3090 },
    })
    expect(frames[1]?.kind).toBe('data')
    const body = Buffer.concat(frames.filter((frame) => frame.kind === 'data').map((frame) => frame.kind === 'data' ? frame.data : Buffer.alloc(0)))
    expect(JSON.parse(body.toString('utf8'))).toEqual({ bundle, sourceName: 'source', peerId: peer.id })
    expect(frames.at(-1)).toEqual({ kind: 'control', value: { kind: 'request-end' } })
    expect(closed()).toBe(true)
  })

  it('surfaces a stale delta prefix response for full-bundle fallback', async () => {
    const { session } = createSession([
      encodeSyncControlFrame({
        kind: 'response',
        status: 409,
        body: { ok: false, code: 'session-delta-prefix', error: 'prefix changed' },
      }),
    ])
    const transport = new TestTransport(session)
    const bundle = { protocolVersion: 1, instanceId: 'i-source', entries: [], skipped: [], digest: 'sha256:test' }

    await expect(transport.applySessionBundle(peer.id, bundle, 'source')).rejects.toBeInstanceOf(SyncSessionDeltaPrefixError)
  })
})

describe('远端配置探测', () => {
  it('发现脚本包含候选目录、profile 扫描与握手探测', () => {
    const script = buildRemoteProbeScript('/custom/.dsh')
    expect(script).toContain('DSHB_PROBE_BEGIN')
    expect(script).toContain('DSHB_PROBE_END')
    expect(script).toContain('"/custom/.dsh"')
    expect(script).toContain('$HOME/.dsh')
    expect(script).toContain('Application Support/dsh')
    expect(script).toContain('node_modules/@artenx/dshb')
    expect(script).toContain('/api/dshb/sync/internal/handshake')
  })

  it('探测循环必须回填并发窗口（否则超出首批 4 个的候选永不探测）', () => {
    // 0.1.51 及之前的实机 bug：done() 只递减计数，13080 排第 9 位从未被探测。
    const script = buildRemoteProbeScript()
    expect(script).toContain('function done(){active--;if(i>=list.length&&active===0)process.exit(0);probe()}')
    // timeout 触发 destroy 后 error 事件会重复回调，须防重入
    expect(script).toContain('function finish(){if(settled)return;settled=true;done()}')
  })

  it('发现脚本扫描宿主监听端口与 docker 映射端口（193 场景 13080 可被发现）', () => {
    const script = buildRemoteProbeScript(undefined, 13080)
    // docker 端口映射：docker-proxy 参数是 -host-port，而非 --port
    expect(script).toContain('-host-port')
    // Linux 宿主全量 TCP 监听端口兜底（macOS 无 /proc 时静默跳过）
    expect(script).toContain('/proc/net/tcp')
    // 已保存的对端端口优先探测
    expect(script).toContain(' 13080 ')
  })

  it('解析探测输出：home/profile/握手端口与指纹', () => {
    const output = [
      'DSHB_PROBE_BEGIN',
      'home /home/mt/.dsh',
      'home /home/mt/.dsh',
      'profile web yes /home/mt/.dsh',
      'profile scratch no /home/mt/.dsh',
      'dsh --profile web --port 3206',
      'handshake 3206 i-abc',
      'DSHB_PROBE_END',
    ].join('\n')
    const result = parseRemoteProbeOutput(output, 'SHA256:fp')
    expect(result.homes).toEqual(['/home/mt/.dsh'])
    expect(result.profiles).toEqual([
      { name: 'web', dshbInstalled: true, home: '/home/mt/.dsh' },
      { name: 'scratch', dshbInstalled: false, home: '/home/mt/.dsh' },
    ])
    expect(result.handshakes).toEqual([{ port: 3206, instanceId: 'i-abc' }])
    expect(result.webPort).toBe(3206)
    expect(result.instanceId).toBe('i-abc')
    expect(result.processHints).toEqual(['dsh --profile web --port 3206'])
    expect(result.hostKeyFingerprint).toBe('SHA256:fp')
  })

  it('缺少结束标记时拒绝输出', () => {
    expect(() => parseRemoteProbeOutput('DSHB_PROBE_BEGIN\nhome /x', 'fp')).toThrow()
  })

  it('多实例命中时优先回填已配置端口', () => {
    const output = [
      'DSHB_PROBE_BEGIN',
      'handshake 3204 i-first',
      'handshake 3207 i-second',
      'DSHB_PROBE_END',
    ].join('\n')
    const preferred = parseRemoteProbeOutput(output, 'fp', 3207)
    expect(preferred.webPort).toBe(3207)
    expect(preferred.instanceId).toBe('i-second')
    expect(preferred.handshakes.map((hit) => hit.port)).toEqual([3204, 3207])
  })
})
