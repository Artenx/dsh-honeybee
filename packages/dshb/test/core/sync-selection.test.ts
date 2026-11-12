import { describe, expect, it } from 'vitest'
import type { SyncCatalog, SyncRecordMetadata, SyncSelection } from '../../src/core/sync/model.js'
import { resolveSyncSelection, selectionIncludesNode, selectionIncludesSession } from '../../src/core/sync/selection.js'

const origin = (instance: string, entity: string) => ({ originInstanceId: instance, originEntityId: entity })

const nodeOrigin = origin('i-a', 'node-a')
const workspaceOrigin = origin('i-a', 'workspace-a')
const workspaceRef = { ...workspaceOrigin, remotePath: '/work/app' }
const sessionOrigin = origin('i-a', 'session-a')

const catalog: SyncCatalog = {
  protocolVersion: 1,
  instanceId: 'i-a',
  nodes: [{ origin: nodeOrigin, name: 'Build', type: 'remote-ssh' }],
  workspaces: [{ origin: workspaceOrigin, nodeOrigin, remotePath: '/work/app', title: 'App' }],
  sessions: [{ origin: sessionOrigin, workspaceOrigin, nodeOrigin, sessionId: 'session-a', sizeBytes: 128 }],
}

function metadata(kind: 'node' | 'session', value: ReturnType<typeof origin>): SyncRecordMetadata {
  return {
    kind,
    ...value,
    localEntityId: value.originEntityId,
    revision: { physicalTimeMs: 1, logicalCounter: 0, writerInstanceId: value.originInstanceId },
    contentDigest: 'sha256:' + 'a'.repeat(64),
    ...(kind === 'session' ? { workspaceOrigin } : {}),
  }
}

function selected(patch: Partial<SyncSelection>): SyncSelection {
  return { mode: 'selected', nodes: [], workspaces: [], sessions: [], ...patch }
}

describe('sync selection', () => {
  it('treats a missing selection as the complete dataset', () => {
    expect(resolveSyncSelection(undefined, catalog).all).toBe(true)
  })

  it('includes workspace sessions and the required node', () => {
    const scope = resolveSyncSelection(selected({ workspaces: [workspaceRef] }), catalog)
    expect(selectionIncludesNode(metadata('node', nodeOrigin), scope)).toBe(true)
    expect(selectionIncludesSession(metadata('session', sessionOrigin), scope)).toBe(true)
  })

  it('includes one selected session and its parent node/workspace only', () => {
    const scope = resolveSyncSelection(selected({ sessions: [sessionOrigin] }), catalog)
    expect(selectionIncludesNode(metadata('node', nodeOrigin), scope)).toBe(true)
    expect(selectionIncludesSession(metadata('session', sessionOrigin), scope)).toBe(true)
    expect(selectionIncludesSession(metadata('session', origin('i-a', 'session-b')), scope)).toBe(false)
  })

  it('selects a node profile without implicitly selecting its sessions', () => {
    const scope = resolveSyncSelection(selected({ nodes: [nodeOrigin] }), catalog)
    expect(selectionIncludesNode(metadata('node', nodeOrigin), scope)).toBe(true)
    expect(selectionIncludesSession(metadata('session', sessionOrigin), scope)).toBe(false)
  })
})
