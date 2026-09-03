import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { Context } from '@deepseek-ai/cordis'
import { sharedCredentialStore } from './credentials.js'
import { AuthGate, rewriteToLoopback } from './gate.js'

export default class AuthedWebServer extends WebServer {
  private readonly gate = new AuthGate(sharedCredentialStore())

  constructor(ctx: Context, config: { host: '127.0.0.1' | '0.0.0.0'; port: number }) {
    super(ctx, config)
  }

  override register(route: WebRoute): () => void {
    return super.register({ ...route, handler: (req, res) => this.guarded(route, req, res) })
  }

  override registerFallback(handler: WebRoute['handler']): () => void {
    return super.registerFallback((req, res) =>
      this.guarded({ kind: 'exact', path: '/', handler }, req, res),
    )
  }

  override registerUpgrade(route: WebUpgradeRoute): () => void {
    return super.registerUpgrade({
      ...route,
      handler: (req, socket, head) => this.guardedUpgrade(route, req, socket, head),
    })
  }

  private guarded(route: WebRoute, req: IncomingMessage, res: ServerResponse): void | Promise<void> {
    const decision = this.gate.decide(req)
    if (decision === 'allow') {
      rewriteToLoopback(req, this.port)
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

  private guardedUpgrade(
    route: WebUpgradeRoute,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void | Promise<void> {
    if (this.gate.decide(req) !== 'allow') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    rewriteToLoopback(req, this.port)
    return route.handler(req, socket, head)
  }
}
