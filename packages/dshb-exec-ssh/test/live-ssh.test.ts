import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { SshConnection } from '../src/connection.js'
import { SshExecutor } from '../src/executor.js'

const SSH_HOST = '127.0.0.1'
const SSH_PORT = 2222
const KEY_PATH = '/tmp/dshb-testkey'
const skip = !existsSync(KEY_PATH)

const skipIf = (reason: string) => (skip ? describe.skip(reason, () => {}) : describe)

skipIf('live SSH 全方法测试（需求 12.2，需 sshd:2222 + 密钥）')('live SSH 全方法测试', () => {
  let conn: SshConnection
  let ex: SshExecutor

  beforeAll(() => {
    const secrets = { privateKey: readFileSync(KEY_PATH, 'utf8') }
    conn = new SshConnection({ host: SSH_HOST, port: SSH_PORT, username: 'root', auth: { kind: 'key' } }, secrets)
    ex = new SshExecutor(conn, 'n-live')
  })

  afterAll(() => {
    conn?.close()
  })

  it('exec 行协议：echo + pwd', async () => {
    const r = await ex.exec(['bash', '-c', 'echo hello && pwd'], '/tmp', {})
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toContain('hello')
    expect(r.stdout).toContain('/tmp')
  })

  it('exec env 传递', async () => {
    const r = await ex.exec(['bash', '-c', 'echo $MYVAR'], '/tmp', { MYVAR: 'test-value' })
    expect(r.stdout.trim()).toBe('test-value')
  })

  it('exec argv 含特殊字符不注入', async () => {
    const r = await ex.exec(['echo', 'a;b$(whoami)'], '/tmp', {})
    expect(r.stdout.trim()).toBe('a;b$(whoami)')
  })

  it('SFTP 写文件', async () => {
    await ex.writeFile('/tmp/dshb-live-test.txt', 'live-content')
    const data = await ex.readFile('/tmp/dshb-live-test.txt')
    expect(data.toString()).toBe('live-content')
  })

  it('SFTP listDir', async () => {
    const entries = await ex.listDir('/tmp')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((e) => e.name === 'dshb-live-test.txt')).toBe(true)
  })

  it('SFTP stat', async () => {
    const st = await ex.stat('/tmp/dshb-live-test.txt')
    expect(st).toBeDefined()
    expect(st?.isFile).toBe(true)
    expect(st?.size).toBeGreaterThan(0)
  })

  it('SFTP mkdir（exec mkdir -p 兼容已存在）', async () => {
    await ex.exec(['mkdir', '-p', '/tmp/dshb-live-dir'], '/')
    const st = await ex.stat('/tmp/dshb-live-dir')
    expect(st?.isDirectory).toBe(true)
  })

  it('SFTP remove', async () => {
    await ex.remove('/tmp/dshb-live-test.txt')
    expect(await ex.stat('/tmp/dshb-live-test.txt')).toBeUndefined()
  })

  it('PTY 终端：不回显 payload', async () => {
    const pty = await ex.pty(['bash'], '/tmp', {}, 80, 24)
    let output = ''
    pty.onData((chunk) => { output += chunk.toString('utf8') })
    await new Promise((r) => setTimeout(r, 1500))
    pty.kill()
    expect(output).not.toMatch(/[A-Za-z0-9+/]{20,}={0,2}/)
    expect(output).toMatch(/[$#]/)
  })

  it('ensureRg（探测/补齐）', async () => {
    await ex.ensureRg()
    const r = await ex.exec(['bash', '-c', 'command -v rg || echo __missing__'], '/')
    expect(r.stdout).not.toContain('__missing__')
  })

  it('错误分类：连接不存在的主机', async () => {
    const badConn = new SshConnection({ host: '127.0.0.1', port: 9999, username: 'x', auth: { kind: 'password' } }, { password: 'x' })
    await expect(badConn.getClient()).rejects.toThrow()
    badConn.close()
  })
})
