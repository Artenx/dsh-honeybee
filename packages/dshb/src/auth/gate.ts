import type { IncomingMessage } from 'node:http'
import { isLoopbackRequest } from './loopback.js'
import { readCookie, SESSION_COOKIE, verifySession } from './session.js'
import type { CredentialStore } from './credentials.js'

export type GateDecision = 'allow' | 'exempt' | 'redirect-login' | 'reject' | 'forbidden'

function isTrustedLoopbackAuthRequest(req: IncomingMessage): boolean {
  if (!isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string' || !req.headers.host) return false
  try {
    return new URL(origin).host === new URL(`http://${req.headers.host}`).host
  } catch {
    return false
  }
}

export class AuthGate {
  private isTrustedAuthRequest: ((req: IncomingMessage) => boolean) | undefined

  constructor(private readonly store: CredentialStore) {}

  setAuthRequestTrustCheck(check: (req: IncomingMessage) => boolean): void {
    this.isTrustedAuthRequest = check
  }

  decide(req: IncomingMessage): GateDecision {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/login') return 'exempt'
    if (path === '/api/auth' || path.startsWith('/api/auth/')) {
      const trusted = this.isTrustedAuthRequest
        ? this.isTrustedAuthRequest(req)
        : isTrustedLoopbackAuthRequest(req)
      return trusted ? 'exempt' : 'forbidden'
    }
    if (isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) return 'allow'
    const secret = this.store.sessionSecret
    const username = this.store.username
    if (secret && username) {
      const value = readCookie(req.headers.cookie, SESSION_COOKIE)
      if (verifySession(value, secret, username)) return 'allow'
    }
    if (this.isPageRequest(req)) return 'redirect-login'
    return 'reject'
  }

  private isPageRequest(req: IncomingMessage): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path.startsWith('/api/')) return false
    const accept = req.headers.accept ?? ''
    return accept.includes('text/html') || accept.includes('*/*')
  }
}

export function rewriteToLoopback(req: IncomingMessage, port?: number): void {
  const localPort = port ?? req.socket.localPort
  if (typeof localPort !== 'number') return
  const authority = `127.0.0.1:${localPort}`
  req.headers.host = authority
  for (const name of ['origin', 'referer'] as const) {
    const value = req.headers[name]
    if (typeof value !== 'string') continue
    try {
      const url = new URL(value)
      url.host = authority
      req.headers[name] = url.toString()
    } catch {}
  }
}
