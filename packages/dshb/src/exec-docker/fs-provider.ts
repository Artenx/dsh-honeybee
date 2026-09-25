import type { DockerBackend } from './docker-backend.js'
import { FsVersion, type FsInfo, type FsPathInfo } from '@deepseek-ai/dsh-fs'

function versionOf(info: { size: number; mtime: number; isDirectory: boolean; isFile: boolean; isSymlink?: boolean }): FsInfo['version'] {
  const type = info.isDirectory ? 'directory' : info.isFile ? 'file' : info.isSymlink ? 'symlink' : 'other'
  return FsVersion(`${type}:${info.size}:${info.mtime}`)
}

export class DockerFileSystem {
  constructor(private readonly client: DockerBackend) {}

  async resolve(path: string): Promise<string> {
    return path
  }

  processPath(target: string): string {
    return target
  }

  fileUrl(target: string): string {
    return `file://${target}`
  }

  contains(parent: string, child: string): boolean {
    return child === parent || child.startsWith(`${parent}/`)
  }

  async stat(target: string, _signal?: AbortSignal): Promise<FsInfo | undefined> {
    const info = await this.client.stat(target)
    if (!info) return undefined
    return {
      version: versionOf(info),
      type: info.isDirectory ? 'directory' : info.isFile ? 'file' : 'other',
      size: info.size,
    }
  }

  async lstat(path: string, _opts?: { cwd?: string }, _signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const info = await this.client.lstat(path)
    if (!info) return undefined
    return {
      version: versionOf(info),
      type: info.isSymlink ? 'symlink' : info.isDirectory ? 'directory' : info.isFile ? 'file' : 'other',
      size: info.size,
    }
  }

  async readText(target: string, _signal?: AbortSignal): Promise<string> {
    const data = await this.client.readFile(target)
    return data.toString('utf8')
  }

  async streamText(target: string, _signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const data = await this.client.readFile(target)
    const text = data.toString('utf8')
    return (async function* () {
      yield text
    })()
  }

  async readBytes(target: string, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const data = await this.client.readFile(target)
    const slice = data.subarray(0, maxBytes)
    return new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength)
  }

  async readByteRange(target: string, range: { offset: number; length: number }, _signal?: AbortSignal): Promise<Uint8Array> {
    const data = await this.client.readFileRange(target, range.offset, range.length)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }

  async listDir(target: string, _signal?: AbortSignal): Promise<Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean; size: number; mtime: number }>> {
    const entries = await this.client.listDir(target)
    return entries.map((e) => ({
      name: e.name,
      path: `${target.replace(/\/+$/, '')}/${e.name}`,
      isDirectory: e.isDir,
      isFile: e.isFile,
      isSymlink: e.isSymlink,
      size: e.size,
      mtime: e.mtime,
    }))
  }

  async writeText(target: string, content: string, _expected?: unknown, _signal?: AbortSignal, _policy?: unknown): Promise<{ operation: 'create' | 'update'; version: string; before: string | null; after: string }> {
    const normalizeLf = (s: string) => s.replace(/\r\n/g, '\n')
    const beforeInfo = await this.client.stat(target)
    let before: string | null = null
    if (beforeInfo?.isFile) {
      try {
        before = normalizeLf((await this.client.readFile(target)).toString('utf8'))
      } catch {
        before = null
      }
    }
    const after = normalizeLf(content)
    await this.client.writeFile(target, content)
    const afterInfo = await this.client.stat(target)
    const version = `${afterInfo?.size ?? content.length}:${afterInfo?.mtime ?? Date.now()}`
    return { operation: before === null ? 'create' : 'update', version, before, after }
  }

  async editText(target: string, edit: unknown, _expected?: unknown, _signal?: AbortSignal, _policy?: unknown): Promise<{ version: string; before: string; after: string }> {
    const normalizeLf = (s: string) => s.replace(/\r\n/g, '\n')
    const before = normalizeLf((await this.client.readFile(target)).toString('utf8'))
    const req = edit as { oldString: string; newString: string; replaceAll: boolean }
    const oldString = normalizeLf(String(req.oldString ?? ''))
    if (oldString.length === 0) throw new Error('edit oldString must be non-empty')
    const newString = normalizeLf(String(req.newString ?? ''))
    const matches = before.split(oldString).length - 1
    if (matches === 0) throw new Error('edit oldString not found in file')
    if (!req.replaceAll && matches !== 1) throw new Error(`edit oldString matched ${matches} times; expected exactly one`)
    const after = req.replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString)
    await this.client.writeFile(target, after)
    const afterInfo = await this.client.stat(target)
    const version = `${afterInfo?.size ?? after.length}:${afterInfo?.mtime ?? Date.now()}`
    return { version, before, after }
  }
}
