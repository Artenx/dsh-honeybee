import { describe, expect, it, vi } from 'vitest'
import { DockerFileSystem } from '../../src/exec-docker/fs-provider.js'

describe('Docker filesystem metadata', () => {
  it('returns DSH filesystem types for stat and lstat', async () => {
    const client = {
      stat: vi.fn(async () => ({ size: 12, mtime: 1000, isDirectory: true, isFile: false, isSymlink: false })),
      lstat: vi.fn(async () => ({ size: 12, mtime: 1000, isDirectory: false, isFile: false, isSymlink: true })),
    }
    const fs = new DockerFileSystem(client as never)

    await expect(fs.stat('/workspace')).resolves.toMatchObject({ type: 'directory', size: 12 })
    await expect(fs.lstat('/workspace-link')).resolves.toMatchObject({ type: 'symlink', size: 12 })
  })
})
