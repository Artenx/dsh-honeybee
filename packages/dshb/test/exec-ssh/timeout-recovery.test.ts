import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshConnection, buildConnectConfig } from '../../src/exec-ssh/connection.js'
import { SshExecutor } from '../../src/exec-ssh/executor.js'
import { SshConnectionPool } from '../../src/exec-ssh/connection-pool.js'
import type { SshTarget, SshSecrets } from '../../src/exec-ssh/connection.js'

const TARGET: SshTarget = { host: '203.0.113.7', port: 22, username: 'root', auth: { kind: 'password' } }
const SECRETS: SshSecrets = { password: 'unused' }

type ClientOverrides = {
  exec?: (command: string, cb: (err: Error | undefined, channel: unknown) => void) => void
  sftp?: (cb: (err: Error | undefined, sftp: unknown) => void) => void
}

function fakeClient(overrides: ClientOverrides = {}) {
  return {
    ready: false,
    on: vi.fn(),
    once: vi.fn(),
    end: vi.fn(),
    exec: overrides.exec ?? vi.fn(),
    sftp: overrides.sftp ?? vi.fn(),
  }
}

/** Install a connection whose handshake resolves to the given fake client. */
function stubHandshake(conn: SshConnection, client: ReturnType<typeof fakeClient>) {
  ;(conn as unknown as { connectOnce: () => Promise<unknown> }).connectOnce = async () => {
    const setClient = conn as unknown as { client: unknown }
    setClient.client = client
    return client
  }
}

describe('SshConnection keepalive 配置', () => {
  it('连接配置启用 15s keepalive，半开连接可被检测', () => {
    const cfg = buildConnectConfig(TARGET, SECRETS)
    expect(cfg.keepaliveInterval).toBe(15_000)
    expect(cfg.keepaliveCountMax).toBeGreaterThan(0)
    expect(cfg.readyTimeout).toBeGreaterThan(0)
  })
})

describe('SshConnection 连接自愈', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('invalidate() 后 getClient() 重新握手而不是复用死连接', async () => {
    const conn = new SshConnection(TARGET, SECRETS)
    const first = fakeClient()
    stubHandshake(conn, first)
    await conn.getClient()
    expect(first.end).not.toHaveBeenCalled()

    conn.invalidate()
    expect(first.end).toHaveBeenCalledOnce()

    const second = fakeClient()
    stubHandshake(conn, second)
    const client = await conn.getClient()
    expect(client).toBe(second)
  })

  it('invalidate() 后再 close() 不会重复触发 end 崩溃', async () => {
    const conn = new SshConnection(TARGET, SECRETS)
    const first = fakeClient()
    stubHandshake(conn, first)
    await conn.getClient()
    conn.invalidate()
    conn.close()
    await expect(conn.getClient()).rejects.toThrow('connection closed')
  })

  it('getClient() 在 connecting 进行中时并发调用共享同一次握手', async () => {
    const conn = new SshConnection(TARGET, SECRETS)
    const client = fakeClient()
    let calls = 0
    ;(conn as unknown as { connectOnce: () => Promise<unknown> }).connectOnce = async () => {
      calls += 1
      const setClient = conn as unknown as { client: unknown }
      setClient.client = client
      return client
    }
    const [a, b] = await Promise.all([conn.getClient(), conn.getClient()])
    expect(calls).toBe(1)
    expect(a).toBe(b)
  })
})

describe('SshExecutor 操作级超时', () => {
  afterEach(() => {
    vi.useRealTimers()
    delete process.env.DSHB_SSH_OP_TIMEOUT_MS
  })

  it('sftp 请求挂起时在超时后以 timeout 类别拒绝并作废连接', async () => {
    process.env.DSHB_SSH_OP_TIMEOUT_MS = '50'
    const conn = new SshConnection(TARGET, SECRETS)
    const executor = new SshExecutor(conn, 'test-node')
    const client = fakeClient({
      sftp: (cb) => {
        // 永不回调 —— 模拟冻结连接上的 SFTP 子系统请求
      },
    })
    stubHandshake(conn, client)
    await expect(executor.stat('/tmp/x')).rejects.toMatchObject({ category: 'timeout' })
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('exec 通道建立挂起时在超时后拒绝', async () => {
    process.env.DSHB_SSH_OP_TIMEOUT_MS = '50'
    const conn = new SshConnection(TARGET, SECRETS)
    const executor = new SshExecutor(conn, 'test-node')
    const client = fakeClient({
      exec: () => {
        // 永不回调 —— 模拟冻结连接上的 channel 打开请求
      },
    })
    stubHandshake(conn, client)
    await expect(executor.exec(['echo', 'hi'], '/tmp')).rejects.toMatchObject({ category: 'timeout' })
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('超时后连接被作废，下一次操作触发重新握手', async () => {
    process.env.DSHB_SSH_OP_TIMEOUT_MS = '50'
    const conn = new SshConnection(TARGET, SECRETS)
    const executor = new SshExecutor(conn, 'test-node')
    const hanging = fakeClient({
      sftp: () => {
        // 第一次：挂起
      },
    })
    stubHandshake(conn, hanging)
    await expect(executor.stat('/tmp/x')).rejects.toMatchObject({ category: 'timeout' })

    const recovered = fakeClient({
      sftp: (cb) => {
        cb(undefined, {
          stat: (path: string, cb2: (err: Error | undefined, stats?: unknown) => void) => {
            cb2(undefined, { size: 3, mtime: 1, isDirectory: () => false, isFile: () => true })
          },
        })
      },
    })
    stubHandshake(conn, recovered)
    const info = await executor.stat('/tmp/x')
    expect(info?.isFile).toBe(true)
  })

  it('sftpCache 在超时后失效，后续操作重建 sftp 子系统', async () => {
    process.env.DSHB_SSH_OP_TIMEOUT_MS = '50'
    const conn = new SshConnection(TARGET, SECRETS)
    const executor = new SshExecutor(conn, 'test-node')
    let sftpCalls = 0
    const client = fakeClient({
      sftp: (cb) => {
        sftpCalls += 1
        if (sftpCalls === 1) return
        cb(undefined, {
          stat: (path: string, cb2: (err: Error | undefined, stats?: unknown) => void) => {
            cb2(undefined, { size: 1, mtime: 1, isDirectory: () => true, isFile: () => false })
          },
        })
      },
    })
    stubHandshake(conn, client)
    await expect(executor.stat('/tmp/y')).rejects.toMatchObject({ category: 'timeout' })
    await executor.stat('/tmp/y')
    expect(sftpCalls).toBe(2)
  })
})

describe('SshConnectionPool', () => {
  it('同一 target 复用同一连接对象，invalidate 后仍复用并内部重建', () => {
    const pool = new SshConnectionPool({} as never)
    const a = pool.acquire(TARGET, SECRETS)
    const b = pool.acquire(TARGET, SECRETS)
    expect(a).toBe(b)
    a.invalidate()
    expect(pool.acquire(TARGET, SECRETS)).toBe(a)
  })
})
