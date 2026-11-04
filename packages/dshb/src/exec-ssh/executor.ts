import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { encodeRunnerPayload, REMOTE_RUNNER_COMMAND, type RunnerPayload } from './runner.js'
import { toConnectionError, type SshConnection } from './connection.js'

export interface ExecResult {
  code: number
  signal?: string
  stdout: string
  stderr: string
}

const DEFAULT_OP_TIMEOUT_MS = 20_000

/**
 * Per-operation ceiling for one SSH round trip (channel open or SFTP request).
 * A frozen half-open connection would otherwise park every caller forever;
 * the guard rejects, invalidates the connection, and lets keepalive/reconnect
 * recover the world for subsequent operations.
 */
function sshOpTimeoutMs(): number {
  const raw = Number(process.env.DSHB_SSH_OP_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OP_TIMEOUT_MS
}

export class SshExecutor {
  private sftpCache: Promise<import('ssh2').SFTPWrapper> | null = null

  constructor(
    private readonly connection: SshConnection,
    private readonly nodeId = 'unknown',
    private readonly audit?: (op: string, target: string, result: string) => void,
  ) {}

  /**
   * Bound one SSH round trip by a timeout. On expiry the pooled connection is
   * invalidated (keepalive would also catch it, but the caller must not wait
   * that long) and the failure surfaces as a category-'timeout' connection
   * error instead of an ever-pending promise.
   */
  private async guard<T>(op: string, run: () => Promise<T>): Promise<T> {
    const ms = sshOpTimeoutMs()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.connection.invalidate()
        this.sftpCache = null
        reject(toConnectionError(new Error(`ssh operation timed out after ${ms}ms: ${op}`)))
      }, ms)
    })
    const underlying = run()
    // The loser of the race must not surface as an unhandled rejection later.
    underlying.catch(() => {})
    try {
      return await Promise.race([underlying, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async exec(argv: string[], cwd: string, env: Record<string, string> = {}, stdinData?: Buffer): Promise<ExecResult> {
    const client = await this.guard(`exec client: ${argv[0] ?? ''}`, () => this.connection.getClient())
    const payload: RunnerPayload = { argv, cwd, env }
    const body = encodeRunnerPayload(payload)
    const input = stdinData ? Buffer.concat([body, stdinData]) : body
    const channel = await this.guard(`exec channel: ${argv[0] ?? ''}`, () => new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
      client.exec(REMOTE_RUNNER_COMMAND, (err, opened) => {
        if (err) {
          reject(err)
          return
        }
        resolve(opened)
      })
    }))
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      channel.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      channel.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      channel.on('close', (code: number, signal: string) => {
        this.audit?.('exec', argv.join(' '), `code=${code ?? 0}`)
        resolve({
          code: code ?? 0,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      })
      channel.on('error', reject)
      channel.end(input)
    })
  }

  async sftp(): Promise<import('ssh2').SFTPWrapper> {
    if (this.sftpCache) return this.sftpCache
    const client = await this.guard('sftp client', () => this.connection.getClient())
    this.sftpCache = this.guard('sftp subsystem', () => new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) reject(err)
        else resolve(sftp)
      })
    })).catch((err) => {
      this.sftpCache = null
      throw err
    })
    return this.sftpCache
  }

  async readFile(path: string): Promise<Buffer> {
    const sftp = await this.sftp()
    return this.guard(`sftp readFile: ${path}`, () => new Promise((resolve, reject) => {
      sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data)))
    }))
  }

  async readFileRange(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0)
    return this.guard(`sftp readFileRange: ${path}`, () => this.readFileRangeInner(path, offset, length, signal))
  }

  private async readFileRangeInner(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    const sftp = await this.sftp()
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = sftp.createReadStream(path, { start: offset, end: offset + length - 1, autoClose: true })
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const abort = () => stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error('The operation was aborted'))
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      stream.once('error', (error: Error) => {
        cleanup()
        reject(error)
      })
      stream.once('end', () => {
        cleanup()
        resolve(Buffer.concat(chunks))
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    await this.guard(`sftp writeFile: ${path}`, () => this.writeFileInner(path, content))
  }

  private async writeFileInner(path: string, content: Buffer | string): Promise<void> {
    const sftp = await this.sftp()
    const tmp = `${path}.dshb-tmp-${process.pid}-${Date.now()}`
    return new Promise((resolve, reject) => {
      sftp.writeFile(tmp, content, (writeErr) => {
        if (writeErr) {
          reject(writeErr)
          return
        }
        sftp.ext_openssh_rename(tmp, path, (renameErr) => {
          if (renameErr) reject(renameErr)
          else {
            this.audit?.('write', path, 'ok')
            resolve()
          }
        })
      })
    })
  }

  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean; isFile: boolean; isSymlink: boolean; size: number; mtime: number }>> {
    const sftp = await this.sftp()
    return this.guard(`sftp readdir: ${path}`, () => new Promise((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) {
          reject(err)
          return
        }
        resolve(
          list.map((e) => ({
            name: e.filename,
            isDir: e.attrs.isDirectory(),
            isFile: e.attrs.isFile(),
            isSymlink: e.attrs.isSymbolicLink(),
            size: Number(e.attrs.size),
            mtime: e.attrs.mtime * 1000,
          })),
        )
      })
    }))
  }

  async stat(path: string): Promise<{ size: number; mtime: number; isDirectory: boolean; isFile: boolean } | undefined> {
    const sftp = await this.sftp()
    return this.guard(`sftp stat: ${path}`, () => new Promise((resolve) => {
      sftp.stat(path, (err, stats) => {
        if (err) {
          resolve(undefined)
          return
        }
        resolve({ size: Number(stats.size), mtime: stats.mtime * 1000, isDirectory: stats.isDirectory(), isFile: stats.isFile() })
      })
    }))
  }

  async lstat(path: string): Promise<{ size: number; mtime: number; isDirectory: boolean; isFile: boolean; isSymlink: boolean } | undefined> {
    const sftp = await this.sftp()
    return this.guard(`sftp lstat: ${path}`, () => new Promise((resolve) => {
      sftp.lstat(path, (err, stats) => {
        if (err) {
          resolve(undefined)
          return
        }
        resolve({
          size: Number(stats.size),
          mtime: stats.mtime * 1000,
          isDirectory: stats.isDirectory(),
          isFile: stats.isFile(),
          isSymlink: stats.isSymbolicLink(),
        })
      })
    }))
  }

  async mkdir(path: string): Promise<void> {
    const sftp = await this.sftp()
    return this.guard(`sftp mkdir: ${path}`, () => new Promise((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
    }))
  }

  async remove(path: string): Promise<void> {
    const sftp = await this.sftp()
    return this.guard(`sftp unlink: ${path}`, () => new Promise((resolve, reject) => {
      sftp.unlink(path, (err) => {
        if (err) reject(err)
        else {
          this.audit?.('remove', path, 'ok')
          resolve()
        }
      })
    }))
  }

  async rename(src: string, dest: string): Promise<void> {
    const sftp = await this.sftp()
    return this.guard(`sftp rename: ${src} -> ${dest}`, () => new Promise((resolve, reject) => {
      sftp.ext_openssh_rename(src, dest, (err) => {
        if (err) reject(err)
        else {
          this.audit?.('move', `${src} -> ${dest}`, 'ok')
          resolve()
        }
      })
    }))
  }

  async ensureRg(): Promise<void> {
    const result = await this.exec(['sh', '-c', 'command -v rg || echo "__DShB_RG_MISSING__"'], '/')
    if (result.stdout.includes('__DShB_RG_MISSING__')) {
      const localRg = process.env.DSHB_LOCAL_RG ?? findLocalRg()
      if (!localRg) return
      const remoteRgDir = '~/.dshb/bin'
      await this.exec(['mkdir', '-p', remoteRgDir], '/')
      const remoteRg = `${remoteRgDir}/rg`
      const content = readFileSync(localRg)
      await this.writeFile(remoteRg, content)
      await this.exec(['chmod', '+x', remoteRg], '/')
    }
  }

  async pty(argv: string[], cwd: string, env: Record<string, string>, cols: number, rows: number, terminalType = 'xterm-256color'): Promise<{ channel: import('ssh2').ClientChannel; resize: (cols: number, rows: number) => void; kill: () => void }> {
    const client = await this.guard(`pty client: ${argv[0] ?? ''}`, () => this.connection.getClient())
    const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
    const environment = Object.entries(env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid terminal environment key: ${key}`)
      return `${key}=${value}`
    })
    const command = `bash -c 'cd "$0" && exec env -i HOME="$HOME" PATH="\${PATH:-/usr/local/bin:/usr/bin:/bin}" "$@"' ${q(cwd)} ${[...environment, ...argv].map(q).join(' ')}`
    const channel = await this.guard('pty channel', () => new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
      client.exec(
        command,
        { pty: { cols, rows, term: terminalType } },
        (err, opened) => {
          if (err) {
            reject(err)
            return
          }
          resolve(opened)
        },
      )
    }))
    return {
      channel,
      resize: (c, r) => channel.setWindow(c, r, 0, 0),
      kill: () => channel.close(),
    }
  }
}

function findLocalRg(): string | undefined {
  const candidates = [
    join(homedir(), '.dsh', 'node_modules', '.bin', 'rg'),
    join(homedir(), '.dsh', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
    join(homedir(), 'go', 'bin', 'rg'),
    '/usr/local/bin/rg',
    '/usr/bin/rg',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return undefined
}
