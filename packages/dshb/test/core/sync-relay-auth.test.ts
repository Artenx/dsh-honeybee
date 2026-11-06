import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  browserSessionSecret,
  mintRelayCookie,
  RELAY_TICKET_MAX_AGE_MS,
  registerRelayTicketRoutes,
  relayCookieName,
  requestHasValidRelayCookie,
  validateRelayAuthority,
  verifyRelayCookie,
  RelayTicketError,
} from '../../src/core/sync/relay-auth.js'

const SECRET = Buffer.alloc(32, 7)

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function grantRecord(secret: Buffer): unknown {
  return { kind: 'grant', payload: { version: 1, secret: encodeBase64Url(secret) } }
}

interface RecordedResponse {
  status: number
  body: Record<string, unknown>
}

function setup(credentials: { readRecord(key: unknown): Promise<unknown> }) {
  const routes: Array<{ handler: (req: never, res: never) => Promise<void> }> = []
  const ctx = {
    webServer: { register(route: { handler: (req: never, res: never) => Promise<void> }) { routes.push(route); return () => {} } },
    effect(register: () => () => void) { register() },
  }
  registerRelayTicketRoutes(ctx as never, credentials as never)
  return { route: routes[0]! }
}

async function call(
  route: { handler: (req: never, res: never) => Promise<void> },
  method: string,
  remoteAddress: string,
  host: string,
  body?: unknown,
): Promise<RecordedResponse> {
  const request = Object.assign(new (await import('node:events')).EventEmitter(), {
    method,
    headers: { host },
    socket: { remoteAddress },
  }) as never
  const response = {
    status: 0,
    body: '',
    writeHead(status: number) { this.status = status },
    end(value?: string) { this.body = value ?? '' },
  }
  const pending = route.handler(request, response as never)
  if (body !== undefined) {
    ;(request as { headers: Record<string, string> }).headers['content-type'] = 'application/json'
    request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
  }
  await pending
  return { status: response.status, body: JSON.parse(response.body || '{}') as Record<string, unknown> }
}

