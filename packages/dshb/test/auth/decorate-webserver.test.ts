import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type WebServer from '@deepseek-ai/dsh-host-webserver'
import { CredentialStore } from '../../src/auth/credentials.js'
import { decorateWebServer } from '../../src/auth/decorate-webserver.js'
import { AuthGate } from '../../src/auth/gate.js'
import { mintRelayCookie } from '../../src/core/sync/relay-auth.js'

function createWebServer(): {
  webServer: WebServer
  fallback: () => unknown
  route: () => WebRoute | undefined
} {
  let registeredFallback: unknown
  let registeredRoute: WebRoute | undefined
  const server = {
    port: 3080,
    register(route: WebRoute) {
      registeredRoute = route
      return () => { registeredRoute = undefined }
    },
    registerFallback(fallback: unknown) {
      registeredFallback = fallback
      return () => { registeredFallback = undefined }
    },
    registerUpgrade() {
      return () => {}
    },
  }
  return {
    webServer: server as unknown as WebServer,
    fallback: () => registeredFallback,
    route: () => registeredRoute,
  }
}

function request(path: string, host = '127.0.0.1:3204'): IncomingMessage {
  return {
    method: 'GET',
    url: path,
    headers: { host },
    socket: { remoteAddress: '127.0.0.1', localPort: 3080 },
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { statusCode?: number; body?: string } {
  return {
    writeHead(statusCode: number) { this.statusCode = statusCode; return this },
    end(body?: string) { this.body = body; return this },
  } as unknown as ServerResponse & { statusCode?: number; body?: string }
}

describe('webserver auth decoration', () => {
  it('allows loopback and trusted-proxy auth requests while rejecting cross-site origins', async () => {
    const gate = new AuthGate(new CredentialStore())
    const trusted = request('/api/auth/status', '127.0.0.1:3080')
    trusted.headers.origin = 'http://127.0.0.1:3080'
    const proxied = request('/api/auth/status', '3206-57aa6cc7315ae197.monkeycode-ai.online')
    proxied.headers.origin = 'https://3206-57aa6cc7315ae197.monkeycode-ai.online'
    const crossSite = request('/api/auth/status', '127.0.0.1:3080')
    crossSite.headers.origin = 'https://evil.example'

    expect(await gate.decide(trusted)).toBe('exempt')
    expect(await gate.decide(proxied)).toBe('exempt')
    expect(await gate.decide(crossSite)).toBe('forbidden')
  })

  it('放行带有效 relay cookie 的非回环页面请求（同步 relay 反代链路）', async () => {
    const authority = '127.0.0.1:13080'
    const secret = Buffer.alloc(32, 7)
    const cookie = mintRelayCookie(secret, authority, Date.now())
    const gate = new AuthGate(new CredentialStore(), async () => secret)
    const req = request('/', '127.0.0.1:13080')
    req.socket.remoteAddress = '172.17.0.1'
    req.headers.cookie = `${cookie.name}=${cookie.value}`
    req.headers.accept = 'text/html'
    expect(await gate.decide(req)).toBe('allow')

    // 无 cookie 或错误密钥仍走 redirect-login
    const req2 = request('/', '127.0.0.1:13080')
    req2.socket.remoteAddress = '172.17.0.1'
    req2.headers.accept = 'text/html'
    expect(await gate.decide(req2)).toBe('redirect-login')
  })

  it('preserves resource-object SPA fallbacks', () => {
    const fixture = createWebServer()
    const dispose = decorateWebServer(fixture.webServer, new CredentialStore())
    const fallback = { resource: vi.fn() }
    const compatibleServer = fixture.webServer as unknown as {
      registerFallback(value: unknown): () => void
    }

    compatibleServer.registerFallback(fallback)

    expect(fixture.fallback()).toBe(fallback)
    dispose()
  })

  it('restores webserver hooks when disposed', () => {
    const fixture = createWebServer()
    const dispose = decorateWebServer(fixture.webServer, new CredentialStore())
    const decorated = {
      register: fixture.webServer.register,
      registerFallback: (fixture.webServer as unknown as { registerFallback: unknown }).registerFallback,
      registerUpgrade: fixture.webServer.registerUpgrade,
    }

    dispose()

    expect(fixture.webServer.register).not.toBe(decorated.register)
    expect((fixture.webServer as unknown as { registerFallback: unknown }).registerFallback).not.toBe(decorated.registerFallback)
    expect(fixture.webServer.registerUpgrade).not.toBe(decorated.registerUpgrade)

    const handler = vi.fn()
    fixture.webServer.register({ kind: 'exact', path: '/plain', handler })
    expect(fixture.route()?.handler).toBe(handler)

    const fallback = vi.fn()
    const compatibleServer = fixture.webServer as unknown as {
      registerFallback: (handler: unknown) => () => void
    }
    compatibleServer.registerFallback(fallback)
    expect(fixture.fallback()).toBe(fallback)
  })

  it('continues to guard function fallbacks', async () => {
    const fixture = createWebServer()
    const dispose = decorateWebServer(fixture.webServer, new CredentialStore())
    const fallback = vi.fn()
    const compatibleServer = fixture.webServer as unknown as {
      registerFallback(value: unknown): () => void
    }
    const req = request('/')
    const res = response()

    compatibleServer.registerFallback(fallback)
    await (fixture.fallback() as (req: IncomingMessage, res: ServerResponse) => void)(req, res)

    expect(fallback).toHaveBeenCalledWith(req, res)
    expect(req.headers.host).toBe('127.0.0.1:3080')
    dispose()
  })

  it('rejects untrusted auth API requests before dispatch', async () => {
    const fixture = createWebServer()
    const gate = new AuthGate(new CredentialStore())
    gate.setAuthRequestTrustCheck(() => false)
    const dispose = decorateWebServer(fixture.webServer, new CredentialStore(), gate)
    const handler = vi.fn()
    fixture.webServer.register({ kind: 'prefix', path: '/api/auth', handler })
    const res = response()

    await fixture.route()?.handler(request('/api/auth/status', 'evil.example'), res)

    expect(res.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    dispose()
  })
})
