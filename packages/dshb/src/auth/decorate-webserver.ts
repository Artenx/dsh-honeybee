import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type WebServer from '@deepseek-ai/dsh-host-webserver'
import { AuthGate, rewriteToLoopback } from './gate.js'
import type { CredentialStore } from './credentials.js'

type ResourceFallback = { resource: unknown }
type CompatibleFallback = WebRoute['handler'] | ResourceFallback

function isResourceFallback(fallback: CompatibleFallback): fallback is ResourceFallback {
  return typeof fallback === 'object'
    && fallback !== null
    && 'resource' in fallback
    && typeof fallback.resource === 'function'
}

export function decorateWebServer(
  webServer: WebServer,
  store: CredentialStore,
  gate = new AuthGate(store),
): () => void {
  const origRegister = webServer.register.bind(webServer)
  const fallbackServer = webServer as unknown as {
    registerFallback: (fallback: CompatibleFallback) => () => void
    fallback?: CompatibleFallback & { __dshbGated?: true }
  }
  const origRegisterFallback = fallbackServer.registerFallback.bind(webServer)
  const origRegisterUpgrade = webServer.registerUpgrade.bind(webServer)

  webServer.register = (route: WebRoute): (() => void) => {
    return origRegister({
      ...route,
      handler: (req, res) => guarded(route, req, res),
    })
  }

  fallbackServer.registerFallback = (handler: CompatibleFallback): (() => void) => {
    // Newer DSH releases register SPA fallbacks as resources. Their resource
    // callback owns index authorization and must keep its original contract.
    if (isResourceFallback(handler)) return origRegisterFallback(handler)
    return origRegisterFallback((req, res) =>
      guarded({ kind: 'exact', path: '/', handler }, req, res),
    )
  }

  webServer.registerUpgrade = (route: WebUpgradeRoute): (() => void) => {
    return origRegisterUpgrade({
      ...route,
      handler: (req, socket, head) => guardedUpgrade(route, req, socket, head),
    })
  }

  // DSH 0.1.5+: the frontend-static plugin may have claimed the fallback seat
  // *before* this decoration runs (plugin apply order is not guaranteed). The
  // registerFallback wrap above only gates fallbacks registered later, so also
  // wrap an already-claimed seat in place. Idempotent via the __dshbGated mark.
  const origFallback = fallbackServer.fallback
  if (typeof origFallback === 'function' && !origFallback.__dshbGated) {
    const wrapped: WebRoute['handler'] & { __dshbGated?: true } = (req, res) =>
      guarded({ kind: 'exact', path: '/', handler: origFallback }, req, res)
    wrapped.__dshbGated = true
    fallbackServer.fallback = wrapped
  }

  function guarded(
    route: WebRoute,
    req: IncomingMessage,
    res: ServerResponse,
  ): void | Promise<void> {
    const decision = gate.decide(req)
    if (decision === 'allow') {
      rewriteToLoopback(req, webServer.port)
      return route.handler(req, res)
    }
    if (decision === 'exempt') {
      return route.handler(req, res)
    }
    if (decision === 'redirect-login') {
      res.writeHead(302, { location: '/login' })
      res.end()
      return
    }
    if (decision === 'forbidden') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
      return
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
  }

  function guardedUpgrade(
    route: WebUpgradeRoute,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void | Promise<void> {
    const decision = gate.decide(req)
    if (decision === 'allow' || decision === 'exempt') {
      if (decision === 'allow') rewriteToLoopback(req, webServer.port)
      return route.handler(req, socket, head)
    }
    socket.write(decision === 'forbidden'
      ? 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'
      : 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
  }

  return () => {
    webServer.register = origRegister
    fallbackServer.registerFallback = origRegisterFallback
    webServer.registerUpgrade = origRegisterUpgrade
    fallbackServer.fallback = origFallback
  }
}
