import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { sharedWorldResolver } from './resolve.js'

export function decorateSubprocess(sp: SubprocessRuntime): () => void {
  const resolver = sharedWorldResolver()

  const origSpawn = sp.spawn.bind(sp)
  const origSpawnTerminal = sp.spawnTerminal.bind(sp)

  sp.spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    const ref = resolver.resolve(spec.cwd ?? '')
    if (ref.kind === 'local') return origSpawn(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    void ref.provider.ensureDir(ref.remotePath).catch(() => {})
    return ref.provider.subprocess.spawn({ ...spec, cwd: ref.remotePath })
  }

  sp.spawnTerminal = async (spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> => {
    const ref = resolver.resolve(spec.cwd ?? '')
    if (ref.kind === 'local') return origSpawnTerminal(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    await ref.provider.ensureDir(ref.remotePath).catch(() => {})
    return ref.provider.subprocess.spawnTerminal({ ...spec, cwd: ref.remotePath })
  }

  return () => {
    sp.spawn = origSpawn
    sp.spawnTerminal = origSpawnTerminal
  }
}
