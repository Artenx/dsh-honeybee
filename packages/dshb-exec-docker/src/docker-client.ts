import { request } from 'node:http'
import type { DockerBackend } from './docker-backend.js'

const SOCKET = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') ?? '/var/run/docker.sock'

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

interface Demuxed {
  stdout: Buffer[]
  stderr: Buffer[]
}

function dockerRequest(method: string, path: string, body?: unknown): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { method, path, socketPath: SOCKET, headers: body ? { 'content-type': 'application/json' } : {} },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks),
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function demux(data: Buffer): Demuxed {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let pos = 0
  while (pos + 8 <= data.length) {
    const streamType = data[pos]
    const length = data.readUInt32BE(pos + 4)
    pos += 8
    if (pos + length > data.length) break
    const payload = data.subarray(pos, pos + length)
    pos += length
    if (streamType === 1) stdout.push(payload)
    else if (streamType === 2) stderr.push(payload)
  }
  return { stdout, stderr }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export class DockerClient implements DockerBackend {
  private readonly containerId: string

  constructor(containerId: string) {
    this.containerId = containerId
  }

  async ping(): Promise<boolean> {
    try {
      const res = await dockerRequest('GET', '/_ping')
      return res.statusCode === 200
    } catch {
      return false
    }
  }

  async inspect(): Promise<{ running: boolean; name: string } | undefined> {
    const res = await dockerRequest('GET', `/containers/${this.containerId}/json`)
    if (res.statusCode !== 200) return undefined
    const data = JSON.parse(res.body.toString('utf8'))
    return { running: data.State?.Running ?? false, name: data.Name ?? this.containerId }
  }

  async exec(argv: string[], cwd: string, env: Record<string, string> = {}, stdinData?: Buffer): Promise<ExecResult> {
    const createRes = await dockerRequest('POST', `/containers/${this.containerId}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: stdinData !== undefined,
      Tty: false,
      WorkingDir: cwd,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Cmd: argv,
    })
    if (createRes.statusCode !== 201) {
      const msg = createRes.body.toString('utf8')
      return { code: 126, stdout: '', stderr: `docker exec create failed: ${msg}` }
    }
    const execId = JSON.parse(createRes.body.toString('utf8')).Id
    if (!execId) return { code: 126, stdout: '', stderr: 'docker exec: no Id returned' }

    return new Promise<ExecResult>((resolve, reject) => {
      const req = request(
        {
          method: 'POST',
          path: `/exec/${execId}/start`,
          socketPath: SOCKET,
          headers: { 'content-type': 'application/json', connection: 'upgrade' },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const raw = Buffer.concat(chunks)
            const demuxed = demux(raw)
            const inspectReq = request(
              { method: 'GET', path: `/exec/${execId}/json`, socketPath: SOCKET },
              (inspectRes) => {
                const ichunks: Buffer[] = []
                inspectRes.on('data', (c: Buffer) => ichunks.push(c))
                inspectRes.on('end', () => {
                  let code = 0
                  try {
                    const info = JSON.parse(Buffer.concat(ichunks).toString('utf8'))
                    code = info.ExitCode ?? 0
                  } catch {}
                  resolve({
                    code,
                    stdout: Buffer.concat(demuxed.stdout).toString('utf8'),
                    stderr: Buffer.concat(demuxed.stderr).toString('utf8'),
                  })
                })
                inspectRes.on('error', () => resolve({ code: 0, stdout: Buffer.concat(demuxed.stdout).toString('utf8'), stderr: Buffer.concat(demuxed.stderr).toString('utf8') }))
              },
            )
            inspectReq.on('error', () => resolve({ code: 0, stdout: Buffer.concat(demuxed.stdout).toString('utf8'), stderr: Buffer.concat(demuxed.stderr).toString('utf8') }))
            inspectReq.end()
          })
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.write(JSON.stringify({ Detach: false, Tty: false }))
      if (stdinData) req.write(stdinData)
      req.end()
    })
  }

  async execShell(command: string, cwd: string): Promise<ExecResult> {
    return this.exec(['bash', '-c', command], cwd)
  }

  async readFile(path: string): Promise<Buffer> {
    const result = await this.exec(['cat', path], '/')
    return Buffer.from(result.stdout, 'utf8')
  }

  async writeFile(path: string, content: Buffer | string): Promise<void> {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const b64 = data.toString('base64')
    await this.execShell(`printf '%s' '${b64}' | base64 -d > ${shellQuote(path)}`, '/')
  }

  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean; isFile: boolean; isSymlink: boolean; size: number; mtime: number }>> {
    const result = await this.execShell(`ls -1pa --time-style=+%s ${shellQuote(path)} 2>/dev/null`, '/')
    return result.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const name = line.replace(/[/@*]$/, '').trim()
        if (!name) return null
        const isDir = line.endsWith('/')
        const isSymlink = line.endsWith('@')
        return {
          name,
          isDir,
          isFile: !isDir && !isSymlink,
          isSymlink,
          size: 0,
          mtime: 0,
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
  }

  async stat(path: string): Promise<{ size: number; mtime: number; isDirectory: boolean; isFile: boolean } | undefined> {
    const result = await this.execShell(`stat -c '%s %Y %F' ${shellQuote(path)} 2>/dev/null`, '/')
    const line = result.stdout.trim()
    if (!line) return undefined
    const parts = line.split(/\s+/)
    if (parts.length < 3) return undefined
    const size = Number(parts[0])
    const mtime = Number(parts[1]) * 1000
    const ftype = parts.slice(2).join(' ')
    return {
      size,
      mtime,
      isDirectory: ftype.includes('directory'),
      isFile: ftype.includes('regular file') || ftype.includes('regular empty file'),
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.exec(['mkdir', '-p', path], '/')
  }

  async remove(path: string): Promise<void> {
    await this.exec(['rm', '-f', path], '/')
  }

  async rename(src: string, dest: string): Promise<void> {
    await this.exec(['mv', src, dest], '/')
  }

  async pty(argv: string[], cwd: string, cols: number, rows: number): Promise<{ stream: NodeJS.ReadWriteStream; resize: (c: number, r: number) => void; kill: () => void }> {
    const createRes = await dockerRequest('POST', `/containers/${this.containerId}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Tty: true,
      WorkingDir: cwd,
      Cmd: argv,
    })
    if (createRes.statusCode !== 201) throw new Error('docker exec create failed')
    const execId = JSON.parse(createRes.body.toString('utf8')).Id

    return new Promise((resolve, reject) => {
      const req = request(
        {
          method: 'POST',
          path: `/exec/${execId}/start`,
          socketPath: SOCKET,
          headers: { 'content-type': 'application/json', connection: 'upgrade' },
        },
        (res) => {
          resolve({
            stream: res as unknown as NodeJS.ReadWriteStream,
            resize: (c: number, r: number) => {
              const r2 = request({ method: 'POST', path: `/exec/${execId}/resize?h=${r}&w=${c}`, socketPath: SOCKET }, () => {})
              r2.end()
            },
            kill: () => {
              res.destroy()
            },
          })
        },
      )
      req.on('error', reject)
      req.write(JSON.stringify({ Detach: false, Tty: true }))
      req.end()
    })
  }

  async ensureRg(): Promise<void> {
    const result = await this.execShell('command -v rg || echo __missing__', '/')
    if (result.stdout.includes('__missing__')) {
      await this.execShell('apk add --no-cache ripgrep 2>/dev/null || apt-get install -y ripgrep 2>/dev/null || true', '/')
    }
  }
}
