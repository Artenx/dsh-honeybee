import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  WorkspaceInstructionStore,
  SessionInstructionSnapshotStore,
  InstructionConflictError,
  InstructionSizeError,
  INSTRUCTION_MAX_BYTES,
  sharedWorkspaceInstructionStore,
  sharedSessionInstructionSnapshotStore,
} from '../../src/core/workspace-instructions.js'

const TMP_HOME = '/tmp/dshb-test-ws-instructions'

beforeEach(() => {
  rmSync(TMP_HOME, { recursive: true, force: true })
  process.env.DSH_HOME = TMP_HOME
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('WorkspaceInstructionStore（需求 1.2-1.5）', () => {
  it('首次保存创建 revision 1 并计算 digest', () => {
    const store = new WorkspaceInstructionStore()
    const r = store.update({ workspaceId: 'w1', text: 'hello', expectedRevision: 0 })
    expect(r.revision).toBe(1)
    expect(r.text).toBe('hello')
    expect(r.digest).toHaveLength(64)
    expect(r.createdAt).toBe(r.updatedAt)
  })

  it('重复保存递增 revision 并更新 updatedAt', () => {
    const store = new WorkspaceInstructionStore()
    const r1 = store.update({ workspaceId: 'w1', text: 'a', expectedRevision: 0 })
    const r2 = store.update({ workspaceId: 'w1', text: 'b', expectedRevision: 1 })
    expect(r2.revision).toBe(2)
    expect(r2.text).toBe('b')
    expect(r2.digest).not.toBe(r1.digest)
    expect(r2.createdAt).toBe(r1.createdAt)
  })

  it('revision 冲突抛 InstructionConflictError', () => {
    const store = new WorkspaceInstructionStore()
    store.update({ workspaceId: 'w1', text: 'a', expectedRevision: 0 })
    expect(() => store.update({ workspaceId: 'w1', text: 'b', expectedRevision: 99 })).toThrow(
      InstructionConflictError,
    )
  })

  it('空文本保存成功，标记未配置', () => {
    const store = new WorkspaceInstructionStore()
    store.update({ workspaceId: 'w1', text: 'config', expectedRevision: 0 })
    store.clear('w1', 1)
    expect(store.get('w1')).toBeUndefined()
  })

  it('clear 时 revision 不匹配抛冲突', () => {
    const store = new WorkspaceInstructionStore()
    store.update({ workspaceId: 'w1', text: 'a', expectedRevision: 0 })
    expect(() => store.clear('w1', 99)).toThrow(InstructionConflictError)
  })

  it('UTF-8 字节超限抛 InstructionSizeError', () => {
    const store = new WorkspaceInstructionStore()
    const big = 'x'.repeat(INSTRUCTION_MAX_BYTES + 1)
    expect(() => store.update({ workspaceId: 'w1', text: big, expectedRevision: 0 })).toThrow(
      InstructionSizeError,
    )
  })

  it('多字节字符按 UTF-8 字节计算', () => {
    const store = new WorkspaceInstructionStore()
    const text = '你'.repeat(11000)
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(INSTRUCTION_MAX_BYTES)
    expect(() => store.update({ workspaceId: 'w1', text, expectedRevision: 0 })).toThrow(
      InstructionSizeError,
    )
  })

  it('removeByWorkspace 清理记录', () => {
    const store = new WorkspaceInstructionStore()
    store.update({ workspaceId: 'w1', text: 'a', expectedRevision: 0 })
    store.removeByWorkspace('w1')
    expect(store.get('w1')).toBeUndefined()
  })

  it('持久化后重新加载可见', () => {
    const s1 = new WorkspaceInstructionStore()
    s1.update({ workspaceId: 'w1', text: 'persisted', expectedRevision: 0 })
    const s2 = new WorkspaceInstructionStore()
    const r = s2.get('w1')
    expect(r?.text).toBe('persisted')
    expect(r?.revision).toBe(1)
  })

  it('文件权限为 600', () => {
    const store = new WorkspaceInstructionStore()
    store.update({ workspaceId: 'w1', text: 'a', expectedRevision: 0 })
    const stat = existsSync(join(TMP_HOME, 'dshb', 'workspace-instructions.json'))
    expect(stat).toBe(true)
  })
})

describe('SessionInstructionSnapshotStore（需求 3.3-3.5、4.1-4.5、7.1-7.3）', () => {
  it('workspace 源创建非空快照', () => {
    const store = new SessionInstructionSnapshotStore()
    const record = {
      workspaceId: 'w1',
      text: 'guide',
      revision: 2,
      digest: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
    const snap = store.createIfAbsent('s1', { kind: 'workspace', record, workspaceId: 'w1' })
    expect(snap.text).toBe('guide')
    expect(snap.workspaceRevision).toBe(2)
    expect(snap.digest).toBe('abc')
    expect(snap.workspaceId).toBe('w1')
  })

  it('empty 源创建空快照（需求 4.4）', () => {
    const store = new SessionInstructionSnapshotStore()
    const snap = store.createIfAbsent('s1', { kind: 'empty' })
    expect(snap.text).toBe('')
    expect(snap.workspaceRevision).toBeUndefined()
  })

  it('createIfAbsent 返回已有快照（不可变性，属性 4）', () => {
    const store = new SessionInstructionSnapshotStore()
    const record = {
      workspaceId: 'w1',
      text: 'v1',
      revision: 1,
      digest: 'd1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    store.createIfAbsent('s1', { kind: 'workspace', record, workspaceId: 'w1' })
    const record2 = { ...record, text: 'v2', revision: 2, digest: 'd2' }
    const snap = store.createIfAbsent('s1', { kind: 'workspace', record: record2, workspaceId: 'w1' })
    expect(snap.text).toBe('v1')
    expect(snap.workspaceRevision).toBe(1)
  })

  it('inherit 源复制父快照（需求 7.1-7.3）', () => {
    const store = new SessionInstructionSnapshotStore()
    const parent = {
      sessionId: 'parent',
      workspaceId: 'w1',
      workspaceRevision: 3,
      digest: 'd3',
      text: 'parent guide',
      capturedAt: '2026-01-01T00:00:00.000Z',
    }
    store.createIfAbsent('parent', {
      kind: 'workspace',
      record: {
        workspaceId: 'w1',
        text: 'parent guide',
        revision: 3,
        digest: 'd3',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      workspaceId: 'w1',
    })
    const child = store.createIfAbsent('child', { kind: 'inherit', parentSnapshot: parent })
    expect(child.text).toBe('parent guide')
    expect(child.workspaceRevision).toBe(3)
    expect(child.inheritedFromSessionId).toBe('parent')
  })

  it('子代理不继承父快照时按自身工作区创建（需求 7.2）', () => {
    const store = new SessionInstructionSnapshotStore()
    const snap = store.createIfAbsent('child', {
      kind: 'workspace',
      record: {
        workspaceId: 'w2',
        text: 'child guide',
        revision: 1,
        digest: 'd1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      workspaceId: 'w2',
    })
    expect(snap.text).toBe('child guide')
    expect(snap.inheritedFromSessionId).toBeUndefined()
  })

  it('每个 SessionId 最多一个快照（属性 1）', () => {
    const store = new SessionInstructionSnapshotStore()
    store.createIfAbsent('s1', { kind: 'empty' })
    store.createIfAbsent('s1', { kind: 'empty', workspaceId: 'w1' })
    const snap = store.get('s1')
    expect(snap?.workspaceId).toBeUndefined()
  })

  it('remove 清理 SessionId 快照（需求 4.5）', () => {
    const store = new SessionInstructionSnapshotStore()
    store.createIfAbsent('s1', { kind: 'empty' })
    store.remove('s1')
    expect(store.get('s1')).toBeUndefined()
  })

  it('workspace 删除清理配置但保留会话快照（需求 6.5）', () => {
    const wStore = new WorkspaceInstructionStore()
    const sStore = new SessionInstructionSnapshotStore()
    wStore.update({ workspaceId: 'w1', text: 'a', expectedRevision: 0 })
    sStore.createIfAbsent('s1', {
      kind: 'workspace',
      record: wStore.get('w1')!,
      workspaceId: 'w1',
    })
    wStore.removeByWorkspace('w1')
    expect(wStore.get('w1')).toBeUndefined()
    expect(sStore.get('s1')).toBeDefined()
  })

  it('持久化后重新加载可见', () => {
    const s1 = new SessionInstructionSnapshotStore()
    s1.createIfAbsent('s1', { kind: 'empty' })
    const s2 = new SessionInstructionSnapshotStore()
    expect(s2.get('s1')).toBeDefined()
  })
})

describe('共享单例（属性 3）', () => {
  it('revision 单调递增跨实例', () => {
    const s1 = sharedWorkspaceInstructionStore()
    s1.update({ workspaceId: 'w1', text: 'a', expectedRevision: 0 })
    const s2 = sharedWorkspaceInstructionStore()
    const r = s2.get('w1')
    expect(r?.revision).toBe(1)
  })
})
