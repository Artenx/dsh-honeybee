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

  /** 丢弃指定对端缓存的中继凭据（对端重启或凭据被拒时调用）。 */
  dropTicket(peerId: string): void {
    this.tickets.delete(peerId)
  }
}

/**
 * 本地路由：POST /api/dshb/sync/relay/<peerId>/call/<namespace>/<method>。
 * 认证由 DSHB 登录门覆盖（/api 前缀）；凭据铸造失败按分类返回。
 */
export function registerRemoteRelayRoutes(ctx: Context, relay: RemoteRelayService): void {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dshb/sync/relay',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const segments = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean)
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
        deny(404, { ok: false, error: 'not found' })
      },
    }),
  )
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
