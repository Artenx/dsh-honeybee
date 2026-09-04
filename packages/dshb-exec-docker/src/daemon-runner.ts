import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { HostCommandRunner } from './docker-backend.js'

const execFileAsync = promisify(execFile)

export interface DaemonRequest {
  (method: string, path: string, body?: string): Promise<{ status: number; body: Buffer }>
}

interface DaemonTarget {
  socketPath?: string
  host?: string
  port?: number
  tls?: boolean
}

export function parseDaemonHost(env: NodeJS.ProcessEnv = process.env): DaemonTarget {
  const raw = env.DOCKER_HOST
  if (!raw) return { socketPath: '/var/run/docker.sock' }
  if (raw.startsWith('unix://')) return { socketPath: raw.slice('unix://'.length) }
  if (raw.startsWith('tcp://') || raw.startsWith('http://') || raw.startsWith('https://')) {
    const u = new URL(raw.startsWith('tcp://') ? `http://${raw.slice('tcp://'.length)}` : raw)
    return { host: u.hostname || '127.0.0.1', port: Number(u.port) || (u.protocol === 'https:' ? 2376 : 2375), tls: u.protocol === 'https:' }
  }
  return { socketPath: raw }
}

function makeDaemonRequest(target: DaemonTarget): DaemonRequest {
  if (target.socketPath) {
    return (method, path, body) =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ method, path, socketPath: target.socketPath as string, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
          res.on('error', reject)
        })
        req.on('error', reject)
        if (body) req.write(body)
        req.end()
      })
  }
  const mod = target.tls ? httpsRequest : httpRequest
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const req = mod({ method, hostname: target.host, port: target.port, path, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
}

function bytesOf(value: string): number {
  const m = /^(\d+)([bkmg]?)$/i.exec(value.trim())
  if (!m) return NaN
  const n = Number(m[1])
  const unit = (m[2] || 'b').toLowerCase()
  const mult: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }
  return n * mult[unit]
}

function fmtInspect(json: { Id?: string; State?: { Running?: boolean } }, fmt: string): string {
  if (fmt === '{{.State.Running}}') return json.State?.Running ? 'true' : 'false'
  if (fmt === '{{.Id}}\t{{.State.Running}}') return `${json.Id ?? ''}\t${json.State?.Running ? 'true' : 'false'}`
  return ''
}

async function cliFallback(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), { maxBuffer: 10 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)) }
  }
}

