import { describe, expect, it, vi } from 'vitest'
import { DockerClient } from '../../src/exec-docker/docker-client.js'
import { RemoteDockerCli } from '../../src/exec-docker/remote-docker-cli.js'

describe('Docker binary filesystem reads', () => {
  it('decodes whole-file and ranged base64 output as raw bytes', async () => {
    const client = new DockerClient('container')
    const exec = vi.spyOn(client, 'exec')
      .mockResolvedValueOnce({ code: 0, stdout: Buffer.from([0, 255, 1]).toString('base64'), stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: Buffer.from([254, 128]).toString('base64'), stderr: '' })

    await expect(client.readFile('/image.png')).resolves.toEqual(Buffer.from([0, 255, 1]))
    await expect(client.readFileRange('/document.pdf', 8, 2)).resolves.toEqual(Buffer.from([254, 128]))
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('decodes binary reads from a remote Docker CLI', async () => {
    const ssh = {
      exec: vi.fn()
        .mockResolvedValueOnce({ code: 0, stdout: Buffer.from([0, 255, 1]).toString('base64'), stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: Buffer.from([254, 128]).toString('base64'), stderr: '' }),
    }
    const client = new RemoteDockerCli(ssh, 'container')

    await expect(client.readFile('/image.png')).resolves.toEqual(Buffer.from([0, 255, 1]))
    await expect(client.readFileRange('/document.pdf', 8, 2)).resolves.toEqual(Buffer.from([254, 128]))
  })
})
