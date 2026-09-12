import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome, FsDirEntry, FsInfo, FsPathInfo } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { sharedWorldResolver } from './resolve.js'

export function decorateFileSystem(fs: FileSystem): () => void {
  const resolver = sharedWorldResolver()

  const origStat = fs.stat.bind(fs)
  const origLstat = fs.lstat.bind(fs)
  const origReadText = fs.readText.bind(fs)
  const origStreamText = fs.streamText.bind(fs)
  const origReadBytes = fs.readBytes.bind(fs)
  const origListDir = fs.listDir.bind(fs)
  const origWriteText = fs.writeText.bind(fs)
  const origEditText = fs.editText.bind(fs)

  function targetPath(target: FsTarget): string {
    return fs.processPath(target)
  }

  fs.stat = async (target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> => {
    const ref = resolver.resolve(targetPath(target))
    if (ref.kind === 'local') return origStat(target, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.fs.stat(ref.remotePath, signal) as Promise<FsInfo | undefined>
  }

  fs.lstat = async (path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> => {
    const ref = resolver.resolve(path)
    if (ref.kind === 'local') return origLstat(path, opts, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.fs.lstat(ref.remotePath, opts, signal) as Promise<FsPathInfo | undefined>
  }

  fs.readText = async (target: FsTarget, signal?: AbortSignal): Promise<string> => {
    const ref = resolver.resolve(targetPath(target))
    if (ref.kind === 'local') return origReadText(target, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.fs.readText(ref.remotePath, signal)
  }

  fs.streamText = async (target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> => {
    const ref = resolver.resolve(targetPath(target))
    if (ref.kind === 'local') return origStreamText(target, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.fs.streamText(ref.remotePath, signal)
  }

  fs.readBytes = async (target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> => {
    const ref = resolver.resolve(targetPath(target))
    if (ref.kind === 'local') return origReadBytes(target, signal, maxBytes)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.fs.readBytes(ref.remotePath, signal, maxBytes)
  }

  fs.listDir = async (target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> => {
    const ref = resolver.resolve(targetPath(target))
    if (ref.kind === 'local') return origListDir(target, signal)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.fs.listDir(ref.remotePath, signal) as Promise<FsDirEntry[]>
  }

  fs.writeText = async (target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome> => {
    const ref = resolver.resolve(targetPath(target))
    if (ref.kind === 'local') return origWriteText(target, content, expected, signal, sandboxPolicy)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.fs.writeText(ref.remotePath, content, expected, signal, sandboxPolicy) as Promise<FsWriteOutcome>
  }

  fs.editText = async (target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome> => {
    const ref = resolver.resolve(targetPath(target))
    if (ref.kind === 'local') return origEditText(target, edit, expected, signal, sandboxPolicy)
    if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)
    return ref.provider.fs.editText(ref.remotePath, edit, expected, signal, sandboxPolicy) as Promise<FsEditOutcome>
  }

  return () => {
    fs.stat = origStat
    fs.lstat = origLstat
    fs.readText = origReadText
    fs.streamText = origStreamText
    fs.readBytes = origReadBytes
    fs.listDir = origListDir
    fs.writeText = origWriteText
    fs.editText = origEditText
  }
}
