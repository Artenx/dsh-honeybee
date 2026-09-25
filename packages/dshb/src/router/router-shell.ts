import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import { sharedWorldResolver } from './resolve.js'
import { executionFromRemoteRun } from './decorate-shell.js'

export default class RouterShell extends SandboxBashExecutor {
  private readonly resolver = sharedWorldResolver()

  constructor(ctx: Context, config: unknown) {
    super(ctx, config as never)
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return super.resolve(request)
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const ref = this.resolver.resolve(spec.workdir ?? '')
    if (ref.kind === 'local') return super.execute(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    await ref.provider.ensureDir(ref.remotePath).catch(() => {})
    return executionFromRemoteRun(ref.provider.shell, { ...spec, workdir: ref.remotePath })
  }
}
