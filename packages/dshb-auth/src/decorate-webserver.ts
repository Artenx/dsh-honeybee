import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type WebServer from '@deepseek-ai/dsh-host-webserver'
import { AuthGate, rewriteToLoopback } from './gate.js'
import type { CredentialStore } from './credentials.js'

export function decorateWebServer(
  webServer: WebServer,
  store: CredentialStore,
): () => void {
  const gate = new AuthGate(store)

  const origRegister = webServer.register.bind(webServer)
  const origRegisterFallback = webServer.registerFallback.bind(webServer)
  const origRegisterUpgrade = webServer.registerUpgrade.bind(webServer)

  webServer.register = (route: WebRoute): (() => void) => {
    return origRegister({
      ...route,
      handler: (req, res) => guarded(route, req, res),
    })
  }

  webServer.registerFallback = (handler: WebRoute['handler']): (() => void) => {
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
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
  }

  return () => {
    webServer.register = origRegister
    webServer.registerFallback = origRegisterFallback
    webServer.registerUpgrade = origRegisterUpgrade
  }
}
