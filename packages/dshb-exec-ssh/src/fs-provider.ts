import type { SshExecutor } from './executor.js'

export class SshFileSystem {
  constructor(private readonly executor: SshExecutor) {}

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

  async stat(target: string, _signal?: AbortSignal): Promise<{ size: number; mtime: number; isDirectory: boolean; isFile: boolean } | undefined> {
    return this.executor.stat(target)
  }

  async lstat(path: string, _opts?: { cwd?: string }, _signal?: AbortSignal): Promise<{ size: number; mtime: number; isDirectory: boolean; isFile: boolean } | undefined> {
    return this.executor.stat(path)
  }

  async readText(target: string, _signal?: AbortSignal): Promise<string> {
    const data = await this.executor.readFile(target)
    return data.toString('utf8')
  }

  async streamText(target: string, _signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const data = await this.executor.readFile(target)
    const text = data.toString('utf8')
    return (async function* () {
      yield text
    })()
  }

  async readBytes(target: string, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const data = await this.executor.readFile(target)
    const slice = data.subarray(0, maxBytes)
    return new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength)
  }

  async listDir(target: string, _signal?: AbortSignal): Promise<Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean; size: number; mtime: number }>> {
    const entries = await this.executor.listDir(target)
    return entries.map((e) => ({
      name: e.name,
      path: `${target}/${e.name}`,
      isDirectory: e.isDir,
      isFile: e.isFile,
      isSymlink: e.isSymlink,
      size: e.size,
      mtime: e.mtime,
    }))
  }

  async writeText(target: string, content: string, _expected?: unknown, _signal?: AbortSignal, _policy?: unknown): Promise<{ ok: true }> {
    await this.executor.writeFile(target, content)
    return { ok: true }
  }

  async editText(target: string, edit: unknown, _expected?: unknown, _signal?: AbortSignal, _policy?: unknown): Promise<{ ok: true }> {
    const current = await this.executor.readFile(target).then((d) => d.toString('utf8'))
    const req = edit as { search?: string; replace?: string }
    const next = current.replace(String(req.search ?? ''), String(req.replace ?? ''))
    await this.executor.writeFile(target, next)
    return { ok: true }
  }
}
