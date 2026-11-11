import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Client } from 'ssh2'
import { SyncPeerManager, SyncPeerNotFoundError } from './peer-manager.js'
import { SyncSshProbeError, SyncSshTransport } from './ssh-transport.js'
import { relayCookieHeader, RelayTicketError, type RelayCookie } from './relay-auth.js'

// 本地侧远端会话中继：浏览器只访问本机 DSHB 的 /api/dshb/remote 路由；
// unary 调用（POST /api/<namespace/method> 信封）由本地服务端经 SSH
// direct-tcpip 转发到远端回环 WS 端口；事件流走本地专有升级路径的
// 原始字节透传。远端认证用 relay-ticket 铸造的短时效 cookie，仅存内存。

const DEFAULT_REMOTE_WEB_PORT = 3080
const MAX_RELAY_RESPONSE_BYTES = 64 * 1024 * 1024
const TICKET_REFRESH_MARGIN_MS = 60_000
const ENDPOINT_PATTERN = /^[a-z][A-Za-z0-9$]*\/[A-Za-z0-9$.]+$/
const HOP_BY_HOP = new Set(['host', 'cookie', 'origin', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade'])
// 转发响应时去掉的头：逐跳头、set-cookie（远端会话 cookie 不进浏览器），
// 以及把远端页面隔离出 iframe 的安全头（远端视图由本地 UI 内嵌打开）。
const PROXY_RESPONSE_DROP_HEADERS = new Set([...HOP_BY_HOP, 'set-cookie', 'content-security-policy', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy'])
// 转发请求时去掉的头：远端看到的是本地代理（Host 已改写为回环），浏览器的
// 源站与 fetch 元数据不透传，避免远端 trusted-host 判定受本地 origin 干扰。
const PROXY_REQUEST_DROP_HEADERS = new Set([...HOP_BY_HOP, 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'referer', 'if-none-match', 'if-modified-since'])
const UPGRADE_PATH_SUFFIX = '/app/api/remote.mux'

export class RemoteRelayError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RemoteRelayError'
  }
}

interface CachedTicket {
  authority: string
  cookie: RelayCookie
  fetchedAt: number
}

interface DirectChannel {
  client: Client
  socket: Duplex
  close(): void
}

export class RemoteRelayService {
  private readonly tickets = new Map<string, CachedTicket>()

  constructor(
    private readonly peers: SyncPeerManager,
    private readonly transport: SyncSshTransport,
    private readonly now: () => number = Date.now,
  ) {}

  /** 全部已配置 peer 的 id（供启动时预注册升级路径）。 */
  async peerIds(): Promise<string[]> {
    const peers = await this.peers.list()
    return peers.map((peer) => peer.id)
  }

  /** peer 的远端回环权威名；铸造 cookie 与改写 Host 头都必须用它。 */
  remoteAuthority(peerId: string): Promise<string> {
    return this.withPeer(peerId, (peer) => `127.0.0.1:${peer.remoteWebPort ?? DEFAULT_REMOTE_WEB_PORT}`)
  }

  private async withPeer<T>(peerId: string, action: (peer: NonNullable<Awaited<ReturnType<SyncPeerManager['get']>>>) => T): Promise<T> {
    const peer = await this.peers.get(peerId)
    if (!peer) throw new SyncPeerNotFoundError(peerId)
    return action(peer)
  }

  /** 取得有效中继凭据；过期前 60 秒起重新铸造，凭据仅存内存。 */
  async relayTicket(peerId: string): Promise<RelayCookie> {
    const authority = await this.remoteAuthority(peerId)
    const cached = this.tickets.get(peerId)
    if (cached && cached.authority === authority && cached.cookie.expiresAt - TICKET_REFRESH_MARGIN_MS > this.now()) {
      return cached.cookie
    }
    const fetched = await this.transport.fetchRelayTicket(peerId, authority)
    const cookie: RelayCookie = {
      name: fetched.name,
      value: fetched.value,
      expiresAt: this.now() + fetched.maxAgeSeconds * 1000,
      maxAgeSeconds: fetched.maxAgeSeconds,
    }
    this.tickets.set(peerId, { authority, cookie, fetchedAt: this.now() })
    return cookie
  }

  /** 打开到远端回环端口的 SSH direct-tcpip 通道；调用方负责 close()。 */
  async openChannel(peerId: string): Promise<DirectChannel & { peerRemotePort: number }> {
    const authority = await this.remoteAuthority(peerId)
    const remotePort = Number(authority.slice(authority.lastIndexOf(':') + 1))
    const { peer, client, stream } = await this.transport.openDirectChannel(peerId, '127.0.0.1', remotePort)
    return {
      client,
      socket: stream as unknown as Duplex,
      peerRemotePort: remotePort,
      close: () => {
        try {
          stream.destroy()
        } catch {}
        try {
          client.end()
        } catch {}
      },
    }
  }

  /** 转发一次 Remote unary 调用：POST /api/<endpoint>，返回远端信封。 */
  async relayCall(peerId: string, endpoint: string, payload: unknown): Promise<{ status: number; body: Buffer; contentType: string }> {
    if (!ENDPOINT_PATTERN.test(endpoint)) throw new RemoteRelayError('endpoint-invalid', 'relay endpoint is invalid')
    const authority = await this.remoteAuthority(peerId)
    const cookie = await this.relayTicket(peerId)
    return this.relayRequest(peerId, {
      method: 'POST',
      path: `/api/${endpoint}`,
      authority,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: endpoint,
        payload,
      }), 'utf8'),
      cookie,
    })
  }

  /**
   * 把一条浏览器请求流式转发到远端回环端口（远端会话页反向代理）。
   * 请求与响应都不落盘：静态资源、API 调用与流式端点逐字节透传，
   * 请求注入中继 cookie、Host 改写为远端回环权威名，浏览器元数据头剥离。
   */
  async relayProxy(
    peerId: string,
    req: IncomingMessage,
    res: ServerResponse,
    remotePath: string,
  ): Promise<void> {
    const authority = await this.remoteAuthority(peerId)
    const cookie = await this.relayTicket(peerId)
    const channel = await this.openChannel(peerId)
    const headers: Record<string, string | string[] | undefined> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (PROXY_REQUEST_DROP_HEADERS.has(name.toLowerCase())) continue
      headers[name] = value
    }
    headers.host = authority
    headers.cookie = relayCookieHeader(cookie)
    channel.socket.on?.('error', () => {})
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: channel.peerRemotePort,
      method: req.method ?? 'GET',
      path: remotePath,
      headers: headers as never,
      createConnection: () => channel.socket,
    })
    let responded = false
    return await new Promise<void>((resolve, reject) => {
      const settle = (error?: Error): void => {
        channel.close()
        if (error) reject(error)
        else resolve()
      }
      upstream.on('error', (error) => {
        if (!responded) {
          responded = true
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, code: 'relay-unreachable', error: error.message }))
          }
          settle()
          return
        }
        res.destroy()
        settle()
      })
      upstream.on('close', () => {
        if (!responded) {
          responded = true
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, code: 'relay-unreachable', error: 'remote closed before responding' }))
          }
          settle()
        }
      })
      req.on('error', () => {
        try {
          upstream.destroy()
        } catch {}
        settle()
      })
      upstream.on('response', (up) => {
        responded = true
        const outHeaders: Record<string, string | string[] | number> = {}
        for (const [name, value] of Object.entries(up.headers)) {
          if (value === undefined || PROXY_RESPONSE_DROP_HEADERS.has(name.toLowerCase())) continue
          outHeaders[name] = value
        }
        outHeaders['x-dshb-relay'] = peerId
        res.writeHead(up.statusCode ?? 502, outHeaders)
        up.on('error', () => {
          res.destroy()
          settle()
        })
        up.pipe(res)
        res.on('close', () => settle())
      })
      if (req.readableEnded) {
        upstream.end()
      } else {
        req.pipe(upstream)
      }
    })
  }

  /**
   * 把一条浏览器 WebSocket 升级透传到远端 `/api/remote.mux`：
   * 构造原始升级请求（注入中继 cookie、Host 改写）写入 SSH 通道，
   * 等远端 101 响应头原样回写后进入双向原始字节管道。
   */
  async relayUpgrade(
    peerId: string,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    remotePath: string,
  ): Promise<void> {
    const rejectUpgrade = (code: number, message: string): void => {
      try {
        socket.end(`HTTP/1.1 ${code} ${message}\r\nconnection: close\r\n\r\n`)
      } catch {}
    }
    let authority: string
    let cookie: RelayCookie
    try {
      authority = await this.remoteAuthority(peerId)
      cookie = await this.relayTicket(peerId)
    } catch (error) {
      rejectUpgrade(502, error instanceof Error ? error.message : 'relay ticket unavailable')
      return
    }
    let channel: DirectChannel & { peerRemotePort: number }
    try {
      channel = await this.openChannel(peerId)
    } catch (error) {
      rejectUpgrade(502, error instanceof Error ? error.message : 'relay channel unavailable')
      return
    }
    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    if (typeof key !== 'string' || typeof version !== 'string') {
      rejectUpgrade(400, 'Bad Request')
      channel.close()
      return
    }
    const requestLines = [
      `GET ${remotePath} HTTP/1.1`,
      `Host: ${authority}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: ${version}`,
    ]
    const extensions = req.headers['sec-websocket-extensions']
    const protocol = req.headers['sec-websocket-protocol']
    if (typeof extensions === 'string') requestLines.push(`Sec-WebSocket-Extensions: ${extensions}`)
    if (typeof protocol === 'string') requestLines.push(`Sec-WebSocket-Protocol: ${protocol}`)
    requestLines.push(`Cookie: ${relayCookieHeader(cookie)}`, '', '')
    const upstream = channel.socket
    upstream.write(Buffer.from(requestLines.join('\r\n'), 'utf8'))
    if (head.length > 0) upstream.write(head)
    // 缓冲远端响应直到头部边界，原样回写后进入双向透传。
    let buffered = Buffer.alloc(0)
    let piping = false
    const startPiping = (): void => {
      if (piping) return
      piping = true
      upstream.on('data', (chunk: Buffer) => {
        if (!socket.writable || !socket.write(chunk)) upstream.pause()
      })
      socket.on('data', (chunk: Buffer) => upstream.write(chunk))
      const teardown = (): void => {
        socket.destroy()
        channel.close()
      }
      upstream.on('error', teardown)
      socket.on('error', teardown)
      upstream.on('close', teardown)
      socket.on('close', teardown)
      socket.on('drain', () => upstream.resume())
      upstream.resume()
    }
    const onUpstreamData = (chunk: Buffer): void => {
      if (piping) return
      buffered = Buffer.concat([buffered, chunk])
      const boundary = buffered.indexOf(`\r\n\r\n`)
      if (boundary < 0) {
        if (buffered.length > 64 * 1024) {
          upstream.off('data', onUpstreamData)
          rejectUpgrade(502, 'relay upgrade response too large')
          channel.close()
        }
        return
      }
      upstream.off('data', onUpstreamData)
      const headerText = buffered.subarray(0, boundary).toString('latin1')
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(headerText)?.[1] ?? 0)
      const headRest = buffered.subarray(boundary + 4)
      if (status !== 101) {
        try {
          socket.end(buffered.subarray(0, boundary + 4))
        } catch {}
        channel.close()
        return
      }
      try {
        socket.write(buffered.subarray(0, boundary + 4))
        if (headRest.length > 0) socket.write(headRest)
      } catch {
        channel.close()
        return
      }
      startPiping()
    }
    upstream.on('data', onUpstreamData)
    upstream.on('error', () => {
      upstream.off('data', onUpstreamData)
      rejectUpgrade(502, 'relay upgrade failed')
    })
    socket.on('error', () => channel.close())
    socket.on('close', () => channel.close())
  }

  async relayRequest(
    peerId: string,
    request: {
      method: string
      path: string
      authority: string
      headers: Record<string, string | undefined>
      body?: Buffer
      cookie?: RelayCookie
    },
  ): Promise<{ status: number; body: Buffer; contentType: string }> {
    const channel = await this.openChannel(peerId)
    try {
      return await new Promise((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: channel.peerRemotePort,
          method: request.method,
          path: request.path,
          headers: {
            host: request.authority,
            ...(request.cookie ? { cookie: relayCookieHeader(request.cookie) } : {}),
            ...request.headers,
          },
          createConnection: () => channel.socket,
        })
        let settled = false
        const finish = (error: unknown, value?: { status: number; body: Buffer; contentType: string }): void => {
          if (settled) return
          settled = true
          if (error) reject(error)
          else resolve(value!)
        }
        req.on('error', (error) => finish(new RemoteRelayError('relay-unreachable', `relay request failed: ${error.message}`)))
        const responseChunks: Buffer[] = []
        let responseBytes = 0
        req.on('response', (res) => {
          res.on('data', (chunk: Buffer) => {
            responseBytes += chunk.length
            if (responseBytes > MAX_RELAY_RESPONSE_BYTES) {
              res.destroy()
              finish(new RemoteRelayError('relay-response-too-large', 'relay response exceeds the size limit'))
              return
            }
            responseChunks.push(chunk)
          })
          res.on('end', () => {
            finish(undefined, {
              status: res.statusCode ?? 502,
              body: Buffer.concat(responseChunks, responseBytes),
              contentType: String(res.headers['content-type'] ?? 'application/json'),
            })
          })
          res.on('error', (error) => finish(new RemoteRelayError('relay-unreachable', `relay response failed: ${error.message}`)))
        })
        if (request.body) req.write(request.body)
        req.end()
      })
    } finally {
      channel.close()
    }
  }

  /**
   * 经 direct-tcpip 通道调用远端 dshb internal 数据端点（manifest/entries/objects）。
   * 相比 SSH helper 协议省去每次 RPC 的握手与远端进程启动；调用方负责在
   * RemoteRelayError 时降级回 helper 路径。
   */
  async relayInternal(
    peerId: string,
    method: 'GET' | 'POST',
    path: string,
    body?: Buffer,
  ): Promise<{ status: number; body: Buffer }> {
    const authority = await this.remoteAuthority(peerId)
    const cookie = await this.relayTicket(peerId)
    const result = await this.relayRequest(peerId, {
      method,
      path,
      authority,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body,
      cookie,
    })
    if (result.status !== 200) {
      throw new RemoteRelayError('internal-request-failed', `remote internal endpoint returned ${result.status}`)
    }
    return { status: result.status, body: result.body }
  }

  /** 丢弃指定对端缓存的中继凭据（对端重启或凭据被拒时调用）。 */
  dropTicket(peerId: string): void {
    this.tickets.delete(peerId)
  }
}

/**
 * 本地路由：POST /api/dshb/sync/relay/<peerId>/call/<namespace>/<method>、
 * GET /api/dshb/sync/relay/<peerId>/app/...（远端会话页反向代理）以及
 * per-peer 懒注册的 wss 升级透传（远端 /api/remote.mux）。
 * 认证由 DSHB 登录门覆盖（/api 前缀）；凭据铸造失败按分类返回。
 */
export interface RemoteRelayRouteDeps {
  /** 本地会话 → 来源 peer 映射（同步状态 + 导入日志）。 */
  resolveSessionOrigin?: (sessionId: string) => { peerId: string; remoteSessionId: string } | undefined
}

export function registerRemoteRelayRoutes(ctx: Context, relay: RemoteRelayService, deps: RemoteRelayRouteDeps = {}): void {
  const upgradeDisposers = new Set<() => void>()
  const registeredUpgrades = new Set<string>()
  ctx.effect(() => () => {
    for (const dispose of upgradeDisposers) dispose()
    upgradeDisposers.clear()
  })
  const ensureRelayUpgrade = (peerId: string): void => {
    if (registeredUpgrades.has(peerId)) return
    registeredUpgrades.add(peerId)
    try {
      const dispose = ctx.webServer.registerUpgrade({
        path: `/api/dshb/sync/relay/${peerId}${UPGRADE_PATH_SUFFIX}`,
        handler: (req, socket, head) => {
          const url = new URL(req.url ?? '/', 'http://x')
          const remotePath = `${url.pathname.slice(`/api/dshb/sync/relay/${peerId}/app`.length)}${url.search}`
          void relay.relayUpgrade(peerId, req, socket, head, remotePath).catch(() => {
            try {
              socket.destroy()
            } catch {}
          })
        },
      })
      upgradeDisposers.add(dispose)
    } catch {
      // 重复注册（对端重建等）视为已注册
      registeredUpgrades.add(peerId)
    }
  }
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dshb/sync/relay',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const segments = url.pathname.split('/').filter(Boolean)
        const peerId = segments[4]
        const action = segments[5]
        const deny = (status: number, body: Record<string, unknown>): void => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        if (!peerId || segments.length < 5) {
          deny(404, { ok: false, error: 'not found' })
          return
        }
        if (action === 'call' && req.method === 'POST') {
          const endpoint = segments.slice(6).join('/')
          let payload: unknown
          try {
            const raw = await readBody(req)
            payload = raw === undefined ? undefined : JSON.parse(raw.toString('utf8'))
          } catch {
            deny(400, { ok: false, error: 'request body must be JSON' })
            return
          }
          try {
            const result = await relay.relayCall(peerId, endpoint, payload)
            res.writeHead(result.status, { 'content-type': result.contentType, 'cache-control': 'no-store' })
            res.end(result.body)
          } catch (error) {
            relayFailure(res, deny, error)
          }
          return
        }
        if (action === 'app' && req.method === 'GET') {
          // 远端会话页反向代理：剥离本地前缀（含 /app 段）后流式转发。
          // 首次访问时懒注册该 peer 的 mux 升级路径（SPA 加载后才连 wss）。
          ensureRelayUpgrade(peerId)
          const remotePath = `${url.pathname.slice(`/api/dshb/sync/relay/${peerId}/app`.length) || '/'}${url.search}`
          try {
            await relay.relayProxy(peerId, req, res, remotePath)
          } catch (error) {
            if (!res.headersSent) relayFailure(res, deny, error)
            else res.destroy()
          }
          return
        }
        deny(404, { ok: false, error: 'not found' })
      },
    }),
  )
  // 启动时为全部已配置 peer 预注册 mux 升级路径；懒注册（app 首访）仅作兜底，
  // 避免任何直连 wss 的场景因路由未注册而失败。
  setImmediate(() => {
    void relay
      .peerIds()
      .then((ids) => {
        for (const peerId of ids) ensureRelayUpgrade(peerId)
      })
      .catch(() => {
        // 注册失败不阻塞启动；app 首访时仍会兜底注册
      })
  })
  if (deps.resolveSessionOrigin) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/dshb/sync/session-origin',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const deny = (status: number, body: Record<string, unknown>): void => {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify(body))
          }
          if (req.method !== 'GET') {
            deny(405, { ok: false, error: 'method not allowed' })
            return
          }
          const sessionId = new URL(req.url ?? '/', 'http://x').searchParams.get('sessionId') ?? ''
          if (!/^[\w:-]{8,200}$/.test(sessionId)) {
            deny(400, { ok: false, error: 'invalid sessionId' })
            return
          }
          const origin = deps.resolveSessionOrigin!(sessionId)
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(origin ? { ok: true, peerId: origin.peerId, remoteSessionId: origin.remoteSessionId } : { ok: true, origin: null }))
        },
      }),
    )
  }
}

function relayFailure(
  res: ServerResponse,
  deny: (status: number, body: Record<string, unknown>) => void,
  error: unknown,
): void {
  if (error instanceof RelayTicketError) {
    deny(502, { ok: false, code: error.code, error: error.message })
    return
  }
  if (error instanceof SyncPeerNotFoundError) {
    deny(404, { ok: false, error: 'sync peer not found' })
    return
  }
  if (error instanceof SyncSshProbeError) {
    const status = error.category === 'auth' ? 502 : error.category === 'protocol' || error.category === 'hostkey' ? 409 : 503
    deny(status, { ok: false, code: `ssh-${error.category}`, error: error.message })
    return
  }
  if (error instanceof RemoteRelayError) {
    const status = error.code === 'endpoint-invalid' || error.code === 'relay-response-too-large' ? 400 : 502
    deny(status, { ok: false, code: error.code, error: error.message })
    return
  }
  deny(500, { ok: false, error: 'remote relay failed' })
}

function readBody(req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      resolve(undefined)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        fail()
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, size))
    })
    req.on('error', fail)
  })
}
