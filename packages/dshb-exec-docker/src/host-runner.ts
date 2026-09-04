import type { Context } from '@deepseek-ai/cordis'
import type { HostCommandRunner } from './docker-backend.js'
import { dockerDaemonRunner } from './daemon-runner.js'

interface SshExecutorLike {
  exec(argv: string[], cwd: string, env?: Record<string, string>, stdinData?: Buffer): Promise<{ code: number; stdout: string; stderr: string }>
}

export function sshRunner(executor: SshExecutorLike): HostCommandRunner {
  return {
    run: async (argv, cwd) => executor.exec(argv, cwd ?? '/'),
  }
}

export interface DockerNodeLike {
  id: string
  type: string
  ssh?: unknown
  docker?: { containerId?: string; image?: string; mode?: string; resources?: { cpus?: number; memoryMB?: number } }
}

export async function resolveHostRunner(ctx: Context, node: DockerNodeLike): Promise<HostCommandRunner | undefined> {
  if (node.type === 'remote-docker') {
    const sshWorlds = ctx.get('dshbSshWorlds') as { ensure(nodeId: string): Promise<{ executor: SshExecutorLike } | undefined> } | undefined
    const sshWorld = await sshWorlds?.ensure(node.id)
    if (!sshWorld) return undefined
    return sshRunner(sshWorld.executor)
  }
  return dockerDaemonRunner()
}
