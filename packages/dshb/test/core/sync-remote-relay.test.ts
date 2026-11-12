import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RemoteRelayService, registerRemoteRelayRoutes, RemoteRelayError } from '../../src/core/sync/remote-relay.js'
import type { SyncPeerView } from '../../src/core/sync/peer-manager.js'
import { RelayTicketError } from '../../src/core/sync/relay-auth.js'

const peerId = 'p-0123456789abcdef01234567'

function peerView(port: number): SyncPeerView {
  return {
    id: peerId,
    name: 'Remote',
    host: 'sync.example.com',
    port: 22,
    username: 'sync',
    authKind: 'password',
    direction: 'bidirectional',
    schedule: 'manual',
    syncSessions: true,
    enabled: true,
    remoteWebPort: port,
    hasSecret: { hasPassword: true, hasKey: false, hasPassphrase: false },
  }
}

interface TransportStub {
  fetchRelayTicket: ReturnType<typeof vi.fn>
  openDirectChannel: ReturnType<typeof vi.fn>
}

interface Harness {
  relay: RemoteRelayService
  transport: TransportStub
  seenCookies: string[]
  seenHosts: string[]
  seenPaths: string[]
  seenBodies: Array<Record<string, unknown>>
}

function createHarness(serverPort: number, ticket = { name: 'dsh-auth-x', value: 'v1.body.sig', maxAgeSeconds: 600 }): Harness {
  const seenCookies: string[] = []
  const seenHosts: string[] = []
  const seenPaths: string[] = []
  const seenBodies: Array<Record<string, unknown>> = []
  const peer = peerView(serverPort)
  const peers = {
    get: async (id: string) => id === peerId ? peer : undefined,
  }
  const transport: TransportStub = {
    fetchRelayTicket: vi.fn(async () => ticket),
    openDirectChannel: vi.fn(async (_id: string, host: string, port: number) => {
      const socket = connect(port, host)
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      return {
        peer,
        client: { end: () => {} },
        stream: socket,
      }
    }),
  }
  const relay = new RemoteRelayService(peers as never, transport as never)
  return { relay, transport, seenCookies, seenHosts, seenPaths, seenBodies }
}

async function listenHttp(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

describe('remote relay service', () => {
  it('forwards a Remote unary call over the direct channel with the relay cookie', async () => {
    const requests: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: string }> = []
    const { server, port } = await listenHttp((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: { sessions: [] } } }))
      })
    })
    try {
      const harness = createHarness(port)
      const result = await harness.relay.relayCall(peerId, 'session/list', { limit: 10 })

      expect(result.status).toBe(200)
      expect(JSON.parse(result.body.toString('utf8'))).toMatchObject({
        type: 'server-response',
        result: { ok: true, value: { sessions: [] } },
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe('/api/session/list')
      expect(requests[0]!.headers.host).toBe(`127.0.0.1:${port}`)
      expect(requests[0]!.headers.cookie).toBe('dsh-auth-x=v1.body.sig')
      const envelope = JSON.parse(requests[0]!.body) as Record<string, unknown>
      expect(envelope).toMatchObject({ type: 'client-request', method: 'session/list', payload: { limit: 10 } })
      expect(typeof envelope.rpcId).toBe('string')
      expect(harness.seenCookies).toEqual([])
      expect(harness.transport.openDirectChannel).toHaveBeenCalledWith(peerId, '127.0.0.1', port)
    } finally {
      server.close()
    }
  })

  it('reuses a cached ticket until close to expiry', async () => {
    const { server, port } = await listenHttp((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"type":"server-response","rpcId":"r","result":{"ok":true,"value":null}}')
    })
    try {
      const harness = createHarness(port)
      await harness.relay.relayCall(peerId, 'session/modelCatalog', undefined)
      await harness.relay.relayCall(peerId, 'session/canOpenWorkspacePath', undefined)
      expect(harness.transport.fetchRelayTicket).toHaveBeenCalledTimes(1)
    } finally {
      server.close()
    }
  })

  it('rejects malformed endpoints before opening a channel', async () => {
    const harness = createHarness(3080)
    await expect(harness.relay.relayCall(peerId, '../etc/passwd', undefined)).rejects.toMatchObject({ code: 'endpoint-invalid' })
    expect(harness.transport.openDirectChannel).not.toHaveBeenCalled()
    await expect(harness.relay.relayCall('p-missing', 'session/list', undefined)).rejects.toMatchObject({ name: 'SyncPeerNotFoundError' })
  })
})

