import type { ShellExecutor, ShellExecSpec, ShellExecution, ShellProcessRead, ShellProcessStatus, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { CollectedOutput, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { sharedWorldResolver } from './resolve.js'
import type { ShellDelegate } from './types.js'

function outputReader(pick: (result: ShellRunResult) => CollectedOutput, current: () => ShellRunResult | undefined): SubprocessOutputReader {
  return {
    readFrom: (fromByte: number) => {
      const result = current()
      if (!result) return { text: '', nextOffset: fromByte, lossy: false }
      const output = pick(result)
      const bytes = Buffer.from(output.text, 'utf8')
      const start = Math.max(0, Math.min(fromByte, bytes.length))
      const text = bytes.subarray(start).toString('utf8')
      return {
        text,
        nextOffset: bytes.length,
        lossy: output.truncated && start === 0,
        ...(output.spillPath ? { spillPath: output.spillPath } : {}),
      }
    },
  }
}

/**
 * DSH 0.1.6+ collapses the shell seam into `resolve`/`execute`, and the
 * `ShellExecution` handle replaces the old `run`/`start` pair. Remote worlds
 * still expose a foreground `run`, so this adapts one remote run into a live
 * execution handle: the foreground projection is the run's result, and the
 * handle's status, exit classification, and collectors settle from it.
 */
export function executionFromRemoteRun(shell: ShellDelegate, spec: ShellExecSpec): Promise<ShellExecution> {
  const resultPromise = shell.run(spec)
  let status: ShellProcessStatus = 'running'
  let exitCode: number | null = null
  let signal: NodeJS.Signals | null = null
  let collected: ShellRunResult | undefined
  let consumed = false

  const done = resultPromise.then(
    (result) => {
      collected = result
      status = 'completed'
      exitCode = result.exitCode
      signal = result.signal
    },
    () => {
      status = 'killed'
    },
  )

  const execution = {
    get status() {
      return status
    },
    get exitCode() {
      return exitCode
    },
    get signal() {
      return signal
    },
    done,
    readOutput: (): ShellProcessRead => {
      if (!collected || consumed) return { delta: '', lossy: false }
      consumed = true
      const result = collected
      return {
        delta: result.stdout.text + result.stderr.text,
        lossy: result.stdout.truncated || result.stderr.truncated,
        ...(result.stdout.spillPath ? { stdoutSpillPath: result.stdout.spillPath } : {}),
        ...(result.stderr.spillPath ? { stderrSpillPath: result.stderr.spillPath } : {}),
      }
    },
    observed: {
      stdout: outputReader((result) => result.stdout, () => collected),
      stderr: outputReader((result) => result.stderr, () => collected),
    },
    kill: () => false,
    result: () => resultPromise,
  }

  return Promise.resolve(execution as unknown as ShellExecution)
}

export function decorateShell(shell: ShellExecutor): () => void {
  const resolver = sharedWorldResolver()

  const origExecute = shell.execute.bind(shell)

  shell.execute = async (spec: ShellExecSpec): Promise<ShellExecution> => {
    const ref = resolver.resolve(spec.workdir ?? '')
    if (ref.kind === 'local') return origExecute(spec)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    await ref.provider.ensureDir(ref.remotePath).catch(() => {})
    return executionFromRemoteRun(ref.provider.shell, { ...spec, workdir: ref.remotePath })
  }

  return () => {
    shell.execute = origExecute
  }
}
