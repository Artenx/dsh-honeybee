import type { DockerBackend } from './docker-backend.js'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'

export class DockerShellExecutor {
  constructor(private readonly client: DockerBackend) {}

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
    const result = await this.client.exec(['bash', '-c', spec.command], spec.workdir, (spec.env ?? {}) as Record<string, string>)
    return {
      exitCode: result.code,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
    } as unknown as ShellRunResult
  }

  start(spec: ShellExecSpec): ShellProcess {
    const promise = this.run(spec)
    return {
      pid: -1,
      done: promise,
      kill: () => {
        void promise
      },
    } as unknown as ShellProcess
  }
}

export class DockerSubprocessRuntime {
  constructor(private readonly client: DockerBackend) {}

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const promise = this.client.exec(spec.argv as string[], spec.cwd, (spec.env ?? {}) as Record<string, string>)
    const handle: SubprocessHandle = {
      pid: -1,
      done: promise.then((r) => ({ code: r.code, signal: null, stdout: r.stdout, stderr: r.stderr })),
      kill: () => {
        void promise
      },
    } as unknown as SubprocessHandle
    return handle
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const pty = await this.client.pty(spec.argv as string[], spec.cwd, (spec as { cols?: number }).cols ?? 80, (spec as { rows?: number }).rows ?? 24)
    const handle: SubprocessTerminalHandle = {
      write: (data: string) => pty.stream.write(data),
      resize: (cols: number, rows: number) => pty.resize(cols, rows),
      onData: (cb: (data: string) => void) => pty.stream.on('data', (chunk: Buffer) => cb(chunk.toString('utf8'))),
      kill: () => pty.kill(),
    } as unknown as SubprocessTerminalHandle
    return handle
  }
}