export function buildEngineRunner(request: DaemonRequest): HostCommandRunner {
  const call = async (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const sub = argv[1]
    try {
      switch (sub) {
        case 'info': {
          const res = await request('GET', '/version')
          if (res.status !== 200) return { code: 1, stdout: '', stderr: res.body.toString('utf8') }
          const data = JSON.parse(res.body.toString('utf8')) as { Version?: string }
          return { code: 0, stdout: `${data.Version ?? ''}\n`, stderr: '' }
        }
        case 'pull': {
          const image = argv.slice(2).find((a) => !a.startsWith('-'))
          if (!image) return { code: 1, stdout: '', stderr: 'docker pull: image required' }
          const res = await request('POST', `/images/create?fromImage=${encodeURIComponent(image)}`)
          if (res.status < 200 || res.status >= 300) {
            let msg = res.body.toString('utf8')
            try {
              msg = (JSON.parse(msg) as { message?: string }).message ?? msg
            } catch {}
            return { code: 1, stdout: '', stderr: `镜像拉取失败: ${msg.trim()}` }
          }
          return { code: 0, stdout: '', stderr: '' }
        }
        case 'run': {
          let name: string | undefined
          let cpus: number | undefined
          let memory: number | undefined
          let image: string | undefined
          let i = 2
          for (; i < argv.length; i++) {
            const tok = argv[i]
            const take = (v: string): string | undefined => {
              const eq = v.indexOf('=')
              return eq === -1 ? undefined : v.slice(eq + 1)
            }
            const val = (k: string): string | undefined => (i + 1 < argv.length ? argv[++i] : undefined)
            if (tok === '-d') continue
            if (tok === '--name' || tok.startsWith('--name=')) {
              name = tok.startsWith('--name=') ? take(tok) : val(tok)
              continue
            }
            if (tok === '--cpus' || tok.startsWith('--cpus=')) {
              const v = tok.startsWith('--cpus=') ? take(tok) : val(tok)
              cpus = v ? Math.round(Number(v) * 1e9) : undefined
              continue
            }
            if (tok === '-m' || tok === '--memory' || tok.startsWith('-m=') || tok.startsWith('--memory=')) {
              const v = tok.startsWith('=') ? take(tok) : tok.startsWith('-m=') ? take(tok) : tok.startsWith('--memory=') ? take(tok) : val(tok)
              memory = v ? bytesOf(v) : undefined
              continue
            }
            if (!tok.startsWith('-')) {
              image = tok
              i += 1
              break
            }
          }
          if (!image) return { code: 1, stdout: '', stderr: 'docker run: image required' }
          const cmd = argv.slice(i)
          const createPath = `/containers/create${name ? `?name=${encodeURIComponent(name)}` : ''}`
          const hostConfig: Record<string, unknown> = {}
          if (cpus !== undefined && Number.isFinite(cpus)) hostConfig.NanoCpus = cpus
          if (memory !== undefined && Number.isFinite(memory) && memory > 0) hostConfig.Memory = memory
          const createRes = await request('POST', createPath, JSON.stringify({ Image: image, Cmd: cmd, HostConfig: hostConfig }))
          const createBody = createRes.body.toString('utf8')
          if (createRes.status < 200 || createRes.status >= 300) {
            let msg = createBody
            try {
              msg = (JSON.parse(msg) as { message?: string }).message ?? msg
            } catch {}
            return { code: 1, stdout: '', stderr: `容器创建失败: ${msg.trim()}` }
          }
          const containerId = (JSON.parse(createBody) as { Id?: string }).Id ?? ''
          if (!containerId) return { code: 1, stdout: '', stderr: '容器创建失败：无容器 ID' }
          const startRes = await request('POST', `/containers/${containerId}/start`)
          if (startRes.status >= 200 && startRes.status < 300) return { code: 0, stdout: `${containerId}\n`, stderr: '' }
          return { code: 1, stdout: '', stderr: `容器启动失败: ${startRes.body.toString('utf8').trim()}` }
        }
        case 'inspect': {
          const fmtIdx = argv.indexOf('--format')
          if (fmtIdx === -1 || fmtIdx + 1 >= argv.length) return cliFallback(argv)
          const fmt = argv[fmtIdx + 1]
          const ref = argv[argv.length - 1]
          const res = await request('GET', `/containers/${encodeURIComponent(ref)}/json`)
          if (res.status === 404) return { code: 1, stdout: '', stderr: `Error: No such container: ${ref}` }
          if (res.status !== 200) return { code: 1, stdout: '', stderr: res.body.toString('utf8') }
          const json = JSON.parse(res.body.toString('utf8')) as { Id?: string; State?: { Running?: boolean } }
          const out = fmtInspect(json, fmt)
          if (out === '' && fmt !== '{{.Id}}\t{{.State.Running}}' && fmt !== '{{.State.Running}}') return cliFallback(argv)
          return { code: 0, stdout: `${out}\n`, stderr: '' }
        }
        case 'ps': {
          const res = await request('GET', '/containers/json')
          if (res.status !== 200) return { code: 1, stdout: '', stderr: res.body.toString('utf8') }
          const items = JSON.parse(res.body.toString('utf8')) as Array<{ Id?: string; Names?: string[]; Status?: string; Image?: string }>
          const lines = items.map((c) => {
            const names = (c.Names ?? []).map((n) => n.replace(/^\//, '')).join(',')
            return `${c.Id ?? ''}\t${names}\t${c.Status ?? ''}\t${c.Image ?? ''}`
          })
          return { code: 0, stdout: lines.length ? `${lines.join('\n')}\n` : '', stderr: '' }
        }
        case 'rm': {
          const force = argv.includes('-f')
          const ref = argv[argv.length - 1]
          const res = await request('DELETE', `/containers/${encodeURIComponent(ref)}?force=${force ? '1' : '0'}`)
          if (res.status === 204 || res.status === 200) return { code: 0, stdout: '', stderr: '' }
          return { code: 1, stdout: '', stderr: res.body.toString('utf8') }
        }
        case 'start':
        case 'stop':
        case 'restart': {
          const ref = argv[argv.length - 1]
          const res = await request('POST', `/containers/${encodeURIComponent(ref)}/${sub}`)
          if (res.status === 204 || res.status === 304) return { code: 0, stdout: '', stderr: '' }
          return { code: 1, stdout: '', stderr: res.body.toString('utf8') }
        }
        default:
          return cliFallback(argv)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (sub === 'run') return { code: 1, stdout: '', stderr: `容器创建失败: ${msg}` }
      if (sub === 'pull') return { code: 1, stdout: '', stderr: `镜像拉取失败: ${msg}` }
      if (sub === 'inspect') return { code: 1, stdout: '', stderr: `无法访问 Docker daemon: ${msg}` }
      return { code: 1, stdout: '', stderr: `Docker daemon 不可用: ${msg}` }
    }
  }
  return { run: call }
}

export function dockerDaemonRunner(env: NodeJS.ProcessEnv = process.env): HostCommandRunner {
  return buildEngineRunner(makeDaemonRequest(parseDaemonHost(env)))
}

export function bytesOfForTest(value: string): number {
  return bytesOf(value)
}
