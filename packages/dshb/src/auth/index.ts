import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { sharedCredentialStore } from './credentials.js'
import { decorateWebServer } from './decorate-webserver.js'
import { AuthGate, isTrustedAuthRequest, type BrowserSessionSecretProvider } from './gate.js'
import { installLoopbackCompat } from './loopback-compat.js'
import { LoginRateLimiter } from './ratelimit.js'
import { registerAuthRoutes } from './routes.js'
import { browserSessionSecret } from '../core/sync/relay-auth.js'

export const name = 'dshb-auth'

export const inject = ['webServer', 'credentials']

/**
 * 定位 dshb 实际安装所在 profile 的 node_modules。
 * link 安装（开发预览）下 ESM 真实路径解析会把 import.meta.url 指向仓库源码，
 * 由此向上 resolve 会命中仓库工作区的 @deepseek-ai/dsh-web-app 副本；服务器
 * 实际服务的却是 profile 内那份。通过 DSH_HOME/profiles 扫描 realpath 匹配
 * 找回安装位置；常规安装（真实文件就在 profile 内）时现有解析本就正确。
 */
function profileNodeModulesFor(realSelfPath: string): string | undefined {
  const home = process.env.DSH_HOME
  if (!home) return undefined
  const profilesDir = join(home, 'profiles')
  let names: string[]
  try {
    names = readdirSync(profilesDir)
  } catch {
    return undefined
  }
  for (const name of names) {
    const installed = join(profilesDir, name, 'node_modules', '@artenx', 'dshb')
    try {
      const realInstalled = realpathSync(installed)
      if (realInstalled === realSelfPath || realSelfPath.startsWith(`${realInstalled}/`)) {
        return join(profilesDir, name, 'node_modules')
      }
    } catch {
      /* profile without this package */
    }
  }
  return undefined
}

function registerFrontendBootRaceWorkaround(ctx: Context): void {
  try {
    // Resolve the frontend through the same runtime package tree the webserver
    // loads, so the patched hashed asset is the one the static fallback serves.
    // A linked plugin profile may contain only @artenx/dshb; its DSH executable
    // supplies the actual @deepseek-ai bundle tree.
    const resolver = createRequire(import.meta.url)
    const realSelf = realpathSync(fileURLToPath(import.meta.url))
    const profileModules = profileNodeModulesFor(realSelf)
    const webAppResolvers: Array<() => string> = []
    if (profileModules) {
      webAppResolvers.push(() => resolver.resolve('@deepseek-ai/dsh-web-app/package.json', { paths: [profileModules] }))
    }
    if (process.argv[1]) {
      webAppResolvers.push(() => createRequire(realpathSync(process.argv[1]!)).resolve('@deepseek-ai/dsh-web-app/package.json'))
    }
    webAppResolvers.push(() => resolver.resolve('@deepseek-ai/dsh-web-app/package.json'))
    let webAppManifest: string | undefined
    for (const resolveWebApp of webAppResolvers) {
      try {
        webAppManifest = resolveWebApp()
        break
      } catch {
        // Try the next runtime-owned package tree.
      }
    }
    let manifestPath: string
    if (webAppManifest) {
      manifestPath = createRequire(webAppManifest).resolve('@deepseek-ai/dsh-web-frontend/package.json')
    } else {
      manifestPath = resolver.resolve('@deepseek-ai/dsh-web-frontend/package.json', {
        paths: [process.cwd()],
      })
    }
    const assetDir = join(dirname(manifestPath), 'dist', 'assets')
    const assetName = readdirSync(assetDir).find((name) => /^index-.*\.js$/.test(name))
    if (!assetName) return

    const assetPath = join(assetDir, assetName)
    const source = readFileSync(assetPath, 'utf8')
    // DSH asserts before api-remotes' dynamic remote namespace fibers settle.
    // Delay the assertion so mountApp sees the complete client graph; real
    // activation failures still throw after the bounded wait. The minified
    // identifiers vary between builds, and 0.1.7 moved the assertion into nE.
    const legacyPatch = source.replace(
      /await ([A-Za-z_$][\w$]*)\.await\(\),this\.assertEntriesActive\(([A-Za-z_$][\w$]*)\)/,
      'await $1.await(),await new Promise(r=>setTimeout(r,8000)),this.assertEntriesActive($2)',
    )
    const patched = legacyPatch !== source
      ? legacyPatch
      : source.replace(
          /await ([A-Za-z_$][\w$]*)\.await\(\),([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\)/,
          'await $1.await(),await new Promise(r=>setTimeout(r,8000)),$2($3,$4)',
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
  const store = sharedCredentialStore()
  // relay cookie 校验需读 dsh browser-session 密钥；credentials 可能晚于
  // auth 插件就绪，provider 每次按需读取并缓存（密钥仅在凭据重置时变化）。
  let cachedBrowserSecret: Buffer | null | undefined
  let browserSecretFetchInFlight = false
  const credentialsLike = (ctx as unknown as { credentials?: { readRecord: (key: unknown) => Promise<unknown> } }).credentials
  const browserSecretProvider: BrowserSessionSecretProvider = async () => {
    if (cachedBrowserSecret !== undefined) return cachedBrowserSecret ?? undefined
    if (!credentialsLike || browserSecretFetchInFlight) return undefined
    browserSecretFetchInFlight = true
    try {
      const record = await credentialsLike.readRecord(credentialKey('client-connection', 'browser-session'))
      cachedBrowserSecret = browserSessionSecret(record) ?? null
    } catch {
      cachedBrowserSecret = null
    } finally {
      browserSecretFetchInFlight = false
    }
    return cachedBrowserSecret ?? undefined
  }
  const gate = new AuthGate(store, browserSecretProvider)
  ctx.effect(() => decorateWebServer(ctx.webServer, store, gate))
  registerFrontendBootRaceWorkaround(ctx)
  ctx.effect(() => ctx.webServer.tapIndex(installLoopbackCompat))
  registerAuthRoutes(ctx, store, new LoginRateLimiter())

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
    connCtx.effect(() => {
      const conn = (connCtx as unknown as {
        connection?: {
          browserAuth?: { isAuthenticated?: (...a: unknown[]) => unknown; __dshbNeutralized?: true }
          requestRejection?: (request: IncomingMessage) => number | undefined
        }
      }).connection
      const auth = conn?.browserAuth
      const originalIsAuthenticated = auth?.isAuthenticated
      const neutralizedIsAuthenticated = () => true
      let installedNeutralizer = false
      if (auth && typeof originalIsAuthenticated === 'function' && !auth.__dshbNeutralized) {
        auth.isAuthenticated = neutralizedIsAuthenticated
        auth.__dshbNeutralized = true
        installedNeutralizer = true
      }
      if (conn && typeof conn.requestRejection === 'function') {
        gate.setAuthRequestTrustCheck((req) => {
          const rejection = conn.requestRejection!(req)
          // DSH 401 is its browser-cookie gate; DSHB owns that check for these routes.
          if (rejection === undefined || rejection === 401) return true
          // DSH fence rejects non-loopback authorities (403). Preview reverse
          // proxies keep the external Host header, so DSHB falls back to its own
          // source checks (loopback peer address + cross-site protection); the
          // session gate still owns every authenticated route after login.
          return isTrustedAuthRequest(req)
        })
      }
      return () => {
        if (!auth || !installedNeutralizer) return
        if (auth.isAuthenticated === neutralizedIsAuthenticated && originalIsAuthenticated) {
          auth.isAuthenticated = originalIsAuthenticated
        }
        delete auth.__dshbNeutralized
      }
    })
  })
}
