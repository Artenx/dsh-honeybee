import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { SshSubprocessRuntime } from '../../src/exec-ssh/process-provider.js'

describe('SSH terminal shell discovery', () => {
  it('resolves shell candidates on the SSH host execution world', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '/bin/bash\n', stderr: '' }))
    const runtime = new SshSubprocessRuntime({ exec } as never)

    await expect(runtime.resolveExecutable('bash', { DSH_SESSION_ID: 'session-1' })).resolves.toBe('/bin/bash')
    expect(exec).toHaveBeenCalledWith(
      ['sh', '-c', 'command -v "$1"', 'sh', 'bash'],
      '/',
      { DSH_SESSION_ID: 'session-1' },
    )
  })

  it('identifies the SSH execution world as POSIX', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '/bin/bash\n', stderr: '' }))
    const runtime = new SshSubprocessRuntime({ exec } as never)
    await expect(runtime.terminalEnvironment()).resolves.toEqual({ platform: 'posix', defaultShell: '/bin/bash' })
    expect(exec).toHaveBeenCalledWith(['sh', '-c', expect.stringContaining('getent passwd')], '/')
  })
})

describe('SSH terminal subprocess contract', () => {
  it('exposes the DSH 0.1.7 terminal handle shape and settles on channel close', async () => {
    const channel = new PassThrough() as PassThrough & { stderr: PassThrough }
    channel.stderr = new PassThrough()
    channel.resume()
    const resize = vi.fn()
    const kill = vi.fn(() => channel.end())
    const executor = { pty: vi.fn(async () => ({ channel, resize, kill })) }
    const runtime = new SshSubprocessRuntime(executor as never)

    const handle = await runtime.spawnTerminal({
      argv: ['bash'],
      cwd: '/remote/project',
      cols: 100,
      rows: 30,
      terminalType: 'xterm-256color',
      graceMs: 1000,
      env: { DSH_SESSION_ID: 'session-1' },
    })

    expect(executor.pty).toHaveBeenCalledWith(
      ['bash'],
      '/remote/project',
      { DSH_SESSION_ID: 'session-1' },
      100,
      30,
      'xterm-256color',
    )
    expect(handle.output).toBe(channel)
    expect(handle.done).toBeInstanceOf(Promise)
    expect(typeof handle.terminate).toBe('function')
    expect(await handle.inspectActivity()).toEqual({ state: 'unknown', revision: 0 })
    await handle.write('pwd\n')
    await handle.resize(120, 40)
    expect(resize).toHaveBeenCalledWith(120, 40)
    const done = handle.done
    const settled = done.then((result) => result)
    channel.emit('exit', 0)
    await handle.terminate()
    expect(await settled).toEqual({ exitCode: 0, signal: null })
    expect(kill).toHaveBeenCalledOnce()
  })
})
