import { describe, expect, it, vi } from 'vitest'
import { SshFileSystem } from '../../src/exec-ssh/fs-provider.js'

describe('SSH filesystem metadata', () => {
  it('returns DSH filesystem types and normalizes root child paths', async () => {
    const executor = {
      stat: vi.fn(async () => ({ size: 0, mtime: 1000, isDirectory: true, isFile: false })),
      lstat: vi.fn(async () => ({ size: 0, mtime: 1000, isDirectory: true, isFile: false, isSymlink: false })),
      listDir: vi.fn(async () => [{ name: 'home', isDir: true, isFile: false, isSymlink: false, size: 0, mtime: 1000 }]),
    }
    const fs = new SshFileSystem(executor as never)

    await expect(fs.stat('/home')).resolves.toMatchObject({ type: 'directory', size: 0 })
    await expect(fs.lstat('/home')).resolves.toMatchObject({ type: 'directory', size: 0 })
    await expect(fs.listDir('/')).resolves.toMatchObject([
      { name: 'home', path: '/home', isDirectory: true, isFile: false },
    ])
  })

  it('reads remote byte ranges without text decoding', async () => {
    const executor = {
      readFileRange: vi.fn(async () => Buffer.from([0, 255, 1])),
    }
    const fs = new SshFileSystem(executor as never)

    await expect(fs.readByteRange('/data/image.png', { offset: 5, length: 3 })).resolves.toEqual(new Uint8Array([0, 255, 1]))
    expect(executor.readFileRange).toHaveBeenCalledWith('/data/image.png', 5, 3, undefined)
  })
})
