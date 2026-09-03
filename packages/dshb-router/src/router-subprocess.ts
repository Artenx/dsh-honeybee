import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { sharedWorldResolver } from './resolve.js'

export default class RouterSubprocess extends LocalSubprocessRuntime {
  private readonly resolver = sharedWorldResolver()

  constructor(ctx: Context) {
    super(ctx)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const ref = this.resolver.resolve(spec.cwd ?? '')
    if (ref.kind === 'local') return super.spawn(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.subprocess.spawn({ ...spec, cwd: ref.remotePath })
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const ref = this.resolver.resolve(spec.cwd ?? '')
    if (ref.kind === 'local') return super.spawnTerminal(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.subprocess.spawnTerminal({ ...spec, cwd: ref.remotePath })
  }
}
