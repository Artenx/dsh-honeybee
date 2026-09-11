import type { Context } from '@deepseek-ai/cordis'
import { sharedCredentialStore } from './credentials.js'
import { decorateWebServer } from './decorate-webserver.js'
import { installLoopbackCompat } from './loopback-compat.js'
import { LoginRateLimiter } from './ratelimit.js'
import { registerAuthRoutes } from './routes.js'

export const name = 'dshb-auth'

export const inject = ['webServer']

export function apply(ctx: Context): void {
  decorateWebServer(ctx.webServer, sharedCredentialStore())
  ctx.webServer.tapIndex(installLoopbackCompat)
  registerAuthRoutes(ctx, sharedCredentialStore(), new LoginRateLimiter())

  // DSH 0.1.5 introduced a browser-auth fence on the connection package: the SPA
  // fallback calls connection.authorizeIndex() on "/" (mints/checks DSH's own
  // launch-token cookie), and /api routes run requestRejection() which 401s when
  // that DSH cookie is absent. DSHB uses its own session cookie and must stay the
  // sole auth gate (DSH 0.1.1 had no such connection fence, so DSHB worked there).
  // Neutralize the connection's browserAuth.isAuthenticated check so DSH's fence
  // never rejects a DSHB-authenticated (or loopback) request; DSHB's gate still
  // rejects unauthenticated access to gated routes. Property is read at request
  // time, so installing it once after connection is ready suffices.
  ctx.inject(['connection'], (connCtx: Context) => {
    const conn = (connCtx as unknown as { connection?: { browserAuth?: { isAuthenticated?: (...a: unknown[]) => unknown; __dshbNeutralized?: true } } }).connection
    const auth = conn?.browserAuth
    if (auth && typeof auth.isAuthenticated === 'function' && !auth.__dshbNeutralized) {
      auth.isAuthenticated = () => true
      auth.__dshbNeutralized = true
    }
  })
}
