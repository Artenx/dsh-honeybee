import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { sanitizeUsername, type CredentialStore } from './credentials.js'
import { clearCookieHeader, issueSession, readCookie, SESSION_COOKIE, sessionCookieHeader, verifySession } from './session.js'
import type { LoginRateLimiter } from './ratelimit.js'
import { loginPageHtml } from './login-page.js'

const MAX_BODY = 64 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    if ((req.headers['content-type'] ?? '') !== 'application/json') {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

export function registerAuthRoutes(ctx: Context, store: CredentialStore, limiter: LoginRateLimiter): void {
  const webServer = ctx.webServer

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/login',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(loginPageHtml())
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/api/auth',
      handler: async (req, res) => {
        const path = new URL(req.url ?? '/', 'http://x').pathname

        if (path === '/api/auth/status' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, initialized: store.isInitialized() })
          return
        }

        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }

        const body = await readBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
          return
        }

        if (path === '/api/auth/register') {
          if (store.isInitialized()) {
            sendJson(res, 409, { ok: false, error: '管理员已存在' })
            return
          }
          const username = sanitizeUsername(String(body.username ?? ''))
          const password = String(body.password ?? '')
          if (!username) {
            sendJson(res, 400, { ok: false, error: '用户名不能为空' })
            return
          }
          if (password.length < 8) {
            sendJson(res, 400, { ok: false, error: '密码至少 8 个字符' })
            return
          }
          store.register(username, password)
          const cookie = issueSession(username, store.sessionSecret!)
          sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookieHeader(cookie) })
          return
        }

        if (path === '/api/auth/login') {
          const ip = clientIp(req)
          if (limiter.isLocked(ip)) {
            sendJson(res, 429, { ok: false, error: '尝试次数过多，请 30 秒后再试' })
            return
          }
          if (!store.isInitialized()) {
            sendJson(res, 409, { ok: false, error: '尚未初始化管理员' })
            return
          }
          const username = sanitizeUsername(String(body.username ?? ''))
          const password = String(body.password ?? '')
          if (username !== store.username || !store.verify(password)) {
            limiter.recordFailure(ip)
            sendJson(res, 401, { ok: false, error: '用户名或密码错误' })
            return
          }
          limiter.recordSuccess(ip)
          const cookie = issueSession(username, store.sessionSecret!)
          sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookieHeader(cookie) })
          return
        }

        if (path === '/api/auth/logout') {
          sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookieHeader() })
          return
        }

        if (path === '/api/auth/change-password' || path === '/api/auth/change-username') {
          const secret = store.sessionSecret
          const currentName = store.username
          const cookie = secret && currentName ? readCookie(req.headers.cookie, SESSION_COOKIE) : undefined
          if (!secret || !currentName || !cookie || !verifySession(cookie, secret, currentName)) {
            sendJson(res, 401, { ok: false, error: 'unauthorized' })
            return
          }
          const ip = clientIp(req)
          if (limiter.isLocked(ip)) {
            sendJson(res, 429, { ok: false, error: '尝试次数过多，请 30 秒后再试' })
            return
          }
          if (!store.verify(String(body.currentPassword ?? ''))) {
            limiter.recordFailure(ip)
            sendJson(res, 401, { ok: false, error: '当前密码错误' })
            return
          }
          limiter.recordSuccess(ip)
          if (path === '/api/auth/change-password') {
            const password = String(body.password ?? '')
            if (password.length < 8) {
              sendJson(res, 400, { ok: false, error: '密码至少 8 个字符' })
              return
            }
            store.changePassword(currentName, password)
          } else {
            const username = sanitizeUsername(String(body.username ?? ''))
            if (!username) {
              sendJson(res, 400, { ok: false, error: '用户名不能为空' })
              return
            }
            store.changeUsername(username)
          }
          const fresh = issueSession(store.username!, store.sessionSecret!)
          sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookieHeader(fresh) })
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}