describe('relay ticket minting', () => {
  it('mints a cookie byte-identical to the browser-auth format', () => {
    const authority = '127.0.0.1:3080'
    const cookie = mintRelayCookie(SECRET, authority, 1_000)

    expect(cookie.name).toBe('dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest()))
    expect(cookie.maxAgeSeconds).toBe(RELAY_TICKET_MAX_AGE_MS / 1000)
    const [version, body, signature] = cookie.value.split('.')
    expect(version).toBe('v1')
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<string, unknown>
    expect(payload).toEqual({ version: 1, authority, issuedAt: 1_000, expiresAt: 1_000 + RELAY_TICKET_MAX_AGE_MS })
    const expected = createHmac('sha256', SECRET).update(body!).digest()
    expect(signature).toBe(encodeBase64Url(expected))
  })

  it('derives the cookie name from the authority alone', () => {
    expect(relayCookieName('127.0.0.1:3080')).toBe('dsh-auth-' + encodeBase64Url(createHash('sha256').update('127.0.0.1:3080').digest()))
    expect(relayCookieName('127.0.0.1:3207')).toBe(relayCookieName('127.0.0.1:3207'))
  })

  it('verifyRelayCookie 与 mint 对称：合法放行、篡改/过期/错密钥/错 authority 拒绝', () => {
    const authority = '127.0.0.1:13080'
    const now = 5_000_000
    const cookie = mintRelayCookie(SECRET, authority, now)
    expect(verifyRelayCookie(cookie.value, SECRET, authority, now + 1)).toBe(true)
    // 过期拒绝
    expect(verifyRelayCookie(cookie.value, SECRET, authority, now + RELAY_TICKET_MAX_AGE_MS + 1)).toBe(false)
    // 错密钥拒绝
    expect(verifyRelayCookie(cookie.value, Buffer.alloc(32, 9), authority, now + 1)).toBe(false)
    // 错 authority 拒绝
    expect(verifyRelayCookie(cookie.value, SECRET, '127.0.0.1:9999', now + 1)).toBe(false)
    // 篡改签名拒绝
    const tampered = cookie.value.slice(0, -2) + 'XX'
    expect(verifyRelayCookie(tampered, SECRET, authority, now + 1)).toBe(false)
    // 非法格式拒绝
    expect(verifyRelayCookie('garbage', SECRET, authority, now)).toBe(false)
    expect(verifyRelayCookie(undefined, SECRET, authority, now)).toBe(false)
  })

  it('requestHasValidRelayCookie 从 Cookie 头按 Host 提取并校验', () => {
    const authority = 'dsh.artenx.top:9080'
    const cookie = mintRelayCookie(SECRET, authority, 1_000)
    const header = `other=1; ${cookie.name}=${cookie.value}; foo=bar`
    expect(requestHasValidRelayCookie(header, SECRET, authority, 2_000)).toBe(true)
    // Host 不匹配 → cookie 名不同 → 提取不到
    expect(requestHasValidRelayCookie(header, SECRET, '127.0.0.1:13080', 2_000)).toBe(false)
    // 缺头/缺密钥
    expect(requestHasValidRelayCookie(undefined, SECRET, authority, 2_000)).toBe(false)
    expect(requestHasValidRelayCookie(header, Buffer.alloc(0), authority, 2_000)).toBe(false)
  })
})

describe('relay ticket inputs', () => {
  it('accepts bare hosts and host:port authorities only', () => {
    expect(validateRelayAuthority('127.0.0.1:3080')).toBe('127.0.0.1:3080')
    expect(validateRelayAuthority('dsh.internal')).toBe('dsh.internal')
    expect(validateRelayAuthority('[::1]:3207')).toBe('[::1]:3207')
    expect(() => validateRelayAuthority('../etc/passwd')).toThrow(RelayTicketError)
    expect(() => validateRelayAuthority('host:99999')).toThrow(RelayTicketError)
    expect(() => validateRelayAuthority('host/path')).toThrow(RelayTicketError)
    expect(() => validateRelayAuthority(42)).toThrow(RelayTicketError)
  })

  it('validates the browser session secret record shape', () => {
    expect(browserSessionSecret(grantRecord(SECRET))).toEqual(SECRET)
    expect(() => browserSessionSecret(undefined)).toThrow(/missing/)
    expect(() => browserSessionSecret({ kind: 'grant', payload: { version: 2, secret: encodeBase64Url(SECRET) } })).toThrow(/unsupported/)
    expect(() => browserSessionSecret({ kind: 'grant', payload: { version: 1, secret: encodeBase64Url(Buffer.alloc(16, 1)) } })).toThrow(/invalid/)
    expect(() => browserSessionSecret({ kind: 'grant', payload: { version: 1, secret: 'not base64!!' } })).toThrow(/invalid/)
  })
})

describe('relay ticket route', () => {
  it('serves a short-lived cookie only to loopback callers', async () => {
    const reads: unknown[] = []
    const { route } = setup({ readRecord: async (key) => { reads.push(key); return grantRecord(SECRET) } })
    const local = await call(route, 'POST', '127.0.0.1', '127.0.0.1:3080', { authority: '127.0.0.1:3207' })
    const remote = await call(route, 'POST', '10.0.0.5', '127.0.0.1:3080', { authority: '127.0.0.1:3207' })

    expect(local.status).toBe(200)
    expect(local.body.ok).toBe(true)
    const cookie = local.body.cookie as { name: string; value: string; maxAgeSeconds: number }
    expect(cookie.name).toBe(relayCookieName('127.0.0.1:3207'))
    expect(cookie.maxAgeSeconds).toBe(RELAY_TICKET_MAX_AGE_MS / 1000)
    expect(reads).toHaveLength(1)
    expect(remote.status).toBe(403)
  })

  it('reports missing secrets and malformed authorities with stable codes', async () => {
    const missing = setup({ readRecord: async () => undefined })
    const unavailable = await call(missing.route, 'POST', '127.0.0.1', '127.0.0.1:3080', { authority: '127.0.0.1:3207' })
    expect(unavailable.status).toBe(503)
    expect(unavailable.body.code).toBe('relay-secret-unavailable')

    const limited = setup({ readRecord: async () => grantRecord(SECRET) })
    const invalid = await call(limited.route, 'POST', '127.0.0.1', '127.0.0.1:3080', { authority: '../evil' })
    expect(invalid.status).toBe(400)
    expect(invalid.body.code).toBe('authority-invalid')
  })

  it('rate limits minting to thirty requests per minute', async () => {
    const { route } = setup({ readRecord: async () => grantRecord(SECRET) })
    for (let index = 0; index < 30; index += 1) {
      const response = await call(route, 'POST', '127.0.0.1', '127.0.0.1:3080', { authority: '127.0.0.1:3207' })
      expect(response.status).toBe(200)
    }
    const limited = await call(route, 'POST', '127.0.0.1', '127.0.0.1:3080', { authority: '127.0.0.1:3207' })
    expect(limited.status).toBe(429)
  })
})
