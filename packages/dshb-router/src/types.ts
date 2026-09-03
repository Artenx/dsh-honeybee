import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'

export interface NodeTestReport {
  ok: boolean
  reachable?: boolean
  error?: string
}

export interface ExecutionWorldProvider {
  readonly nodeId: string
  readonly fs: FileSystem
  readonly subprocess: SubprocessRuntime
  readonly shell: ShellExecutor
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
