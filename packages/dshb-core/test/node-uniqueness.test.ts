import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { NodeRegistry, slugifyName } from '../src/node-registry.js'

const TMP_HOME = '/tmp/dshb-test-nodes'
const mockCredentials = {
  readRecord: async () => undefined,
  modifyRecord: async () => ({ kind: 'grant', payload: {} }),
  deleteRecord: async () => {},
}

describe('节点唯一性不变量（设计正确性属性 1）', () => {
  beforeEach(() => {
    process.env.DSH_HOME = TMP_HOME
    mkdirSync(join(TMP_HOME, 'dshb'), { recursive: true, mode: 0o700 })
  })
  afterEach(() => {
    try { rmSync(TMP_HOME, { recursive: true, force: true }) } catch {}
  })

  it('同名节点拒绝创建', async () => {
    const reg = new NodeRegistry({ credentials: mockCredentials } as never)
    await reg.create({ name: 'node-a', type: 'local-host' })
    await expect(reg.create({ name: 'node-a', type: 'local-host' })).rejects.toThrow('already exists')
  })

  it('删除后可重建同名', async () => {
    const reg = new NodeRegistry({ credentials: mockCredentials } as never)
    await reg.create({ name: 'node-b', type: 'local-host' })
    await reg.remove((reg.list()[0]).id)
    await expect(reg.create({ name: 'node-b', type: 'local-host' })).resolves.toBeTruthy()
  })

  it('不同名可共存', async () => {
    const reg = new NodeRegistry({ credentials: mockCredentials } as never)
    await reg.create({ name: 'node-c', type: 'local-host' })
    await reg.create({ name: 'node-d', type: 'local-host' })
    expect(reg.list().length).toBe(2)
  })

  it('ID 生成符合 credentialKey 小写连字符语法', async () => {
    const reg = new NodeRegistry({ credentials: mockCredentials } as never)
    const node = await reg.create({ name: 'test', type: 'local-host' })
    expect(node.id).toMatch(/^n[a-z0-9]+$/)
  })

  it('列表返回副本（不泄露内部引用）', () => {
    const reg = new NodeRegistry({ credentials: mockCredentials } as never)
    reg.list().push({ id: 'fake', name: 'x', type: 'local-host', createdAt: '', updatedAt: '' })
    expect(reg.list().length).toBe(0)
  })
})
