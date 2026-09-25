import { describe, expect, it, vi } from 'vitest'
import { decorateFileSystem } from '../../src/router/decorate-fs.js'
import { sharedWorldResolver } from '../../src/router/resolve.js'

describe('remote filesystem byte ranges', () => {
  it('routes preview byte reads through the bound execution world', async () => {
    const readByteRange = vi.fn(async () => new Uint8Array([0, 255, 1]))
    const lstat = vi.fn(async () => ({ type: 'file' }))
    const originalLstat = vi.fn()
    const fileSystem = {
      resolve: vi.fn(async (path: string, options?: { cwd?: string }) => `${options?.cwd ?? '/local'}/${path}`),
      processPath: (target: string) => target,
      stat: vi.fn(),
      lstat: originalLstat,
      readText: vi.fn(),
      streamText: vi.fn(),
      readBytes: vi.fn(),
      readByteRange: vi.fn(),
      listDir: vi.fn(),
      writeText: vi.fn(),
      editText: vi.fn(),
    }
    const restore = decorateFileSystem(fileSystem as never)
    const resolver = sharedWorldResolver()
    resolver.setBindings({
      resolve: (path: string) => path.startsWith('/mirror/')
        ? { nodeId: 'node-1', remotePath: path.replace('/mirror', '/remote') }
        : undefined,
    })
    resolver.setRegistry({
      get: () => ({ fs: { readByteRange, lstat } }) as never,
    })

    await expect(fileSystem.readByteRange('/mirror/document.pdf', { offset: 10, length: 3 })).resolves.toEqual(new Uint8Array([0, 255, 1]))
    expect(readByteRange).toHaveBeenCalledWith('/remote/document.pdf', { offset: 10, length: 3 }, undefined)

    await expect(fileSystem.lstat('deploy-log.md', { cwd: '/mirror/cube-studio' })).resolves.toEqual({ type: 'file' })
    expect(lstat).toHaveBeenCalledWith('/remote/cube-studio/deploy-log.md', { cwd: '/mirror/cube-studio' }, undefined)
    expect(originalLstat).not.toHaveBeenCalled()
    restore()
  })
})
