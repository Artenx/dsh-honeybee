import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isLoopbackAddress, isLoopbackHost, isLoopbackRequest } from '../src/loopback.js'
import { CredentialStore, sanitizeUsername } from '../src/credentials.js'
import { issueSession, verifySession, readCookie, SESSION_COOKIE } from '../src/session.js'
import { LoginRateLimiter } from '../src/ratelimit.js'

const TMP_HOME = '/tmp/dshb-test-auth'
const TMP_KEY = Buffer.from('a'.repeat(32))

describe('loopback 判定（需求 1.3/1.7）', () => {
  it('IPv4 回环地址', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.0.1.1')).toBe(true)
    expect(isLoopbackAddress('127.255.255.254')).toBe(true)
  })
  it('IPv6 回环与映射', () => {
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })
  it('非回环地址', () => {
    expect(isLoopbackAddress('192.168.1.1')).toBe(false)
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
  it('Host 头回环（含端口）', () => {
    expect(isLoopbackHost('127.0.0.1:3080')).toBe(true)
    expect(isLoopbackHost('localhost:3080')).toBe(true)
    expect(isLoopbackHost('[::1]:3080')).toBe(true)
    expect(isLoopbackHost('example.com:3080')).toBe(false)
    expect(isLoopbackHost(undefined)).toBe(false)
  })
  it('回环判定需 TCP + Host 同时回环', () => {
    expect(isLoopbackRequest('127.0.0.1', '127.0.0.1:3080')).toBe(true)
    expect(isLoopbackRequest('127.0.0.1', 'example.com:3080')).toBe(false)
    expect(isLoopbackRequest('192.168.1.1', '127.0.0.1:3080')).toBe(false)
  })
  it('不采信 X-Forwarded-For（函数根本不读该头）', () => {
    expect(isLoopbackRequest('127.0.0.1', '127.0.0.1:3080')).toBe(true)
  })
})

describe('scrypt 密码散列（需求 1.4）', () => {
  beforeEach(() => {
    process.env.DSH_HOME = TMP_HOME
    mkdirSync(join(TMP_HOME, 'dshb'), { recursive: true })
  })
  afterEach(() => {
    try { rmSync(TMP_HOME, { recursive: true, force: true }) } catch {}
  })
  it('注册后验证正确密码', () => {
    const store = new CredentialStore()
    store.register('admin', 'correctpass123')
    expect(store.isInitialized()).toBe(true)
    expect(store.verify('correctpass123')).toBe(true)
  })
  it('验证错误密码', () => {
    const store = new CredentialStore()
    store.register('admin', 'correctpass123')
    expect(store.verify('wrongpass')).toBe(false)
  })
  it('未初始化时 verify 返回 false', () => {
    const store = new CredentialStore()
    expect(store.verify('anything')).toBe(false)
  })
  it('用户名净化剔除控制字符', () => {
    expect(sanitizeUsername('ad\x00min\x7f')).toBe('admin')
  })
})

describe('HMAC-SHA256 会话 Cookie（需求 1.4）', () => {
  it('签发后验证通过', () => {
    const cookie = issueSession('admin', TMP_KEY)
    expect(verifySession(cookie, TMP_KEY, 'admin')).toBe(true)
  })
  it('篡改后验证失败', () => {
    const cookie = issueSession('admin', TMP_KEY)
    const tampered = cookie.slice(0, -2) + 'xx'
    expect(verifySession(tampered, TMP_KEY, 'admin')).toBe(false)
  })
  it('错误密钥验证失败', () => {
    const cookie = issueSession('admin', TMP_KEY)
    expect(verifySession(cookie, Buffer.from('b'.repeat(32)), 'admin')).toBe(false)
  })
  it('改用户名后旧 cookie 失效', () => {
    const cookie = issueSession('admin', TMP_KEY)
    expect(verifySession(cookie, TMP_KEY, 'newadmin')).toBe(false)
  })
  it('readCookie 从 Cookie 头解析', () => {
    expect(readCookie(`other=1; ${SESSION_COOKIE}=abc.def.ghi; foo=2`, SESSION_COOKIE)).toBe('abc.def.ghi')
    expect(readCookie(undefined, SESSION_COOKIE)).toBe(undefined)
  })
})

describe('登录限速（需求 1.5）', () => {
  it('5 次失败后锁定', () => {
    const limiter = new LoginRateLimiter()
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('1.2.3.4')
    }
    expect(limiter.isLocked('1.2.3.4')).toBe(true)
  })
  it('锁定前 4 次仍可用', () => {
    const limiter = new LoginRateLimiter()
    for (let i = 0; i < 4; i++) limiter.recordFailure('5.6.7.8')
    expect(limiter.isLocked('5.6.7.8')).toBe(false)
  })
  it('成功后清除计数', () => {
    const limiter = new LoginRateLimiter()
    for (let i = 0; i < 3; i++) limiter.recordFailure('9.0.0.1')
    limiter.recordSuccess('9.0.0.1')
    expect(limiter.isLocked('9.0.0.1')).toBe(false)
  })
  it('不同 IP 独立计数', () => {
    const limiter = new LoginRateLimiter()
    for (let i = 0; i < 5; i++) limiter.recordFailure('1.1.1.1')
    expect(limiter.isLocked('1.1.1.1')).toBe(true)
    expect(limiter.isLocked('2.2.2.2')).toBe(false)
  })
})
