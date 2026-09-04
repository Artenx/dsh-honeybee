import type { ExecutionWorldProvider, NodeTestReport } from 'dshb-router/types'
import { sharedWorldResolver } from 'dshb-router/resolve'
import { DockerClient } from './docker-client.js'
import { DockerFileSystem } from './fs-provider.js'
import { DockerShellExecutor, DockerSubprocessRuntime } from './process-provider.js'

export interface DockerNodeConfig {
  nodeId: string
  containerId: string
}

export class DockerExecutionWorld implements ExecutionWorldProvider {
  readonly fs: DockerFileSystem
  readonly subprocess: DockerSubprocessRuntime
  readonly shell: DockerShellExecutor
  readonly client: DockerClient

  constructor(readonly nodeId: string, config: DockerNodeConfig) {
    this.client = new DockerClient(config.containerId)
    this.fs = new DockerFileSystem(this.client)
    this.subprocess = new DockerSubprocessRuntime(this.client)
    this.shell = new DockerShellExecutor(this.client)
  }

  async ensureDir(remotePath: string): Promise<void> {
    await this.client.mkdir(remotePath)
  }

  async testConnection(): Promise<NodeTestReport> {
    const info = await this.client.inspect()
    if (!info) return { ok: false, error: 'container not found' }
    if (!info.running) return { ok: false, reachable: false, error: 'container not running' }
    return { ok: true, reachable: true }
  }
}

export class DockerWorldRegistry {
  private readonly worlds = new Map<string, DockerExecutionWorld>()

  get(nodeId: string): DockerExecutionWorld | undefined {
    return this.worlds.get(nodeId)
  }

  ensure(nodeId: string, containerId: string): DockerExecutionWorld {
    const existing = this.worlds.get(nodeId)
    if (existing) return existing
    const world = new DockerExecutionWorld(nodeId, { nodeId, containerId })
    this.worlds.set(nodeId, world)
    return world
  }

  remove(nodeId: string): void {
    this.worlds.delete(nodeId)
  }
}
