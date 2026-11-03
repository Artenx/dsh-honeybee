import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { isLoopbackRequest } from '../../auth/loopback.js'

// 中继凭据的格式与常量复制自 dsh-client-connection 的 browser-auth（本插件
// 兼容范围内该格式稳定）：cookie 名 dsh-auth- + base64url(sha256(authority))，
// 载荷 v1.<payload>.<hmac>，HMAC-SHA256 密钥存于 credentials 的
// client-connection/browser-session 记录。铸造只在本机回环内部路由上进行，
// 凭据有效期 10 分钟且绝不落盘。

const RELAY_COOKIE_PREFIX = 'dsh-auth-'
const RELAY_COOKIE_VERSION = 1
const RELAY_SECRET_BYTES = 32
export const RELAY_TICKET_MAX_AGE_MS = 10 * 60 * 1000
const MAX_TICKETS_PER_MINUTE = 30

const AUTHORITY_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[(?:[0-9A-Fa-f:.]+)\])(?::\d{1,5})?$/

export class RelayTicketError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RelayTicketError'
  }
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

/** 校验并提取 credentials 记录中的浏览器会话签名密钥（32 字节）。 */
export function browserSessionSecret(record: unknown): Buffer {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new RelayTicketError('relay-secret-unavailable', 'browser session credential record is missing')
  }
  const payload = (record as { payload?: unknown }).payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RelayTicketError('relay-secret-unavailable', 'browser session credential payload is missing')
  }
  const { version, secret } = payload as { version?: unknown; secret?: unknown }
  if (version !== RELAY_COOKIE_VERSION || typeof secret !== 'string') {
    throw new RelayTicketError('relay-secret-unavailable', 'browser session credential payload is unsupported')
  }
  const decoded = decodeBase64Url(secret)
  if (decoded === undefined || decoded.byteLength !== RELAY_SECRET_BYTES) {
    throw new RelayTicketError('relay-secret-unavailable', 'browser session credential secret is invalid')
  }
  return decoded
}

export function validateRelayAuthority(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255 || !AUTHORITY_PATTERN.test(value)) {
    throw new RelayTicketError('authority-invalid', 'relay authority must be a bare host or host:port')
  }
  const port = value.includes(']:') || (!value.includes(']') && value.includes(':'))
    ? Number(value.slice(value.lastIndexOf(':') + 1))
    : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RelayTicketError('authority-invalid', 'relay authority port is invalid')
  }
  return value
}

export interface RelayCookie {
  name: string
  value: string
  expiresAt: number
  maxAgeSeconds: number
}

/** 与 browser-auth 相同的 cookie 名派生：dsh-auth- + base64url(sha256(authority))。 */
export function relayCookieName(authority: string): string {
  return RELAY_COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** 按远端 Host browser-auth 的格式铸造一个权威名绑定的短时效签名 cookie。 */
export function mintRelayCookie(secret: Buffer, authority: string, now: number, maxAgeMs = RELAY_TICKET_MAX_AGE_MS): RelayCookie {
  const issuedAt = now
  const expiresAt = issuedAt + maxAgeMs
  const body = encodeBase64Url(Buffer.from(JSON.stringify({
    version: RELAY_COOKIE_VERSION,
    authority,
    issuedAt,
    expiresAt,
  }), 'utf8'))
  const signature = createHmac('sha256', secret).update(body).digest()
  return {
    name: relayCookieName(authority),
    value: `v1.${body}.${encodeBase64Url(signature)}`,
    expiresAt,
    maxAgeSeconds: Math.floor(maxAgeMs / 1000),
  }
}

export function relayCookieHeader(cookie: RelayCookie): string {
  return `${cookie.name}=${cookie.value}`
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      resolve(null)
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
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          fail()
          return
        }
        settled = true
        resolve(value as Record<string, unknown>)
      } catch {
        fail()
      }
    })
    req.on('error', fail)
  })
}

/**
 * 远端侧中继凭据铸造路由：POST /api/dshb/sync/internal/relay-ticket。
 * 仅接受回环请求；用本机 credentials 的浏览器会话密钥为请求指定的
 * authority 铸造 ≤10 分钟签名 cookie。凭据只在响应中返回一次。
 */
export function registerRelayTicketRoutes(ctx: Context, credentials: {
  readRecord(key: CredentialKey): Promise<unknown>
}): void {
  const rateLimit = { windowStart: 0, count: 0 }
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/dshb/sync/internal/relay-ticket',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const deny = (status: number, body: Record<string, unknown>): void => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        if (!isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) {
          deny(403, { ok: false, error: 'loopback access required' })
          return
        }
        if (req.method !== 'POST') {
          deny(405, { ok: false, error: 'method not allowed' })
          return
        }
        const now = Date.now()
        if (now - rateLimit.windowStart > 60_000) {
          rateLimit.windowStart = now
          rateLimit.count = 0
        }
        rateLimit.count += 1
        if (rateLimit.count > MAX_TICKETS_PER_MINUTE) {
          deny(429, { ok: false, error: 'relay ticket rate limit exceeded' })
          return
        }
        const body = await readJsonBody(req, 1024)
        let authority: string
        try {
          authority = validateRelayAuthority(body?.authority)
        } catch (error) {
          const code = error instanceof RelayTicketError ? error.code : 'authority-invalid'
          deny(400, { ok: false, code, error: error instanceof Error ? error.message : 'authority is invalid' })
          return
        }
        try {
          const record = await credentials.readRecord(credentialKey('client-connection', 'browser-session'))
          const secret = browserSessionSecret(record)
          const cookie = mintRelayCookie(secret, authority, now)
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, cookie: { name: cookie.name, value: cookie.value, maxAgeSeconds: cookie.maxAgeSeconds } }))
        } catch (error) {
          if (error instanceof RelayTicketError) {
            deny(503, { ok: false, code: error.code, error: error.message })
            return
          }
          deny(500, { ok: false, code: 'relay-ticket-failed', error: 'relay ticket minting failed' })
        }
      },
    }),
  )
}

/** 导出给测试：校验铸造值与浏览器认证的期望格式逐字节一致。 */
export const relayTicketTestKit = { constantTimeEquals }
