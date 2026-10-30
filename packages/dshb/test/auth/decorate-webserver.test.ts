import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type WebServer from '@deepseek-ai/dsh-host-webserver'
import { CredentialStore } from '../../src/auth/credentials.js'
import { decorateWebServer } from '../../src/auth/decorate-webserver.js'
import { AuthGate } from '../../src/auth/gate.js'

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
  it('requires a same-origin loopback request for auth APIs before connection is ready', () => {
    const gate = new AuthGate(new CredentialStore())
    const trusted = request('/api/auth/status', '127.0.0.1:3080')
    trusted.headers.origin = 'http://127.0.0.1:3080'
    const crossSite = request('/api/auth/status', '127.0.0.1:3080')
    crossSite.headers.origin = 'https://evil.example'

    expect(gate.decide(trusted)).toBe('exempt')
    expect(gate.decide(crossSite)).toBe('forbidden')
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

  it('rejects untrusted auth API requests before dispatch', () => {
    const fixture = createWebServer()
    const gate = new AuthGate(new CredentialStore())
    gate.setAuthRequestTrustCheck(() => false)
    const dispose = decorateWebServer(fixture.webServer, new CredentialStore(), gate)
    const handler = vi.fn()
    fixture.webServer.register({ kind: 'prefix', path: '/api/auth', handler })
    const res = response()

    void fixture.route()?.handler(request('/api/auth/status', 'evil.example'), res)

    expect(res.statusCode).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    dispose()
  })
})
