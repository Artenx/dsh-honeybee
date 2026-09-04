import { describe, expect, it } from 'vitest'
import { provisionContainer, listContainers } from '../src/provision.js'
import type { HostCommandRunner } from '../src/docker-backend.js'

describe('供给失败清理属性（设计正确性属性 7，需求 5.6）', () => {
  it('拉取失败时抛错', async () => {
    const runner: HostCommandRunner = {
      run: async () => ({ code: 1, stdout: '', stderr: 'pull error' }),
    }
    await expect(provisionContainer(runner, { image: 'nonexistent:latest' })).rejects.toThrow('镜像拉取失败')
  })

  it('创建失败时抛错', async () => {
    const runner: HostCommandRunner = {
      run: async (argv) => {
        if (argv[1] === 'inspect' && argv.some((a) => typeof a === 'string' && a.includes('{{.Id}}'))) return { code: 1, stdout: '', stderr: 'no such container' }
        if (argv[1] === 'pull') return { code: 0, stdout: '', stderr: '' }
        if (argv[1] === 'run') return { code: 1, stdout: '', stderr: 'create error' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    await expect(provisionContainer(runner, { image: 'alpine:latest' })).rejects.toThrow('容器创建失败')
  })

  it('启动超时时抛错', async () => {
    const runner: HostCommandRunner = {
      run: async (argv) => {
        if (argv[1] === 'inspect' && argv.some((a) => typeof a === 'string' && a.includes('{{.Id}}'))) return { code: 1, stdout: '', stderr: 'no such container' }
        if (argv[1] === 'pull') return { code: 0, stdout: '', stderr: '' }
        if (argv[1] === 'run') return { code: 0, stdout: 'fake-id', stderr: '' }
        if (argv[1] === 'inspect') return { code: 0, stdout: 'false', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    await expect(provisionContainer(runner, { image: 'alpine:latest' }, undefined, 2000)).rejects.toThrow('超时')
  })

  it('成功时返回 containerId 与 name', async () => {
    const runner: HostCommandRunner = {
      run: async (argv) => {
        if (argv[1] === 'inspect' && argv.some((a) => typeof a === 'string' && a.includes('{{.Id}}'))) return { code: 1, stdout: '', stderr: 'no such container' }
        if (argv[1] === 'pull') return { code: 0, stdout: '', stderr: '' }
        if (argv[1] === 'run') return { code: 0, stdout: 'abc123def\n', stderr: '' }
        if (argv[1] === 'inspect') return { code: 0, stdout: 'true\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const result = await provisionContainer(runner, { image: 'alpine:latest', cpus: 2, memoryMB: 512 })
    expect(result.containerId).toBe('abc123def')
    expect(result.name).toMatch(/^dshb-/)
  })

  it('容器已存在且运行中时直接返回', async () => {
    const runner: HostCommandRunner = {
      run: async (argv) => {
        if (argv[1] === 'inspect' && argv.some((a) => typeof a === 'string' && a.includes('{{.Id}}'))) return { code: 0, stdout: 'existing-id\ttrue', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const result = await provisionContainer(runner, { image: 'alpine:latest', name: 'dshb-existing' })
    expect(result.containerId).toBe('existing-id')
    expect(result.name).toBe('dshb-existing')
  })

  it('容器已存在但已停止时自动启动', async () => {
    const startCalled: string[][] = []
    const runner: HostCommandRunner = {
      run: async (argv) => {
        if (argv[1] === 'inspect' && argv.some((a) => typeof a === 'string' && a.includes('{{.Id}}'))) return { code: 0, stdout: 'existing-id\tfalse', stderr: '' }
        if (argv[1] === 'start') { startCalled.push(argv); return { code: 0, stdout: 'existing-id', stderr: '' } }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const result = await provisionContainer(runner, { image: 'alpine:latest', name: 'dshb-stopped' })
    expect(result.containerId).toBe('existing-id')
    expect(startCalled.length).toBe(1)
  })

  it('资源参数传入 docker run', async () => {
    const calls: string[][] = []
    const runner: HostCommandRunner = {
      run: async (argv) => {
        calls.push(argv)
        if (argv[1] === 'inspect' && argv.some((a) => typeof a === 'string' && a.includes('{{.Id}}'))) return { code: 1, stdout: '', stderr: 'no such container' }
        if (argv[1] === 'pull') return { code: 0, stdout: '', stderr: '' }
        if (argv[1] === 'run') return { code: 0, stdout: 'id\n', stderr: '' }
        if (argv[1] === 'inspect') return { code: 0, stdout: 'true\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    await provisionContainer(runner, { image: 'alpine:latest', cpus: 4, memoryMB: 1024 })
    const runCall = calls.find((c) => c[1] === 'run')
    expect(runCall).toBeDefined()
    expect(runCall!.join(' ')).toContain('--cpus 4')
    expect(runCall!.join(' ')).toContain('-m 1024m')
  })

  it('listContainers 解析 docker ps 输出', async () => {
    const runner: HostCommandRunner = {
      run: async () => ({ code: 0, stdout: 'abc\tmy-container\tUp 2 minutes\talpine:latest\ndef\tother\tExited\tnginx\n', stderr: '' }),
    }
    const containers = await listContainers(runner)
    expect(containers.length).toBe(2)
    expect(containers[0].id).toBe('abc')
    expect(containers[0].name).toBe('my-container')
    expect(containers[0].image).toBe('alpine:latest')
  })

  it('listContainers 错误时返回空', async () => {
    const runner: HostCommandRunner = {
      run: async () => ({ code: 1, stdout: '', stderr: 'error' }),
    }
    expect(await listContainers(runner)).toEqual([])
  })
})
