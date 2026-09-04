import type { Context } from '@deepseek-ai/cordis'
import type { ExecutionWorldProvider, NodeTestReport } from 'dshb-router/types'
import { sharedWorldResolver } from 'dshb-router/resolve'
import { SshConnectionPool } from './connection-pool.js'
import { SshExecutor } from './executor.js'
import { SshFileSystem } from './fs-provider.js'
import { SshShellExecutor, SshSubprocessRuntime } from './process-provider.js'

export interface SshNodeConfig {
  nodeId: string
  host: string
  port: number
  username: string
  auth: { kind: 'password' | 'key' | 'agent'; keyPath?: string }
  secrets: { password?: string; privateKey?: string; passphrase?: string }
  jump?: Array<{ host: string; port?: number; username?: string; keyPath?: string }>
}

export class SshExecutionWorld implements ExecutionWorldProvider {
  readonly fs: SshFileSystem
  readonly subprocess: SshSubprocessRuntime
  readonly shell: SshShellExecutor
  readonly executor: SshExecutor

  constructor(
    readonly nodeId: string,
    private readonly config: SshNodeConfig,
    pool: SshConnectionPool,
    audit?: (nodeId: string, op: string, target: string, result: string) => void,
  ) {
    const target = {
      host: config.host,
      port: config.port,
      username: config.username,
      auth: config.auth,
      jump: config.jump,
    }
    const connection = pool.acquire(target, config.secrets)
    this.executor = new SshExecutor(connection, nodeId, audit ? (op, t, r) => audit(nodeId, op, t, r) : undefined)
    this.fs = new SshFileSystem(this.executor)
    this.subprocess = new SshSubprocessRuntime(this.executor)
    this.shell = new SshShellExecutor(this.executor)
  }

  async ensureDir(remotePath: string): Promise<void> {
    await this.executor.exec(['mkdir', '-p', remotePath], '/')
  }

  async testConnection(): Promise<NodeTestReport> {
    try {
      const result = await this.executor.exec(['echo', 'ok'], '/')
      return { ok: result.stdout.trim() === 'ok', reachable: true }
    } catch (err) {
      return { ok: false, reachable: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

interface NodeRegistryLike {
  get(id: string): { id: string; type: string; ssh?: { host: string; port: number; username: string; auth: { kind: 'password' | 'key' | 'agent'; keyPath?: string }; jump?: Array<{ host: string; port?: number; username?: string; keyPath?: string }> } } | undefined
  getSecrets(id: string): Promise<{ password?: string; privateKey?: string; passphrase?: string } | undefined>
}

export class SshWorldRegistry {
  private readonly worlds = new Map<string, SshExecutionWorld>()

  constructor(
    private readonly pool: SshConnectionPool,
    private readonly nodeRegistry?: NodeRegistryLike,
    private readonly audit?: (nodeId: string, op: string, target: string, result: string) => void,
  ) {}

  register(config: SshNodeConfig): SshExecutionWorld {
    const world = new SshExecutionWorld(config.nodeId, config, this.pool, this.audit)
    this.worlds.set(config.nodeId, world)
    return world
  }

  get(nodeId: string): SshExecutionWorld | undefined {
    return this.worlds.get(nodeId)
  }

  async ensure(nodeId: string): Promise<SshExecutionWorld | undefined> {
    const existing = this.worlds.get(nodeId)
    if (existing) return existing
    if (!this.nodeRegistry) return undefined
    const node = this.nodeRegistry.get(nodeId)
    if (!node || (node.type !== 'remote-ssh' && node.type !== 'remote-docker') || !node.ssh) return undefined
    const secrets = (await this.nodeRegistry.getSecrets(nodeId)) ?? {}
    return this.register({
      nodeId,
      host: node.ssh.host,
      port: node.ssh.port,
      username: node.ssh.username,
      auth: node.ssh.auth,
      secrets,
      jump: node.ssh.jump,
    })
  }

  remove(nodeId: string): void {
    const world = this.worlds.get(nodeId)
    if (world) {
      this.worlds.delete(nodeId)
    }
  }

  clear(): void {
    this.worlds.clear()
  }
}
