import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerRemoteRelayRoutes, RemoteRelayService } from '../../src/core/sync/remote-relay.js'
import { SyncSshProbeError } from '../../src/core/sync/ssh-transport.js'
import type { SyncPeerView } from '../../src/core/sync/peer-manager.js'

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

function createRelay(serverPort: number): RemoteRelayService {
  const peer = peerView(serverPort)
  const peers = {
    get: async (id: string) => (id === peerId ? peer : undefined),
    list: async () => [peer],
  }
  const transport = {
    fetchRelayTicket: vi.fn(async () => ({ name: 'dsh-auth-x', value: 'v1.body.sig', maxAgeSeconds: 600 })),
    openDirectChannel: vi.fn(async (_id: string, host: string, port: number) => {
      const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
        const attempt = connect(port, host)
        attempt.once('connect', () => resolve(attempt))
        attempt.once('error', (error: Error) => {
          // 真实 transport 把直连失败按 SSH 错误分类（ECONNREFUSED → network）
          reject(new SyncSshProbeError('network'))
        })
      })
      return { peer, client: { end: () => {} }, stream: socket }
    }),
  }
  return new RemoteRelayService(peers as never, transport as never)
}

async function listenHttp(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

interface RouteHarness {
  routes: Array<{ handler: (req: never, res: never) => Promise<void> }>
  upgrades: string[]
}

/** prefix 中继路由是第一条注册；session-origin exact 路由是第二条。 */
function relayRoute(routes: RouteHarness['routes']): { handler: (req: never, res: never) => Promise<void> } {
  return routes[0]!
}

function originRoute(routes: RouteHarness['routes']): { handler: (req: never, res: never) => Promise<void> } {
  return routes[1]!
}

function setupRoutes(relay: RemoteRelayService, deps?: Parameters<typeof registerRemoteRelayRoutes>[2]): RouteHarness {
  const routes: Array<{ handler: (req: never, res: never) => Promise<void> }> = []
  const upgrades: string[] = []
  const ctx = {
    webServer: {
      register(route: { handler: (req: never, res: never) => Promise<void> }) {
        routes.push(route)
        return () => {}
      },
      registerUpgrade(route: { path: string }) {
        upgrades.push(route.path)
        return () => {}
      },
    },
    effect(register: () => () => void) {
      register()
    },
  }
  registerRemoteRelayRoutes(ctx as never, relay, deps)
  return { routes, upgrades }
}

interface MockRes {
  status: number
  headers: Record<string, unknown>
  chunks: Array<Buffer | string>
  ended: boolean
  headersSent?: boolean
  writeHead(status: number, headers?: Record<string, unknown>): void
  write(chunk: Buffer | string): void
  end(chunk?: Buffer | string): void
  destroy(): void
}

function mockRes(): MockRes {
  const res: MockRes = Object.assign(new EventEmitter() as EventEmitter, {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    write(chunk) {
      this.chunks.push(chunk)
    },
    end(chunk) {
      if (chunk) this.chunks.push(chunk)
      this.ended = true
      this.emit('close')
    },
    destroy() {
      this.ended = true
      this.emit('close')
    },
  })
  return res
}

function bodyOf(res: MockRes): string {
  return res.chunks.map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))).join('')
}

function mockReq(method: string, url: string, headers: Record<string, string> = {}): PassThrough & EventEmitter {
  const stream = new PassThrough()
  return Object.assign(stream, { method, url, headers }) as PassThrough & EventEmitter
}

