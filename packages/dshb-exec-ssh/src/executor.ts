import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { encodeRunnerPayload, REMOTE_RUNNER_COMMAND, type RunnerPayload } from './runner.js'
import type { SshConnection } from './connection.js'

export interface ExecResult {
  code: number
  signal?: string
  stdout: string
  stderr: string
}

export class SshExecutor {
  private sftpCache: Promise<import('ssh2').SFTPWrapper> | null = null

  constructor(private readonly connection: SshConnection) {}

  async exec(argv: string[], cwd: string, env: Record<string, string> = {}, stdinData?: Buffer): Promise<ExecResult> {
    const client = await this.connection.getClient()
    const payload: RunnerPayload = { argv, cwd, env }
    const body = encodeRunnerPayload(payload)
    const input = stdinData ? Buffer.concat([body, stdinData]) : body
    return new Promise((resolve, reject) => {
      client.exec(REMOTE_RUNNER_COMMAND, (err, channel) => {
        if (err) {
          reject(err)
          return
        }
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        channel.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        channel.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        channel.on('close', (code: number, signal: string) => {
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
    })
  }

  async sftp(): Promise<import('ssh2').SFTPWrapper> {
    if (this.sftpCache) return this.sftpCache
    const client = await this.connection.getClient()
    this.sftpCache = new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) reject(err)
        else resolve(sftp)
      })
    })
    return this.sftpCache
  }

  async readFile(path: string): Promise<Buffer> {
    const sftp = await this.sftp()
    return new Promise((resolve, reject) => {
      sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data)))
    })
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
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
          else resolve()
        })
      })
    })
  }

  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean; isFile: boolean; isSymlink: boolean; size: number; mtime: number }>> {
    const sftp = await this.sftp()
    return new Promise((resolve, reject) => {
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
    })
  }

  async stat(path: string): Promise<{ size: number; mtime: number; isDirectory: boolean; isFile: boolean } | undefined> {
    const sftp = await this.sftp()
    return new Promise((resolve) => {
      sftp.stat(path, (err, stats) => {
        if (err) {
          resolve(undefined)
          return
        }
        resolve({ size: Number(stats.size), mtime: stats.mtime * 1000, isDirectory: stats.isDirectory(), isFile: stats.isFile() })
      })
    })
  }

  async mkdir(path: string): Promise<void> {
    const sftp = await this.sftp()
    return new Promise((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
    })
  }

  async remove(path: string): Promise<void> {
    const sftp = await this.sftp()
    return new Promise((resolve, reject) => {
      sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
    })
  }

  async rename(src: string, dest: string): Promise<void> {
    const sftp = await this.sftp()
    return new Promise((resolve, reject) => {
      sftp.ext_openssh_rename(src, dest, (err) => (err ? reject(err) : resolve()))
    })
  }

  async ensureRg(): Promise<void> {
    const result = await this.exec(['sh', '-c', 'command -v rg || echo "__DShB_RG_MISSING__"'], '~')
    if (result.stdout.includes('__DShB_RG_MISSING__')) {
      const localRg = process.env.DSHB_LOCAL_RG ?? findLocalRg()
      if (!localRg) return
      const remoteRgDir = '~/.dshb/bin'
      await this.exec(['mkdir', '-p', remoteRgDir], '~')
      const remoteRg = `${remoteRgDir}/rg`
      const content = readFileSync(localRg)
      await this.writeFile(remoteRg, content)
      await this.exec(['chmod', '+x', remoteRg], '~')
    }
  }

  async pty(argv: string[], cwd: string, env: Record<string, string>, cols: number, rows: number): Promise<{ channel: import('ssh2').ClientChannel; onData: (cb: (chunk: Buffer) => void) => void; resize: (cols: number, rows: number) => void; kill: () => void }> {
    const client = await this.connection.getClient()
    const payload = encodeRunnerPayload({ argv, cwd, env })
    return new Promise((resolve, reject) => {
      client.exec(
        REMOTE_RUNNER_COMMAND,
        { pty: { cols, rows, term: 'xterm-256color' } },
        (err, channel) => {
          if (err) {
            reject(err)
            return
          }
          channel.end(payload)
          resolve({
            channel,
            onData: (cb) => channel.on('data', cb),
            resize: (c, r) => channel.setWindow(c, r, 0, 0),
            kill: () => channel.close(),
          })
        },
      )
    })
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
