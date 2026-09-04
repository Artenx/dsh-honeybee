import type { DockerBackend } from './docker-backend.js'

interface SshExecutorLike {
  exec(argv: string[], cwd: string, env?: Record<string, string>, stdinData?: Buffer): Promise<{ code: number; stdout: string; stderr: string }>
}

export class RemoteDockerCli implements DockerBackend {
  constructor(
    private readonly ssh: SshExecutorLike,
    private readonly containerId: string,
  ) {}

  async exec(argv: string[], cwd: string, env: Record<string, string> = {}, stdinData?: Buffer): Promise<{ code: number; stdout: string; stderr: string }> {
    const envFlags = Object.entries(env).map(([k, v]) => ['-e', `${k}=${v}`]).flat()
    return this.ssh.exec(['docker', 'exec', '-w', cwd, ...envFlags, this.containerId, ...argv], '/', {}, stdinData)
  }

  async execShell(command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.ssh.exec(['docker', 'exec', '-w', cwd, this.containerId, 'bash', '-c', command], '/')
  }

  async readFile(path: string): Promise<Buffer> {
    const result = await this.ssh.exec(['docker', 'exec', this.containerId, 'cat', path], '/')
    return Buffer.from(result.stdout, 'utf8')
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const b64 = data.toString('base64')
    await this.ssh.exec(['docker', 'exec', this.containerId, 'bash', '-c', `printf '%s' '${b64}' | base64 -d > '${path.replace(/'/g, "'\\''")}'`], '/')
  }

  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean; isFile: boolean; isSymlink: boolean; size: number; mtime: number }>> {
    const result = await this.ssh.exec(['docker', 'exec', this.containerId, 'ls', '-1pa', '--time-style=+%s', path], '/')
    return result.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const name = line.replace(/[/@*]$/, '').trim()
        if (!name) return null
        const isDir = line.endsWith('/')
        const isSymlink = line.endsWith('@')
        return { name, isDir, isFile: !isDir && !isSymlink, isSymlink, size: 0, mtime: 0 }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
  }

  async stat(path: string): Promise<{ size: number; mtime: number; isDirectory: boolean; isFile: boolean } | undefined> {
    const result = await this.ssh.exec(['docker', 'exec', this.containerId, 'stat', '-c', '%s %Y %F', path], '/')
    const line = result.stdout.trim()
    if (!line) return undefined
    const parts = line.split(/\s+/)
    if (parts.length < 3) return undefined
    const size = Number(parts[0])
    const mtime = Number(parts[1]) * 1000
    const ftype = parts.slice(2).join(' ')
    return { size, mtime, isDirectory: ftype.includes('directory'), isFile: ftype.includes('regular') }
  }

  async mkdir(path: string): Promise<void> {
    await this.ssh.exec(['docker', 'exec', this.containerId, 'mkdir', '-p', path], '/')
  }

  async remove(path: string): Promise<void> {
    await this.ssh.exec(['docker', 'exec', this.containerId, 'rm', '-f', path], '/')
  }

  async rename(src: string, dest: string): Promise<void> {
    await this.ssh.exec(['docker', 'exec', this.containerId, 'mv', src, dest], '/')
  }

  async ensureRg(): Promise<void> {
    const result = await this.ssh.exec(['docker', 'exec', this.containerId, 'bash', '-c', 'command -v rg || echo __missing__'], '/')
    if (result.stdout.includes('__missing__')) {
      await this.ssh.exec(['docker', 'exec', this.containerId, 'bash', '-c', 'apk add --no-cache ripgrep 2>/dev/null || apt-get install -y ripgrep 2>/dev/null || true'], '/')
    }
  }

  async pty(argv: string[], cwd: string, cols: number, rows: number): Promise<{ stream: NodeJS.ReadWriteStream; resize: (c: number, r: number) => void; kill: () => void }> {
    throw new Error('remote docker PTY not yet supported')
  }
}
