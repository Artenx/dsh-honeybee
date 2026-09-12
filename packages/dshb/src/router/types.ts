import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessRuntime, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'

export interface NodeTestReport {
  ok: boolean
  reachable?: boolean
  error?: string
}

export interface FsDelegate {
  resolve(path: string, opts?: { cwd?: string }): Promise<FsTargetLike>
  processPath(target: FsTargetLike): string
  fileUrl(target: FsTargetLike): string
  contains(parent: FsTargetLike, child: FsTargetLike): boolean
  stat(target: FsTargetLike, signal?: AbortSignal): Promise<unknown>
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<unknown>
  readText(target: FsTargetLike, signal?: AbortSignal): Promise<string>
  streamText(target: FsTargetLike, signal?: AbortSignal): Promise<AsyncIterable<string>>
  readBytes(target: FsTargetLike, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  listDir(target: FsTargetLike, signal?: AbortSignal): Promise<unknown[]>
  writeText(target: FsTargetLike, content: string, expected?: unknown, signal?: AbortSignal, policy?: unknown): Promise<unknown>
  editText(target: FsTargetLike, edit: unknown, expected?: unknown, signal?: AbortSignal, policy?: unknown): Promise<unknown>
}

export type FsTargetLike = string

export interface SubprocessDelegate {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}

export interface ShellDelegate {
  resolve(request: ShellExecRequest): ShellExecSpec
  run(spec: ShellExecSpec): Promise<ShellRunResult>
  start(spec: ShellExecSpec): ShellProcess
}

export interface ExecutionWorldProvider {
  readonly nodeId: string
  readonly fs: FsDelegate
  readonly subprocess: SubprocessDelegate
  readonly shell: ShellDelegate
  ensureDir(remotePath: string): Promise<void>
  testConnection(): Promise<NodeTestReport>
}

export interface WorkspaceBindings {
  resolve(mirrorPath: string): { nodeId: string; remotePath: string } | undefined
}

export interface WorldRegistry {
  get(nodeId: string): ExecutionWorldProvider | undefined
}

export type WorldRef =
  | { kind: 'local' }
  | { kind: 'remote'; provider: ExecutionWorldProvider; remotePath: string }
  | { kind: 'unrouted'; nodeId: string }

export type { FileSystem, SubprocessRuntime }
export type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec }
export type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult }
