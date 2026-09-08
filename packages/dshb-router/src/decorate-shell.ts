import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { sharedWorldResolver } from './resolve.js'

export function decorateShell(shell: ShellExecutor): () => void {
  const resolver = sharedWorldResolver()

  const origRun = shell.run.bind(shell)
  const origStart = shell.start.bind(shell)

  shell.run = async (spec: ShellExecSpec): Promise<ShellRunResult> => {
    const ref = resolver.resolve(spec.workdir ?? '')
    if (ref.kind === 'local') return origRun(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    await ref.provider.ensureDir(ref.remotePath).catch(() => {})
    return ref.provider.shell.run({ ...spec, workdir: ref.remotePath })
  }

  shell.start = (spec: ShellExecSpec): ShellProcess => {
    const ref = resolver.resolve(spec.workdir ?? '')
    if (ref.kind === 'local') return origStart(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    void ref.provider.ensureDir(ref.remotePath).catch(() => {})
    return ref.provider.shell.start({ ...spec, workdir: ref.remotePath })
  }

  return () => {
    shell.run = origRun
    shell.start = origStart
  }
}
