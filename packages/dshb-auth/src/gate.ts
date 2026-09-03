import type { IncomingMessage } from 'node:http'
import { isLoopbackRequest } from './loopback.js'
import { readCookie, SESSION_COOKIE, verifySession } from './session.js'
import type { CredentialStore } from './credentials.js'

export type GateDecision = 'allow' | 'redirect-login' | 'reject'

export class AuthGate {
  constructor(private readonly store: CredentialStore) {}

  decide(req: IncomingMessage): GateDecision {
    if (isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) return 'allow'
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/login' || path.startsWith('/api/auth/')) return 'allow'
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

export function rewriteToLoopback(req: IncomingMessage, port: number): void {
  const authority = `127.0.0.1:${port}`
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
