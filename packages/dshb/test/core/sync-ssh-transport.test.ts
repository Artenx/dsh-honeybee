import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { SyncSshSession, SyncSshTransport } from '../../src/core/sync/ssh-transport.js'
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
    const json = Buffer.from(JSON.stringify({ ok: true, manifest }))
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

    expect(result).toEqual(manifest)
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
})
