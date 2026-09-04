import type { ExecutionWorldProvider, NodeTestReport } from 'dshb-router/types'
import type { DockerBackend } from './docker-backend.js'
import { DockerClient } from './docker-client.js'
import { RemoteDockerCli } from './remote-docker-cli.js'
import { DockerFileSystem } from './fs-provider.js'
import { DockerShellExecutor, DockerSubprocessRuntime } from './process-provider.js'

export interface DockerNodeConfig {
  nodeId: string
  containerId: string
}

interface SshExecutorLike {
  exec(argv: string[], cwd: string, env?: Record<string, string>, stdinData?: Buffer): Promise<{ code: number; stdout: string; stderr: string }>
}

export class DockerExecutionWorld implements ExecutionWorldProvider {
  readonly fs: DockerFileSystem
  readonly subprocess: DockerSubprocessRuntime
  readonly shell: DockerShellExecutor
  readonly backend: DockerBackend

  constructor(readonly nodeId: string, backend: DockerBackend) {
    this.backend = backend
    this.fs = new DockerFileSystem(backend)
    this.subprocess = new DockerSubprocessRuntime(backend)
    this.shell = new DockerShellExecutor(backend)
  }

  static local(nodeId: string, containerId: string): DockerExecutionWorld {
    return new DockerExecutionWorld(nodeId, new DockerClient(containerId))
  }

  static remote(nodeId: string, containerId: string, sshExecutor: SshExecutorLike): DockerExecutionWorld {
    return new DockerExecutionWorld(nodeId, new RemoteDockerCli(sshExecutor, containerId))
  }

  async ensureDir(remotePath: string): Promise<void> {
    await this.backend.mkdir(remotePath)
  }

  async testConnection(): Promise<NodeTestReport> {
    try {
      const result = await this.backend.exec(['echo', 'ok'], '/')
      return { ok: result.stdout.trim() === 'ok', reachable: true }
    } catch (err) {
      return { ok: false, reachable: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

export class DockerWorldRegistry {
  private readonly worlds = new Map<string, DockerExecutionWorld>()

  get(nodeId: string): DockerExecutionWorld | undefined {
    return this.worlds.get(nodeId)
  }

  ensure(nodeId: string, backend: DockerBackend): DockerExecutionWorld {
    const existing = this.worlds.get(nodeId)
    if (existing) return existing
    const world = new DockerExecutionWorld(nodeId, backend)
    this.worlds.set(nodeId, world)
    return world
  }

  remove(nodeId: string): void {
    this.worlds.delete(nodeId)
  }
}
