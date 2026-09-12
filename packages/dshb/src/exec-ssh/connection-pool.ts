import type { Context } from '@deepseek-ai/cordis'
import { SshConnection, type SshSecrets, type SshTarget, toConnectionError } from './connection.js'

export interface PooledConnection {
  target: SshTarget
  secrets: SshSecrets
  connection: SshConnection
}

export class SshConnectionPool {
  private readonly pool = new Map<string, PooledConnection>()

  constructor(private readonly ctx: Context) {}

  private key(target: SshTarget): string {
    return `${target.host}:${target.port}:${target.username}`
  }

  acquire(target: SshTarget, secrets: SshSecrets): SshConnection {
    const k = this.key(target)
    const existing = this.pool.get(k)
    if (existing) return existing.connection
    const connection = new SshConnection(target, secrets)
    this.pool.set(k, { target, secrets, connection })
    return connection
  }

  async test(target: SshTarget, secrets: SshSecrets): Promise<{ ok: boolean; error?: string; category?: string }> {
    try {
      const conn = new SshConnection(target, secrets)
      await conn.getClient()
      conn.close()
      return { ok: true }
    } catch (err) {
      const e = toConnectionError(err)
      return { ok: false, error: e.message, category: e.category }
    }
  }

  release(target: SshTarget): void {
    const k = this.key(target)
    const entry = this.pool.get(k)
    if (!entry) return
    entry.connection.close()
    this.pool.delete(k)
  }

  closeAll(): void {
    for (const entry of this.pool.values()) entry.connection.close()
    this.pool.clear()
  }
}
