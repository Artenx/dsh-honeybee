import { describe, expect, it } from 'vitest'
import { buildEngineRunner, bytesOfForTest, type DaemonRequest } from '../src/daemon-runner.js'

function scripted(routes: Array<{ match: (method: string, path: string) => boolean; status: number; body?: unknown }>): { request: DaemonRequest; calls: Array<{ method: string; path: string; body?: string }> } {
  const calls: Array<{ method: string; path: string; body?: string }> = []
  const request: DaemonRequest = async (method, path, body) => {
    calls.push({ method, path, body })
    const hit = routes.find((r) => r.match(method, path))
    if (!hit) return { status: 404, body: Buffer.from('not found') }
    return { status: hit.status, body: Buffer.from(hit.body !== undefined ? JSON.stringify(hit.body) : '') }
  }
  return { request, calls }
}

describe('bytesOf 内存单位解析', () => {
  it('按 1024 进制换算 b/k/m/g', () => {
    expect(bytesOfForTest('100')).toBe(100)
    expect(bytesOfForTest('512m')).toBe(512 * 1024 ** 2)
    expect(bytesOfForTest('2g')).toBe(2 * 1024 ** 3)
    expect(bytesOfForTest('8k')).toBe(8 * 1024)
  })
})

describe('daemon-runner docker CLI 翻译', () => {
  it('docker run 翻译为 create+start，携带资源与命令', async () => {
    const { request, calls } = scripted([
      { match: (m, p) => m === 'POST' && p.startsWith('/containers/create'), status: 201, body: { Id: 'abc123' } },
      { match: (m, p) => m === 'POST' && p === '/containers/abc123/start', status: 204 },
    ])
    const runner = buildEngineRunner(request)
    const res = await runner.run(['docker', 'run', '-d', '--name', 'dshb-x', '--cpus', '1', '-m', '512m', 'alpine:latest', 'sleep', 'infinity'])
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('abc123')
    const create = calls.find((c) => c.path.startsWith('/containers/create'))!
    expect(create.body).toBeTruthy()
    const payload = JSON.parse(create.body!) as { Image: string; Cmd: string[]; HostConfig: { NanoCpus: number; Memory: number } }
    expect(payload.Image).toBe('alpine:latest')
    expect(payload.Cmd).toEqual(['sleep', 'infinity'])
    expect(payload.HostConfig.NanoCpus).toBe(1e9)
    expect(payload.HostConfig.Memory).toBe(512 * 1024 ** 2)
  })

  it('docker inspect 输出 Id 与运行状态', async () => {
    const { request } = scripted([
      { match: (m, p) => m === 'GET' && p.endsWith('/json'), status: 200, body: { Id: 'ctr-1', State: { Running: true } } },
    ])
    const runner = buildEngineRunner(request)
    const res = await runner.run(['docker', 'inspect', '--format', '{{.Id}}\t{{.State.Running}}', 'ctr-1'])
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('ctr-1\ttrue')
  })

  it('docker inspect 容器不存在返回非 0', async () => {
    const { request } = scripted([{ match: () => true, status: 404 }])
    const runner = buildEngineRunner(request)
    const res = await runner.run(['docker', 'inspect', '--format', '{{.State.Running}}', 'missing'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('No such container')
  })

  it('docker info 返回版本', async () => {
    const { request } = scripted([{ match: (m, p) => m === 'GET' && p === '/version', status: 200, body: { Version: '24.0.7' } }])
    const runner = buildEngineRunner(request)
    const res = await runner.run(['docker', 'info', '--format', '{{.ServerVersion}}'])
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('24.0.7')
  })

  it('docker pull 失败透出 daemon 错误', async () => {
    const { request } = scripted([{ match: (m) => m === 'POST', status: 500, body: { message: 'pull access denied' } }])
    const runner = buildEngineRunner(request)
    const res = await runner.run(['docker', 'pull', 'nope/nope:nope'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('pull access denied')
  })

  it('docker ps 解析运行容器列表', async () => {
    const { request } = scripted([
      {
        match: (m, p) => m === 'GET' && p === '/containers/json',
        status: 200,
        body: [{ Id: 'a1', Names: ['/web'], Status: 'Up 2 seconds', Image: 'nginx:latest' }],
      },
    ])
    const runner = buildEngineRunner(request)
    const res = await runner.run(['docker', 'ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}'])
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('a1\tweb\tUp 2 seconds\tnginx:latest')
  })

  it('docker stop 对 304（已停止）视为成功', async () => {
    const { request } = scripted([{ match: () => true, status: 304 }])
    const runner = buildEngineRunner(request)
    const res = await runner.run(['docker', 'stop', 'ctr-1'])
    expect(res.code).toBe(0)
  })
})
