import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { REMOTE_SYNC_HELPER_COMMAND } from '../../src/core/sync/remote-helper.js'
import { SyncFrameDecoder, encodeSyncControlFrame, encodeSyncDataFrame } from '../../src/core/sync/protocol.js'

function helperSource(): string {
  const match = /^node -e 'eval\(Buffer\.from\("([A-Za-z0-9+/=]+)","base64"\)\.toString\("utf8"\)\)'$/.exec(REMOTE_SYNC_HELPER_COMMAND)
  expect(match).not.toBeNull()
  return Buffer.from(match![1], 'base64').toString('utf8')
}

async function runHelper(source: string, input: Buffer): Promise<{ code: number | null; output: Buffer }> {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'ignore'] })
  const chunks: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
  const closed = once(child, 'close')
  child.stdin.end(input)
  const [code] = await closed
  return { code: code as number | null, output: Buffer.concat(chunks) }
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

describe('fixed remote sync helper', () => {
  it('keeps the command literal and restricts requests to the loopback handshake route', () => {
    const source = helperSource()

    expect(source).toContain("!Object.prototype.hasOwnProperty.call(PATHS, request.operation)")
    expect(source).toContain("'http://127.0.0.1:'")
    expect(source).toContain("'/api/dshb/sync/internal/handshake'")
    expect(source).toContain("'/api/dshb/sync/internal/nodes/manifest'")
    expect(source).toContain("'/api/dshb/sync/internal/nodes/apply'")
    expect(source).toContain("'/api/dshb/sync/internal/sessions/bundle'")
    expect(source).toContain("'/api/dshb/sync/internal/sessions/manifest'")
    expect(source).toContain("'/api/dshb/sync/internal/sessions/entries'")
    expect(source).toContain("'/api/dshb/sync/internal/sessions/apply'")
    expect(REMOTE_SYNC_HELPER_COMMAND).not.toContain('remoteWebPort')
  })

  it('forwards the handshake over loopback and returns a framed response', async () => {
    const source = helperSource()
    const server = createServer((request, response) => {
      expect(request.url).toBe('/api/dshb/sync/internal/handshake')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, protocolVersion: 1, instanceId: 'i-remote', capabilities: ['peer-handshake'] }))
    })
    const port = await listen(server)

    try {
      const { code, output } = await runHelper(source, encodeSyncControlFrame({ kind: 'request', protocolVersion: 1, operation: 'handshake', port }))
      expect(code).toBe(0)
      const decoder = new SyncFrameDecoder()
      const frames = decoder.push(output)
      decoder.finish()
      expect(frames).toEqual([{
        kind: 'control',
        value: {
          kind: 'response',
          status: 200,
          body: { ok: true, protocolVersion: 1, instanceId: 'i-remote', capabilities: ['peer-handshake'] },
        },
      }])
    } finally {
      await close(server)
    }
  })

  it('streams a large node manifest back as bounded data frames', async () => {
    const source = helperSource()
    const body = JSON.stringify({ ok: true, manifest: { records: [{ value: 'x'.repeat(2 * 1024 * 1024) }] } })
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
    })
    const port = await listen(server)

    try {
      const { code, output } = await runHelper(source, encodeSyncControlFrame({
        kind: 'request',
        protocolVersion: 1,
        operation: 'node-manifest',
        port,
      }))
      const decoder = new SyncFrameDecoder()
      const frames = decoder.push(output)
      decoder.finish()
      expect(code).toBe(0)
      expect(frames[0]).toMatchObject({ kind: 'control', value: { kind: 'response', status: 200, bodyMode: 'data' } })
      const dataFrames = frames.filter((frame) => frame.kind === 'data')
      expect(dataFrames.length).toBeGreaterThan(1)
      expect(dataFrames.map((frame) => frame.kind === 'data' ? frame.sequence : -1)).toEqual(dataFrames.map((_, index) => index))
      expect(Buffer.concat(dataFrames.map((frame) => frame.kind === 'data' ? frame.data : Buffer.alloc(0))).toString('utf8')).toBe(body)
      expect(frames.at(-1)).toEqual({ kind: 'control', value: { kind: 'response-end' } })
    } finally {
      await close(server)
    }
  })

  it('streams a session manifest from its fixed loopback endpoint', async () => {
    const source = helperSource()
    const body = JSON.stringify({ ok: true, manifest: { protocolVersion: 1, instanceId: 'i-remote', entries: [], skipped: [], digest: 'sha256:empty' } })
    const server = createServer((request, response) => {
      expect(request.url).toBe('/api/dshb/sync/internal/sessions/manifest')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
    })
    const port = await listen(server)

    try {
      const { code, output } = await runHelper(source, encodeSyncControlFrame({
        kind: 'request',
        protocolVersion: 1,
        operation: 'session-manifest',
        port,
      }))
      const decoder = new SyncFrameDecoder()
      const frames = decoder.push(output)
      decoder.finish()
      expect(code).toBe(0)
      expect(frames[0]).toMatchObject({ kind: 'control', value: { kind: 'response', status: 200, bodyMode: 'data' } })
      expect(Buffer.concat(frames.filter((frame) => frame.kind === 'data').map((frame) => frame.kind === 'data' ? frame.data : Buffer.alloc(0))).toString('utf8')).toBe(body)
      expect(frames.at(-1)).toEqual({ kind: 'control', value: { kind: 'response-end' } })
    } finally {
      await close(server)
    }
  })

  it('forwards node apply data through a fixed loopback endpoint', async () => {
    const source = helperSource()
    let receivedBody = ''
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, result: { created: 1 } }))
      })
    })
    const port = await listen(server)
    const requestBody = Buffer.from(JSON.stringify({ records: [{ id: 'node-1' }], sourceName: 'Peer A' }))
    const input = Buffer.concat([
      encodeSyncControlFrame({ kind: 'request', protocolVersion: 1, operation: 'node-apply', port }),
      encodeSyncDataFrame(0, requestBody),
      encodeSyncControlFrame({ kind: 'request-end' }),
    ])

    try {
      const { code, output } = await runHelper(source, input)
      const decoder = new SyncFrameDecoder()
      const frames = decoder.push(output)
      decoder.finish()
      expect(code).toBe(0)
      expect(receivedBody).toBe(requestBody.toString('utf8'))
      expect(frames).toEqual([{ kind: 'control', value: { kind: 'response', status: 200, body: { ok: true, result: { created: 1 } } } }])
    } finally {
      await close(server)
    }
  })

  it('forwards session apply data through its fixed loopback endpoint', async () => {
    const source = helperSource()
    let receivedBody = ''
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, result: { created: 1, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 } }))
      })
    })
    const port = await listen(server)
    const requestBody = Buffer.from(JSON.stringify({ bundle: { digest: 'sha256:test' }, sourceName: 'Peer A', peerId: 'p-0123456789abcdef01234567' }))
    const input = Buffer.concat([
      encodeSyncControlFrame({ kind: 'request', protocolVersion: 1, operation: 'session-apply', port }),
      encodeSyncDataFrame(0, requestBody),
      encodeSyncControlFrame({ kind: 'request-end' }),
    ])

    try {
      const { code, output } = await runHelper(source, input)
      const decoder = new SyncFrameDecoder()
      const frames = decoder.push(output)
      decoder.finish()
      expect(code).toBe(0)
      expect(receivedBody).toBe(requestBody.toString('utf8'))
      expect(frames).toEqual([{
        kind: 'control',
        value: {
          kind: 'response',
          status: 200,
          body: { ok: true, result: { created: 1, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 } },
        },
      }])
    } finally {
      await close(server)
    }
  })

  it('keeps a delta-prefix conflict recoverable over the SSH helper channel', async () => {
    const source = helperSource()
    const server = createServer((_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, code: 'session-delta-prefix', error: 'prefix changed' }))
    })
    const port = await listen(server)
    const requestBody = Buffer.from(JSON.stringify({ bundle: {}, sourceName: 'Peer A', peerId: 'p-0123456789abcdef01234567' }))
    const input = Buffer.concat([
      encodeSyncControlFrame({ kind: 'request', protocolVersion: 1, operation: 'session-apply', port }),
      encodeSyncDataFrame(0, requestBody),
      encodeSyncControlFrame({ kind: 'request-end' }),
    ])

    try {
      const { code, output } = await runHelper(source, input)
      const decoder = new SyncFrameDecoder()
      const frames = decoder.push(output)
      decoder.finish()
      expect(code).toBe(0)
      expect(frames).toEqual([{
        kind: 'control',
        value: {
          kind: 'response',
          status: 409,
          body: { ok: false, code: 'session-delta-prefix', error: 'prefix changed' },
        },
      }])
    } finally {
      await close(server)
    }
  })

  it('posts selected session keys and streams the matching entries bundle', async () => {
    const source = helperSource()
    let receivedBody = ''
    const responseBody = JSON.stringify({ ok: true, bundle: { protocolVersion: 1, instanceId: 'i-remote', entries: [], skipped: [], digest: 'sha256:empty' } })
    const server = createServer((request, response) => {
      expect(request.url).toBe('/api/dshb/sync/internal/sessions/entries')
      expect(request.method).toBe('POST')
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(responseBody)
      })
    })
    const port = await listen(server)
    const requestBody = Buffer.from(JSON.stringify({ keys: ['entry-key'], manifestDigest: 'sha256:manifest' }))
    const input = Buffer.concat([
      encodeSyncControlFrame({ kind: 'request', protocolVersion: 1, operation: 'session-entries', port }),
      encodeSyncDataFrame(0, requestBody),
      encodeSyncControlFrame({ kind: 'request-end' }),
    ])

    try {
      const { code, output } = await runHelper(source, input)
      const decoder = new SyncFrameDecoder()
      const frames = decoder.push(output)
      decoder.finish()
      expect(code).toBe(0)
      expect(receivedBody).toBe(requestBody.toString('utf8'))
      expect(frames[0]).toMatchObject({ kind: 'control', value: { kind: 'response', status: 200, bodyMode: 'data' } })
      expect(Buffer.concat(frames.filter((frame) => frame.kind === 'data').map((frame) => frame.kind === 'data' ? frame.data : Buffer.alloc(0))).toString('utf8')).toBe(responseBody)
      expect(frames.at(-1)).toEqual({ kind: 'control', value: { kind: 'response-end' } })
    } finally {
      await close(server)
    }
  })
})
