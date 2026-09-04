import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { sharedWorldResolver } from './resolve.js'

export default class RouterShell extends SandboxBashExecutor {
  private readonly resolver = sharedWorldResolver()

  constructor(ctx: Context, config: unknown) {
    super(ctx, config as never)
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return super.resolve(request)
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const ref = this.resolver.resolve(spec.workdir ?? '')
    if (ref.kind === 'local') return super.run(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.shell.run({ ...spec, workdir: ref.remotePath })
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const ref = this.resolver.resolve(spec.workdir ?? '')
    if (ref.kind === 'local') return super.start(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.shell.start({ ...spec, workdir: ref.remotePath })
  }
}
