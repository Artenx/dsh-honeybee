import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import type { Context } from '@deepseek-ai/cordis'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome, FsDirEntry, FsInfo, FsPathInfo } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { sharedWorldResolver } from './resolve.js'

export default class RouterFileSystem extends SandboxedFileSystem {
  private readonly resolver = sharedWorldResolver()

  constructor(ctx: Context, config: unknown) {
    super(ctx, config as never)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const ref = this.resolver.resolve(this.processPath(target))
    if (ref.kind === 'local') return super.stat(target, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    const rt = await ref.provider.fs.resolve(ref.remotePath)
    return ref.provider.fs.stat(rt, signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const ref = this.resolver.resolve(path)
    if (ref.kind === 'local') return super.lstat(path, opts, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.fs.lstat(ref.remotePath, opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const ref = this.resolver.resolve(this.processPath(target))
    if (ref.kind === 'local') return super.readText(target, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    const rt = await ref.provider.fs.resolve(ref.remotePath)
    return ref.provider.fs.readText(rt, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const ref = this.resolver.resolve(this.processPath(target))
    if (ref.kind === 'local') return super.streamText(target, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    const rt = await ref.provider.fs.resolve(ref.remotePath)
    return ref.provider.fs.streamText(rt, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const ref = this.resolver.resolve(this.processPath(target))
    if (ref.kind === 'local') return super.readBytes(target, signal, maxBytes)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    const rt = await ref.provider.fs.resolve(ref.remotePath)
    return ref.provider.fs.readBytes(rt, signal, maxBytes)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const ref = this.resolver.resolve(this.processPath(target))
    if (ref.kind === 'local') return super.listDir(target, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    const rt = await ref.provider.fs.resolve(ref.remotePath)
    return ref.provider.fs.listDir(rt, signal)
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome> {
    const ref = this.resolver.resolve(this.processPath(target))
    if (ref.kind === 'local') return super.writeText(target, content, expected, signal, sandboxPolicy)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    const rt = await ref.provider.fs.resolve(ref.remotePath)
    return ref.provider.fs.writeText(rt, content, expected, signal, sandboxPolicy)
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome> {
    const ref = this.resolver.resolve(this.processPath(target))
    if (ref.kind === 'local') return super.editText(target, edit, expected, signal, sandboxPolicy)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    const rt = await ref.provider.fs.resolve(ref.remotePath)
    return ref.provider.fs.editText(rt, edit, expected, signal, sandboxPolicy)
  }
}