describe('remote relay routes', () => {
  function setupRoute(relay: RemoteRelayService) {
    const routes: Array<{ handler: (req: never, res: never) => Promise<void> }> = []
    const ctx = {
      webServer: { register(route: { handler: (req: never, res: never) => Promise<void> }) { routes.push(route); return () => {} } },
      effect(register: () => () => void) { register() },
    }
    registerRemoteRelayRoutes(ctx as never, relay)
    return routes[0]!
  }

  async function call(
    route: { handler: (req: never, res: never) => Promise<void> },
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown>; contentType: string }> {
    const request = Object.assign(new EventEmitter(), {
      method,
      url,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    }) as never
    const response = {
      status: 0,
      body: '',
      contentType: '',
      writeHead(status: number, headers: Record<string, string>) { this.status = status; this.contentType = headers['content-type'] ?? '' },
      end(value?: string) { this.body = value ?? '' },
    }
    const pending = route.handler(request, response as never)
    if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
    await pending
    return { status: response.status, body: JSON.parse(response.body || '{}') as Record<string, unknown>, contentType: response.contentType }
  }

  it('passes the remote envelope through with its status', async () => {
    const { server, port } = await listenHttp((_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: false, error: { code: 'agent-busy', message: 'busy', details: {} } } }))
    })
    try {
      const harness = createHarness(port)
      const route = setupRoute(harness.relay)
      const result = await call(route, 'POST', `/api/dshb/sync/relay/${peerId}/call/session/list`, { limit: 1 })
      expect(result.status).toBe(409)
      expect(result.contentType).toBe('application/json')
      expect(result.body).toMatchObject({ type: 'server-response', result: { ok: false, error: { code: 'agent-busy' } } })
    } finally {
      server.close()
    }
  })

  it('classifies ticket and transport failures with stable codes', async () => {
    const failing = createHarness(3080)
    failing.transport.fetchRelayTicket.mockImplementation(async () => {
      throw new RelayTicketError('relay-secret-unavailable', 'browser session credential record is missing')
    })
    const route = setupRoute(failing.relay)
    const failure = await call(route, 'POST', `/api/dshb/sync/relay/${peerId}/call/session/list`, {})
    expect(failure.status).toBe(502)
    expect(failure.body.code).toBe('relay-secret-unavailable')

    const badRoute = setupRoute(createHarness(3080).relay)
    const invalid = await call(badRoute, 'POST', `/api/dshb/sync/relay/${peerId}/call/bad..endpoint`, {})
    expect(invalid.status).toBe(400)
    expect(invalid.body.code).toBe('endpoint-invalid')

    const unknown = await call(route, 'POST', '/api/dshb/sync/relay/p-missing/call/session/list', {})
    expect(unknown.status).toBe(404)
  })

  it('mints tickets for the default port when remoteWebPort is absent', async () => {
    const peer = { ...peerView(3080), remoteWebPort: undefined }
    const peers = { get: async (id: string) => id === peerId ? peer : undefined }
    const transport = {
      fetchRelayTicket: vi.fn(async (_id: string, authority: string) => {
        expect(authority).toBe('127.0.0.1:3080')
        return { name: 'dsh-auth-x', value: 'v1.body.sig', maxAgeSeconds: 600 }
      }),
      openDirectChannel: vi.fn(async () => {
        throw new RemoteRelayError('relay-unreachable', 'no server in this test')
      }),
    }
    const relay = new RemoteRelayService(peers as never, transport as never)
    await expect(relay.relayCall(peerId, 'session/list', undefined)).rejects.toMatchObject({ code: 'relay-unreachable' })
    expect(transport.fetchRelayTicket).toHaveBeenCalledOnce()
  })
})