describe('远端会话页反向代理', () => {
  it('剥离本地前缀转发、注入中继 cookie、改写 Host、剥离开源元数据头', async () => {
    const seen: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders }> = []
    const { server, port } = await listenHttp((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers })
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY', 'set-cookie': 'remote=1' })
        res.end('<html><body>remote app</body></html>')
      })
    })
    try {
      const relay = createRelay(port)
      const { routes, upgrades } = setupRoutes(relay)
      const res = mockRes()
      const req = mockReq('GET', `/api/dshb/sync/relay/${peerId}/app/`, { 'sec-fetch-site': 'same-origin', origin: 'http://local', cookie: 'local=1' })
      const pending = relayRoute(routes).handler(req as never, res as never)
      setTimeout(() => (req as unknown as { end(): void }).end(), 25)
      await pending
      expect(res.status).toBe(200)
      expect(res.ended).toBe(true)
      expect(bodyOf(res)).toContain('remote app')
      expect(seen).toHaveLength(1)
      expect(seen[0]!.url).toBe('/')
      expect(seen[0]!.headers.host).toBe(`127.0.0.1:${port}`)
      expect(seen[0]!.headers.cookie).toBe('dsh-auth-x=v1.body.sig')
      expect(seen[0]!.headers['sec-fetch-site']).toBeUndefined()
      expect(seen[0]!.headers.origin).toBeUndefined()
      expect((res.headers as Record<string, string>)['content-security-policy']).toBeUndefined()
      expect((res.headers as Record<string, string>)['x-frame-options']).toBeUndefined()
      expect((res.headers as Record<string, string>)['set-cookie']).toBeUndefined()
      expect((res.headers as Record<string, string>)['x-dshb-relay']).toBe(peerId)
      // 首次访问 app 前缀即懒注册该 peer 的 mux 升级路径
      expect(upgrades).toEqual([`/api/dshb/sync/relay/${peerId}/app/api/remote.mux`])
    } finally {
      server.close()
    }
  })

  it('流式透传多块响应且保留子路径与查询', async () => {
    const seen: Array<{ url?: string }> = []
    const { server, port } = await listenHttp((req, res) => {
      seen.push({ url: req.url })
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.write('chunk-one-')
      setTimeout(() => {
        res.write('chunk-two')
        res.end()
      }, 15)
    })
    try {
      const relay = createRelay(port)
      const { routes } = setupRoutes(relay)
      const res = mockRes()
      const req = mockReq('GET', `/api/dshb/sync/relay/${peerId}/app/assets/index-abc.js?v=9`)
      const pending = relayRoute(routes).handler(req as never, res as never)
      setTimeout(() => (req as unknown as { end(): void }).end(), 25)
      await pending
      await new Promise((r) => setTimeout(r, 40))
      expect(seen[0]!.url).toBe('/assets/index-abc.js?v=9')
      expect(bodyOf(res)).toBe('chunk-one-chunk-two')
      expect(res.ended).toBe(true)
    } finally {
      server.close()
    }
  })
})

describe('session-origin 查询路由', () => {
  it('返回本地会话对应的 peer 与远端会话 ID', async () => {
    const relay = createRelay(3080)
    const { routes } = setupRoutes(relay, {
      resolveSessionOrigin: (sessionId: string) => sessionId === 'session-local-1' ? { peerId, remoteSessionId: 'session-remote-9' } : undefined,
    })
    const res = mockRes()
    const req = mockReq('GET', '/api/dshb/sync/session-origin?sessionId=session-local-1')
    await originRoute(routes).handler(req as never, res as never)
    expect(res.status).toBe(200)
    expect(JSON.parse(bodyOf(res))).toEqual({ ok: true, peerId, remoteSessionId: 'session-remote-9' })

    const miss = mockRes()
    await originRoute(routes).handler(mockReq('GET', '/api/dshb/sync/session-origin?sessionId=session-unknown') as never, miss as never)
    expect(JSON.parse(bodyOf(miss))).toEqual({ ok: true, origin: null })
  })

  it('拒绝非法 sessionId 与非 GET 方法', async () => {
    const relay = createRelay(3080)
    const { routes } = setupRoutes(relay, { resolveSessionOrigin: () => undefined })
    const bad = mockRes()
    await originRoute(routes).handler(mockReq('GET', '/api/dshb/sync/session-origin?sessionId=x') as never, bad as never)
    expect(bad.status).toBe(400)
    const method = mockRes()
    await originRoute(routes).handler(mockReq('POST', '/api/dshb/sync/session-origin?sessionId=session-local-1') as never, method as never)
    expect(method.status).toBe(405)
  })
})

describe('升级路径预注册', () => {
  it('服务启动时为全部 peer 预注册 mux 升级路径', async () => {
    const relay = createRelay(3080)
    const { upgrades } = setupRoutes(relay, { resolveSessionOrigin: () => undefined })
    await new Promise((r) => setTimeout(r, 10))
    expect(upgrades).toContain(`/api/dshb/sync/relay/${peerId}/app/api/remote.mux`)
  })
})

