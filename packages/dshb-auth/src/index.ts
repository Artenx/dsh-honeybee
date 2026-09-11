import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { sharedCredentialStore } from './credentials.js'
import { decorateWebServer } from './decorate-webserver.js'
import { installLoopbackCompat } from './loopback-compat.js'
import { LoginRateLimiter } from './ratelimit.js'
import { registerAuthRoutes } from './routes.js'

export const name = 'dshb-auth'

export const inject = ['webServer']

function registerFrontendBootRaceWorkaround(ctx: Context): void {
  try {
    // Resolve from the active profile so the route patches the same hashed asset
    // that dsh-web-app's static fallback serves.
    const resolver = createRequire(import.meta.url)
    const manifestPath = resolver.resolve('@deepseek-ai/dsh-web-frontend/package.json', {
      paths: [process.cwd()],
    })
    const assetDir = join(dirname(manifestPath), 'dist', 'assets')
    const assetName = readdirSync(assetDir).find((name) => /^index-.*\.js$/.test(name))
    if (!assetName) return

    const assetPath = join(assetDir, assetName)
    const source = readFileSync(assetPath, 'utf8')
    // DSH 0.1.5 asserts before api-remotes' dynamic remote namespace fibers
    // settle. Delay the assertion so mountApp sees the complete client graph;
    // real activation failures still throw after the bounded wait.
    const patched = source.replace(
      'await i.await(),this.assertEntriesActive(t)',
      'await i.await(),await new Promise(r=>setTimeout(r,8000)),this.assertEntriesActive(t)',
    )
    if (patched === source) return

    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: `/assets/${basename(assetPath)}`,
        handler: (_req, res) => {
          res.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/javascript; charset=utf-8',
          })
          res.end(patched)
        },
      }),
    )
  } catch {
    // Upstream assets are optional from DSHB's perspective. A missing or changed
    // frontend layout simply skips this version-specific workaround.
  }
}

export function apply(ctx: Context): void {
  decorateWebServer(ctx.webServer, sharedCredentialStore())
  registerFrontendBootRaceWorkaround(ctx)
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
