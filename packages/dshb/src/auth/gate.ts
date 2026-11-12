import type { IncomingMessage } from 'node:http'
import { isLoopbackAddress, isLoopbackRequest } from './loopback.js'
import { readCookie, SESSION_COOKIE, verifySession } from './session.js'
import type { CredentialStore } from './credentials.js'
import { requestHasValidRelayCookie } from '../core/sync/relay-auth.js'

export type GateDecision = 'allow' | 'exempt' | 'redirect-login' | 'reject' | 'forbidden'

/** 提供本机 dsh browser-session 签名密钥（relay cookie 校验依赖）。 */
export type BrowserSessionSecretProvider = () => Promise<Buffer | undefined>

/**
 * 认证路由（登录/状态）的可信来源判定。
 * - remoteAddress 必须回环：直连本机，或经可信反代（部署方边界）转发。
 * - 跨站浏览器请求一律拒绝（sec-fetch-site / Origin 与 Host 一致性）。
 * Host 头允许外部域名：预览反代会保留原始 Host，回环校验由
 * remoteAddress 与反代信任承担，登录后再经 rewriteToLoopback 归一。
 */
export function isTrustedAuthRequest(req: IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
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
  private readonly browserSecretProvider: BrowserSessionSecretProvider

  constructor(
    private readonly store: CredentialStore,
    browserSecretProvider?: BrowserSessionSecretProvider,
  ) {
    this.browserSecretProvider = browserSecretProvider ?? (() => Promise.resolve(undefined))
  }

  setAuthRequestTrustCheck(check: (req: IncomingMessage) => boolean): void {
    this.isTrustedAuthRequest = check
  }

  /**
   * relay cookie 校验是 decide 中唯一的异步步骤（需读 credentials）。
   * 返回 Promise<GateDecision>；调用方（guarded/guardedUpgrade）已支持
   * 返回 Promise。未配置 provider 或 secret 不可用时跳过，回退到既有判定。
   */
  async decide(req: IncomingMessage): Promise<GateDecision> {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/login') return 'exempt'
    if (path === '/api/auth' || path.startsWith('/api/auth/')) {
      const trusted = this.isTrustedAuthRequest
        ? this.isTrustedAuthRequest(req)
        : isTrustedAuthRequest(req)
      return trusted ? 'exempt' : 'forbidden'
    }
    if (isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) return 'allow'
    const secret = this.store.sessionSecret
    const username = this.store.username
    if (secret && username) {
      const value = readCookie(req.headers.cookie, SESSION_COOKIE)
      if (verifySession(value, secret, username)) return 'allow'
    }
    // relay cookie（dsh browser-auth 格式）：远端经 SSH 回环铸的短时效签名
    // cookie，HMAC 用本机 browser-session 密钥。让同步 relay 反代请求绕过
    // 登录门直接访问远端 SPA（元数据同步的「打开远端会话」链路）。
    try {
      const browserSecret = await this.browserSecretProvider()
      if (browserSecret && requestHasValidRelayCookie(req.headers.cookie, browserSecret, req.headers.host, Date.now())) {
        return 'allow'
      }
    } catch {}
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
