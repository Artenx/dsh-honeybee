import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { CollectedOutput, SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SshExecutor } from './executor.js'

export class SshShellExecutor {
  constructor(private readonly executor: SshExecutor) {}

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/',
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024 * 1024,
      signal: request.signal,
      stdin: request.stdin,
      env: request.env,
      sandboxPolicy: request.sandboxPolicy,
    } as ShellExecSpec
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const result = await this.executor.exec(['sh', '-c', spec.command], spec.workdir, (spec.env ?? {}) as Record<string, string>, spec.stdin !== undefined ? Buffer.from(spec.stdin) : undefined)
    const collect = (text: string): CollectedOutput => ({ text, truncated: false })
    return {
      exitCode: result.code,
      signal: (result.signal ?? null) as NodeJS.Signals | null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: collect(result.stdout),
      stderr: collect(result.stderr),
    } as unknown as ShellRunResult
  }

  start(spec: ShellExecSpec): ShellProcess {
    const promise = this.run(spec)
    const proc: ShellProcess = {
      pid: -1,
      done: promise,
      kill: () => {
        void promise
      },
    } as unknown as ShellProcess
    return proc
  }
}

export class SshSubprocessRuntime {
  constructor(private readonly executor: SshExecutor) {}

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const promise = this.executor.exec(spec.argv as string[], spec.cwd, (spec.env ?? {}) as Record<string, string>)
    const handle: SubprocessHandle = {
      pid: -1,
      done: promise.then((r) => ({ exitCode: r.code, signal: (r.signal ?? null) as NodeJS.Signals | null })),
      kill: () => {
        void promise
      },
    } as unknown as SubprocessHandle
    return handle
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const pty = await this.executor.pty(spec.argv as string[], spec.cwd, (spec.env ?? {}) as Record<string, string>, (spec as { cols?: number }).cols ?? 80, (spec as { rows?: number }).rows ?? 24)
    const handle: SubprocessTerminalHandle = {
      write: (data: string) => pty.channel.stdin.write(data),
      resize: (cols: number, rows: number) => pty.resize(cols, rows),
      onData: (cb: (data: string) => void) => pty.onData((chunk) => cb(chunk.toString('utf8'))),
      kill: () => pty.kill(),
    } as unknown as SubprocessTerminalHandle
    return handle
  }
}
