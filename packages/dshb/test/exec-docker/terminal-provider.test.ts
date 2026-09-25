import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DockerSubprocessRuntime } from '../../src/exec-docker/process-provider.js'

describe('Docker terminal subprocess contract', () => {
  it('exposes the DSH 0.1.7 terminal handle shape and settles after stream close', async () => {
    const stream = new PassThrough()
    stream.resume()
    const resize = vi.fn()
    const kill = vi.fn(() => stream.end())
    const client = { pty: vi.fn(async () => ({ stream, resize, kill })) }
    const runtime = new DockerSubprocessRuntime(client as never)

    const handle = await runtime.spawnTerminal({
      argv: ['bash'],
      cwd: '/workspace',
      cols: 100,
      rows: 30,
      terminalType: 'xterm-256color',
      graceMs: 1000,
      env: { DSH_SESSION_ID: 'session-1' },
    })

    expect(handle.output).toBe(stream)
    expect(client.pty).toHaveBeenCalledWith(
      ['bash'],
      '/workspace',
      100,
      30,
      { DSH_SESSION_ID: 'session-1' },
      'xterm-256color',
    )
    await handle.write('pwd\n')
    await handle.resize(120, 40)
    const done = handle.done
    const settled = done.then((result) => result)
    await handle.terminate()
    expect(await settled).toEqual({ exitCode: null, signal: null })
    expect(resize).toHaveBeenCalledWith(120, 40)
    expect(kill).toHaveBeenCalledOnce()
  })
})