describe('wss 升级透传', () => {
  let remoteServer: Server
  let remotePort = 0
  const upgradeRequests: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders }> = []

  beforeAll(async () => {
    remoteServer = createServer((req, res) => {
      res.writeHead(200)
      res.end('plain')
    })
    remoteServer.on('connection', (conn) => conn.on('error', () => {}))
    remoteServer.on('upgrade', (req, socket) => {
      upgradeRequests.push({ url: req.url, headers: req.headers })
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake=\r\n\r\n',
      )
      socket.write('hello-from-remote')
      socket.on('data', (chunk: Buffer) => {
        socket.write(chunk)
      })
    })
    await new Promise<void>((resolve) => remoteServer.listen(0, '127.0.0.1', resolve))
    remotePort = (remoteServer.address() as { port: number }).port
  })
  afterAll(() => {
    remoteServer.closeAllConnections()
    remoteServer.close()
  })

  it('透传升级请求（cookie/Host 注入）并进入双向原始字节管道', async () => {
    const relay = createRelay(remotePort)
    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    const browser = new PassThrough()
    ;(browser as unknown as { __tag?: string }).__tag = 'browser-test'
    const received: Buffer[] = []
    browser.on('data', (chunk: Buffer) => received.push(chunk))
    const head = Buffer.from('head-bytes')
    await relay.relayUpgrade(peerId, {
      headers: { 'sec-websocket-key': key, 'sec-websocket-version': '13' },
      url: '/api/remote.mux',
    } as never, browser as never, head, '/api/remote.mux')
    await new Promise((r) => setTimeout(r, 80))
    expect(upgradeRequests).toHaveLength(1)
    expect(upgradeRequests[0]!.headers.host).toBe(`127.0.0.1:${remotePort}`)
    expect(upgradeRequests[0]!.headers.cookie).toBe('dsh-auth-x=v1.body.sig')
    expect(upgradeRequests[0]!.headers['sec-websocket-key']).toBe(key)
    // 远端 → 本地方向的数据已到达浏览器 socket
    const seenText = () => received.map((chunk) => chunk.toString('utf8')).join('')
    expect(seenText()).toContain('hello-from-remote')
    // 本地 → 远端方向回显
    browser.write('ping-from-local')
    await new Promise((r) => setTimeout(r, 80))
    expect(seenText()).toContain('ping-from-local')
    browser.destroy()
  }, 15000)
})

describe('远端不可达时的代理降级', () => {
  it('代理请求失败返回 502 JSON', async () => {
    // 远端 TCP 可达但在响应前断开 → upstream error → relay-unreachable
    const { server, port } = await listenHttp((req, res) => {
      res.destroy()
      void req
    })
    server.on('connection', (conn) => conn.on('error', () => {}))
    try {
      const relay = createRelay(port)
      const { routes } = setupRoutes(relay)
      const res = mockRes()
      const req = mockReq('GET', `/api/dshb/sync/relay/${peerId}/app/`)
      const pending = relayRoute(routes).handler(req as never, res as never)
      setTimeout(() => (req as unknown as { end(): void }).end(), 25)
      await pending
      expect(res.status).toBe(502)
      expect(JSON.parse(bodyOf(res)).code).toBe('relay-unreachable')
    } finally {
      server.close()
    }
  })

  it('SSH 直连失败按 ssh-network 分类返回 503', async () => {
    const deadPort = await new Promise<number>((resolve) => {
      const dead = createServer()
      dead.listen(0, '127.0.0.1', () => {
        const port = (dead.address() as { port: number }).port
        dead.close(() => resolve(port))
      })
    })
    const relay = createRelay(deadPort)
    const { routes } = setupRoutes(relay)
    const res = mockRes()
    const req = mockReq('GET', `/api/dshb/sync/relay/${peerId}/app/`)
    await relayRoute(routes).handler(req as never, res as never)
    expect(res.status).toBe(503)
    expect(JSON.parse(bodyOf(res)).code).toBe('ssh-network')
  })

  it('对端拒绝升级时写回远端状态并关闭', async () => {
    const { server, port } = await listenHttp((_req, res) => {
      res.writeHead(200)
      res.end('not a websocket')
    })
    server.removeAllListeners('upgrade')
    server.on('upgrade', (_req, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
    })
    try {
      const relay = createRelay(port)
      const browser = new PassThrough()
      await relay.relayUpgrade(peerId, { headers: { 'sec-websocket-key': 'k', 'sec-websocket-version': '13' } } as never, browser as never, Buffer.alloc(0), '/api/remote.mux')
      await new Promise((r) => setTimeout(r, 60))
      expect(browser.read()?.toString('utf8')).toContain('400 Bad Request')
      browser.destroy()
    } finally {
      server.close()
    }
  }, 15000)

  it('未提供升级头时返回 400', async () => {
    const { server, port } = await listenHttp((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    try {
      const relay = createRelay(port)
      const browser = new PassThrough()
      await relay.relayUpgrade(peerId, { headers: {} } as never, browser as never, Buffer.alloc(0), '/api/remote.mux')
      await new Promise((r) => setTimeout(r, 40))
      expect(browser.read()?.toString('utf8')).toContain('400')
      browser.destroy()
    } finally {
      server.close()
    }
  }, 15000)
})
