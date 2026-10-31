import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { planNodeTransfers, SyncCoordinator, SyncCoordinatorError } from '../../src/core/sync/coordinator.js'
import { SyncPeerManager } from '../../src/core/sync/peer-manager.js'
import { SyncSessionDeltaPrefixError, SyncSshProbeError, SyncSshTransport } from '../../src/core/sync/ssh-transport.js'
import { SyncNodeService, type SyncNodeEntry, type SyncNodeManifest } from '../../src/core/sync/node-sync.js'
import { SyncStateStore } from '../../src/core/sync/stores.js'
import type { SyncPeer, SyncPeerView } from '../../src/core/sync/model.js'
import { makeSyncSessionBundle, makeSyncSessionManifest, SyncSessionError, syncSessionEntryKey } from '../../src/core/sync/session-sync.js'
import type { SyncSessionBundle, SyncSessionEntry, SyncSessionService } from '../../src/core/sync/session-sync.js'
import { SYNC_SESSION_BUNDLE_OBJECTS_CAPABILITY, SYNC_SESSION_MANIFEST_CAPABILITY } from '../../src/core/sync/protocol.js'

const localInstanceId = 'i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const remoteInstanceId = 'i-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const peer: SyncPeerView = {
  id: 'p-0123456789abcdef01234567',
  name: 'Remote',
  host: 'sync.example.com',
  port: 22,
  username: 'sync',
  authKind: 'password',
  direction: 'bidirectional',
  schedule: 'manual',
  syncSessions: false,
  enabled: true,
  hasSecret: { hasPassword: true, hasKey: false, hasPassphrase: false },
}

function nodeEntry(originInstanceId: string, entityId: string, physicalTimeMs: number, digestByte: string, writerInstanceId = originInstanceId): SyncNodeEntry {
  return {
    metadata: {
      kind: 'node',
      originInstanceId,
      originEntityId: entityId,
      localEntityId: entityId,
      revision: { physicalTimeMs, logicalCounter: 0, writerInstanceId },
      contentDigest: `sha256:${digestByte.repeat(64)}`,
    },
    profile: {
      name: entityId,
      type: 'remote-ssh',
      ssh: { host: `${entityId}.example.com`, port: 22, username: 'sync', auth: { kind: 'agent' } },
    },
  }
}

function deletedSessionEntry(originInstanceId: string, originEntityId: string): SyncSessionEntry {
  const metadata: SyncSessionEntry['metadata'] = {
    kind: 'session',
    originInstanceId,
    originEntityId,
    localEntityId: originEntityId,
    revision: { physicalTimeMs: 100, logicalCounter: 0, writerInstanceId: originInstanceId },
    contentDigest: '',
    deleted: true,
  }
  metadata.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify({
    deleted: true,
    kind: 'session',
    originEntityId,
    originInstanceId,
  })).digest('hex')}`
  return { metadata }
}

function fakeCoordinator(
  remoteEntries: SyncNodeEntry[],
  localEntries: SyncNodeEntry[],
  overrides: Record<string, unknown> = {},
  peerValue: SyncPeerView | ((id: string) => SyncPeerView) = peer,
  sessions?: SyncSessionService,
) {
  const progress: Record<string, unknown>[] = []
  let currentProgress: Record<string, unknown> = {
    lastSuccessAt: '2026-01-01T00:00:00.000Z',
    watermark: 'previous-watermark',
  }
  const peers = {
    get: async (id: string) => typeof peerValue === 'function' ? peerValue(id) : peerValue,
    updateProgress: (_id: string, patch: Record<string, unknown>) => {
      currentProgress = { ...currentProgress, ...patch }
      progress.push({ ...currentProgress })
    },
  }
  const nodes = {
    validateManifest: (entries: unknown) => entries as SyncNodeEntry[],
    exportManifest: async (): Promise<SyncNodeManifest> => ({ protocolVersion: 1, instanceId: localInstanceId, records: localEntries }),
    applyManifest: vi.fn(async (entries: SyncNodeEntry[]) => ({
      created: entries.length,
      updated: 0,
      deleted: 0,
      pendingRemoval: 0,
      skipped: 0,
    })),
  }
  const transport = {
    fetchNodeManifest: vi.fn(async () => ({ protocolVersion: 1, instanceId: remoteInstanceId, records: remoteEntries })),
    applyNodeManifest: vi.fn(async (_id: string, entries: SyncNodeEntry[]) => ({
      created: entries.length,
      updated: 0,
      deleted: 0,
      pendingRemoval: 0,
      skipped: 0,
    })),
    ...overrides,
  }
  const state = { instanceId: () => localInstanceId }
  const coordinator = new SyncCoordinator(
    peers as unknown as SyncPeerManager,
    state as unknown as SyncStateStore,
    nodes as unknown as SyncNodeService,
    transport as unknown as SyncSshTransport,
    () => 1000,
    sessions,
  )
  return { coordinator, peers, nodes, transport, progress }
}

describe('node transfer planning', () => {
  it('pull direction only applies remote records', () => {
    const local = nodeEntry(localInstanceId, 'local-node', 10, 'a')
    const remote = nodeEntry(remoteInstanceId, 'remote-node', 10, 'b')
    const plan = planNodeTransfers('pull', [local], [remote])

    expect(plan.toLocal).toEqual([remote])
    expect(plan.toRemote).toEqual([])
    expect(plan.skipped).toBe(0)
  })

  it('bidirectional LWW routes winners and leaves matching revisions unchanged', () => {
    const localWinner = nodeEntry(localInstanceId, 'same', 20, 'a', localInstanceId)
    const remoteLoser = nodeEntry(localInstanceId, 'same', 10, 'b', remoteInstanceId)
    const remoteWinner = nodeEntry(remoteInstanceId, 'other', 30, 'c')
    const localLoser = nodeEntry(remoteInstanceId, 'other', 20, 'd', localInstanceId)
    const matchingLocal = nodeEntry(localInstanceId, 'same-content', 40, 'e')
    const matchingRemote = nodeEntry(localInstanceId, 'same-content', 40, 'e')
    const plan = planNodeTransfers(
      'bidirectional',
      [localWinner, localLoser, matchingLocal],
      [remoteLoser, remoteWinner, matchingRemote],
    )

    expect(plan.toRemote.map((entry) => entry.metadata.originEntityId)).toEqual(['same'])
    expect(plan.toLocal.map((entry) => entry.metadata.originEntityId)).toEqual(['other'])
    expect(plan.skipped).toBe(1)
  })

  it('rejects same HLC revisions that disagree on content', () => {
    const local = nodeEntry(localInstanceId, 'same', 50, 'a')
    const remote = nodeEntry(localInstanceId, 'same', 50, 'b')
    expect(() => planNodeTransfers('bidirectional', [local], [remote])).toThrow('Equal node revisions')
  })
})

describe('sync coordinator', () => {
  it('merges session bundles after node transfer and reports session counts', async () => {
    const sessionPeer = { ...peer, syncSessions: true }
    const sessionEntry = (originInstanceId: string, originEntityId: string): SyncSessionEntry => ({
      metadata: {
        kind: 'session',
        originInstanceId,
        originEntityId,
        localEntityId: originEntityId,
        revision: { physicalTimeMs: 100, logicalCounter: 0, writerInstanceId: originInstanceId },
        contentDigest: `sha256:${'a'.repeat(64)}`,
        stateDigest: `sha256:${'b'.repeat(64)}`,
      },
    })
    const remoteBundle = makeSyncSessionBundle(remoteInstanceId, [], [{ sessionId: 'legacy-session', reason: 'workspace-cwd-mismatch' }])
    const localBundle = makeSyncSessionBundle(localInstanceId, [sessionEntry(localInstanceId, 'local-session')])
    const sessions = {
      exportBundle: vi.fn(async () => localBundle),
      applyBundle: vi.fn(async () => ({ created: 0, updated: 0, archived: 0, deleted: 0, skipped: 1, unmapped: 1 })),
    }
    const test = fakeCoordinator([], [], {
      fetchSessionBundle: vi.fn(async () => remoteBundle),
      applySessionBundle: vi.fn(async () => ({ created: 0, updated: 1, archived: 0, deleted: 0, skipped: 0, unmapped: 0 })),
    }, sessionPeer, sessions as unknown as SyncSessionService)

    const result = await test.coordinator.run(peer.id)

    expect(result).toMatchObject({ importedSessions: 0, exportedSessions: 1, skippedSessions: 1 })
    expect(sessions.applyBundle).toHaveBeenCalledOnce()
    expect(test.transport.applySessionBundle).toHaveBeenCalledOnce()
    expect(test.progress.at(-1)?.lastResult).toMatchObject({ importedSessions: 0, exportedSessions: 1, skippedSessions: 1 })
  })

  it('uses session manifests and fetches only entries selected for transfer', async () => {
    const sessionPeer = { ...peer, syncSessions: true }
    const remoteEntry = deletedSessionEntry(remoteInstanceId, 'remote-deleted')
    const localEntry = deletedSessionEntry(localInstanceId, 'local-deleted')
    const remoteManifest = makeSyncSessionManifest(remoteInstanceId, [remoteEntry])
    const localManifest = makeSyncSessionManifest(localInstanceId, [localEntry])
    const remoteBundle = makeSyncSessionBundle(remoteInstanceId, [remoteEntry])
    const localBundle = makeSyncSessionBundle(localInstanceId, [localEntry])
    const sessions = {
      exportManifest: vi.fn(async () => localManifest),
      exportEntries: vi.fn(async () => localBundle),
      applyBundle: vi.fn(async () => ({ created: 1, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 })),
    }
    const fetchSessionEntries = vi.fn(async () => remoteBundle)
    const test = fakeCoordinator([], [], {
      fetchNodeManifest: vi.fn(async () => ({
        protocolVersion: 1,
        instanceId: remoteInstanceId,
        records: [],
        capabilities: [SYNC_SESSION_MANIFEST_CAPABILITY],
      })),
      fetchSessionManifest: vi.fn(async () => remoteManifest),
      fetchSessionEntries,
      fetchSessionBundle: vi.fn(),
      applySessionBundle: vi.fn(async () => ({ created: 0, updated: 1, archived: 0, deleted: 0, skipped: 0, unmapped: 0 })),
    }, sessionPeer, sessions as unknown as SyncSessionService)

    const result = await test.coordinator.run(peer.id)

    expect(result).toMatchObject({ importedSessions: 1, exportedSessions: 1, skippedSessions: 0 })
    expect(sessions.exportManifest).toHaveBeenCalledOnce()
    expect(sessions.exportEntries).toHaveBeenCalledWith([syncSessionEntryKey(localEntry)], localManifest.digest, [], { sharedObjects: false })
    expect(fetchSessionEntries).toHaveBeenCalledWith(
      peer.id,
      [syncSessionEntryKey(remoteEntry)],
      remoteManifest.digest,
      [],
    )
    expect(test.transport.fetchSessionBundle).not.toHaveBeenCalled()
  })

  it('negotiates the shared-object wire format when both sides declare the capability', async () => {
    const sessionPeer = { ...peer, syncSessions: true }
    const remoteEntry = deletedSessionEntry(remoteInstanceId, 'remote-deleted')
    const localEntry = deletedSessionEntry(localInstanceId, 'local-deleted')
    const remoteManifest = makeSyncSessionManifest(remoteInstanceId, [remoteEntry])
    const localManifest = makeSyncSessionManifest(localInstanceId, [localEntry])
    const remoteBundle = makeSyncSessionBundle(remoteInstanceId, [remoteEntry])
    const sessions = {
      exportManifest: vi.fn(async () => localManifest),
      exportEntries: vi.fn(async (_keys: string[], _digest: string, _prefixes: unknown[], options: { sharedObjects?: boolean }) =>
        options.sharedObjects === true
          ? makeSyncSessionBundle(localInstanceId, [localEntry], [], [])
          : makeSyncSessionBundle(localInstanceId, [localEntry]),
      ),
      applyBundle: vi.fn(async () => ({ created: 1, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 })),
    }
    const fetchSessionEntries = vi.fn(async () => remoteBundle)
    const applySessionBundle = vi.fn(async (_id: string, bundle: SyncSessionBundle) => {
      expect(bundle.objects).toBeUndefined()
      expect(bundle.entries[0]?.sharedObjectIds).toBeUndefined()
      return { created: 0, updated: 1, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }
    })
    const test = fakeCoordinator([], [], {
      fetchNodeManifest: vi.fn(async () => ({
        protocolVersion: 1,
        instanceId: remoteInstanceId,
        records: [],
        capabilities: [SYNC_SESSION_MANIFEST_CAPABILITY, SYNC_SESSION_BUNDLE_OBJECTS_CAPABILITY],
      })),
      fetchSessionManifest: vi.fn(async () => remoteManifest),
      fetchSessionEntries,
      fetchSessionBundle: vi.fn(),
      applySessionBundle,
    }, sessionPeer, sessions as unknown as SyncSessionService)

    const result = await test.coordinator.run(peer.id)

    expect(result).toMatchObject({ importedSessions: 1, exportedSessions: 1 })
    expect(sessions.exportEntries).toHaveBeenCalledWith(
      [syncSessionEntryKey(localEntry)],
      localManifest.digest,
      [],
      { sharedObjects: true },
    )
    expect(applySessionBundle).toHaveBeenCalledOnce()
  })

  it('re-fetches a full bundle when the local event prefix changed', async () => {
    const sessionPeer = { ...peer, direction: 'pull' as const, syncSessions: true }
    const remoteEntry = deletedSessionEntry(remoteInstanceId, 'remote-deleted')
    const remoteManifest = makeSyncSessionManifest(remoteInstanceId, [remoteEntry])
    const localManifest = makeSyncSessionManifest(localInstanceId, [])
    const remoteBundle = makeSyncSessionBundle(remoteInstanceId, [remoteEntry])
    const sessions = {
      exportManifest: vi.fn(async () => localManifest),
      exportEntries: vi.fn(),
      applyBundle: vi.fn()
        .mockRejectedValueOnce(new SyncSessionError('session-delta-prefix', 'prefix changed'))
        .mockResolvedValue({ created: 1, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }),
    }
    const fetchSessionEntries = vi.fn(async () => remoteBundle)
    const test = fakeCoordinator([], [], {
      fetchNodeManifest: vi.fn(async () => ({
        protocolVersion: 1,
        instanceId: remoteInstanceId,
        records: [],
        capabilities: [SYNC_SESSION_MANIFEST_CAPABILITY],
      })),
      fetchSessionManifest: vi.fn(async () => remoteManifest),
      fetchSessionEntries,
      fetchSessionBundle: vi.fn(),
      applySessionBundle: vi.fn(),
    }, sessionPeer, sessions as unknown as SyncSessionService)

    await expect(test.coordinator.run(peer.id)).resolves.toMatchObject({ importedSessions: 1 })
    expect(fetchSessionEntries).toHaveBeenCalledTimes(2)
    expect(sessions.applyBundle).toHaveBeenCalledTimes(2)
  })

  it('re-exports a full local bundle when the remote rejects its event prefix', async () => {
    const sessionPeer = { ...peer, direction: 'bidirectional' as const, syncSessions: true }
    const localEntry = deletedSessionEntry(localInstanceId, 'local-deleted')
    const localManifest = makeSyncSessionManifest(localInstanceId, [localEntry])
    const remoteManifest = makeSyncSessionManifest(remoteInstanceId, [])
    const localBundle = makeSyncSessionBundle(localInstanceId, [localEntry])
    const sessions = {
      exportManifest: vi.fn(async () => localManifest),
      exportEntries: vi.fn(async () => localBundle),
      applyBundle: vi.fn(),
    }
    const applySessionBundle = vi.fn()
      .mockRejectedValueOnce(new SyncSessionDeltaPrefixError())
      .mockResolvedValue({ created: 0, updated: 1, archived: 0, deleted: 0, skipped: 0, unmapped: 0 })
    const test = fakeCoordinator([], [], {
      fetchNodeManifest: vi.fn(async () => ({
        protocolVersion: 1,
        instanceId: remoteInstanceId,
        records: [],
        capabilities: [SYNC_SESSION_MANIFEST_CAPABILITY],
      })),
      fetchSessionManifest: vi.fn(async () => remoteManifest),
      fetchSessionEntries: vi.fn(),
      fetchSessionBundle: vi.fn(),
      applySessionBundle,
    }, sessionPeer, sessions as unknown as SyncSessionService)

    await expect(test.coordinator.run(peer.id)).resolves.toMatchObject({ exportedSessions: 1 })
    expect(sessions.exportEntries).toHaveBeenCalledTimes(2)
    expect(applySessionBundle).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous watermark when selected session content misses manifest entries', async () => {
    const sessionPeer = { ...peer, direction: 'pull' as const, syncSessions: true }
    const remoteEntry = deletedSessionEntry(remoteInstanceId, 'remote-deleted')
    const remoteManifest = makeSyncSessionManifest(remoteInstanceId, [remoteEntry])
    const localManifest = makeSyncSessionManifest(localInstanceId, [])
    const sessions = {
      exportManifest: vi.fn(async () => localManifest),
      exportEntries: vi.fn(),
      applyBundle: vi.fn(async () => ({ created: 0, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 })),
    }
    const test = fakeCoordinator([], [], {
      fetchNodeManifest: vi.fn(async () => ({
        protocolVersion: 1,
        instanceId: remoteInstanceId,
        records: [],
        capabilities: [SYNC_SESSION_MANIFEST_CAPABILITY],
      })),
      fetchSessionManifest: vi.fn(async () => remoteManifest),
      fetchSessionEntries: vi.fn(async () => makeSyncSessionBundle(remoteInstanceId, [])),
      applySessionBundle: vi.fn(),
    }, sessionPeer, sessions as unknown as SyncSessionService)

    await expect(test.coordinator.run(peer.id)).rejects.toMatchObject({ code: 'session-manifest-stale' })

    expect(sessions.applyBundle).not.toHaveBeenCalled()
    expect(test.transport.applySessionBundle).not.toHaveBeenCalled()
    expect(test.progress.at(-1)).toMatchObject({ lastRunStatus: 'failed', watermark: 'previous-watermark' })
  })

  it('retries a local delta prefix mismatch with complete selected entries', async () => {
    const sessionPeer = { ...peer, direction: 'pull' as const, syncSessions: true }
    const remoteEntry = deletedSessionEntry(remoteInstanceId, 'remote-deleted')
    const remoteManifest = makeSyncSessionManifest(remoteInstanceId, [remoteEntry])
    const localManifest = makeSyncSessionManifest(localInstanceId, [])
    const remoteBundle = makeSyncSessionBundle(remoteInstanceId, [remoteEntry])
    const sessions = {
      exportManifest: vi.fn(async () => localManifest),
      exportEntries: vi.fn(),
      applyBundle: vi.fn()
        .mockRejectedValueOnce(new SyncSessionError('session-delta-prefix', 'prefix changed'))
        .mockResolvedValue({ created: 1, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }),
    }
    const fetchSessionEntries = vi.fn(async () => remoteBundle)
    const test = fakeCoordinator([], [], {
      fetchNodeManifest: vi.fn(async () => ({
        protocolVersion: 1,
        instanceId: remoteInstanceId,
        records: [],
        capabilities: [SYNC_SESSION_MANIFEST_CAPABILITY],
      })),
      fetchSessionManifest: vi.fn(async () => remoteManifest),
      fetchSessionEntries,
      fetchSessionBundle: vi.fn(),
      applySessionBundle: vi.fn(),
    }, sessionPeer, sessions as unknown as SyncSessionService)

    await expect(test.coordinator.run(peer.id)).resolves.toMatchObject({ importedSessions: 1 })

    expect(fetchSessionEntries).toHaveBeenCalledTimes(2)
    expect(sessions.applyBundle).toHaveBeenCalledTimes(2)
  })

  it('retries a remote delta prefix mismatch with complete local entries', async () => {
    const sessionPeer = { ...peer, direction: 'bidirectional' as const, syncSessions: true }
    const localEntry = deletedSessionEntry(localInstanceId, 'local-deleted')
    const localManifest = makeSyncSessionManifest(localInstanceId, [localEntry])
    const remoteManifest = makeSyncSessionManifest(remoteInstanceId, [])
    const localBundle = makeSyncSessionBundle(localInstanceId, [localEntry])
    const sessions = {
      exportManifest: vi.fn(async () => localManifest),
      exportEntries: vi.fn(async () => localBundle),
      applyBundle: vi.fn(),
    }
    const applySessionBundle = vi.fn()
      .mockRejectedValueOnce(new SyncSessionDeltaPrefixError())
      .mockResolvedValue({ created: 0, updated: 1, archived: 0, deleted: 0, skipped: 0, unmapped: 0 })
    const test = fakeCoordinator([], [], {
      fetchNodeManifest: vi.fn(async () => ({
        protocolVersion: 1,
        instanceId: remoteInstanceId,
        records: [],
        capabilities: [SYNC_SESSION_MANIFEST_CAPABILITY],
      })),
      fetchSessionManifest: vi.fn(async () => remoteManifest),
      fetchSessionEntries: vi.fn(),
      fetchSessionBundle: vi.fn(),
      applySessionBundle,
    }, sessionPeer, sessions as unknown as SyncSessionService)

    await expect(test.coordinator.run(peer.id)).resolves.toMatchObject({ exportedSessions: 1 })

    expect(sessions.exportEntries).toHaveBeenCalledTimes(2)
    expect(applySessionBundle).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight operation per peer', async () => {
    let finishFetch: ((value: { protocolVersion: 1; instanceId: string; records: SyncNodeEntry[] }) => void) | undefined
    const fetchNodeManifest = vi.fn(() => new Promise<{ protocolVersion: 1; instanceId: string; records: SyncNodeEntry[] }>((resolve) => {
      finishFetch = resolve
    }))
    const local = nodeEntry(localInstanceId, 'local-node', 10, 'a')
    const remote = nodeEntry(remoteInstanceId, 'remote-node', 10, 'b')
    const test = fakeCoordinator([remote], [local], { fetchNodeManifest })
    const first = test.coordinator.run(peer.id)
    const second = test.coordinator.run(peer.id)

    expect(second).toBe(first)
    await vi.waitFor(() => expect(fetchNodeManifest).toHaveBeenCalledTimes(1))
    expect(fetchNodeManifest).toHaveBeenCalledTimes(1)
    finishFetch?.({ protocolVersion: 1, instanceId: remoteInstanceId, records: [remote] })
    await expect(first).resolves.toMatchObject({ imported: 1, exported: 1 })
    expect(test.progress.map((entry) => entry.lastRunStatus)).toEqual(['running', 'succeeded'])
  })

  it('allows different peers to run independently', async () => {
    const secondPeer = { ...peer, id: 'p-1123456789abcdef01234567', name: 'Second peer' }
    const releases = new Map<string, (value: SyncNodeManifest) => void>()
    const fetchNodeManifest = vi.fn((id: string) => new Promise<SyncNodeManifest>((resolve) => releases.set(id, resolve)))
    const test = fakeCoordinator([], [], { fetchNodeManifest }, (id) => id === secondPeer.id ? secondPeer : peer)
    const first = test.coordinator.run(peer.id)
    const second = test.coordinator.run(secondPeer.id)

    await vi.waitFor(() => expect(fetchNodeManifest).toHaveBeenCalledTimes(2))
    expect(first).not.toBe(second)
    releases.get(peer.id)?.({ protocolVersion: 1, instanceId: remoteInstanceId, records: [] })
    releases.get(secondPeer.id)?.({ protocolVersion: 1, instanceId: 'i-cccccccccccccccccccccccccccccccc', records: [] })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('preserves the previous success watermark after an SSH failure', async () => {
    const fetchNodeManifest = vi.fn(async () => { throw new SyncSshProbeError('network') })
    const test = fakeCoordinator([], [], {
      fetchNodeManifest,
    })

    await expect(test.coordinator.run(peer.id)).rejects.toMatchObject({ code: 'ssh-network' })
    expect(fetchNodeManifest).toHaveBeenCalledTimes(2)
    expect(test.progress.at(-1)).toMatchObject({ lastRunStatus: 'failed', lastErrorCode: 'ssh-network' })
    expect(test.progress.at(-1)?.watermark).toBe('previous-watermark')
    expect(test.progress.at(-1)?.lastSuccessAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('retries a transient SSH failure once before committing the watermark', async () => {
    const fetchNodeManifest = vi.fn()
      .mockRejectedValueOnce(new SyncSshProbeError('timeout'))
      .mockResolvedValue({ protocolVersion: 1, instanceId: remoteInstanceId, records: [] })
    const test = fakeCoordinator([], [], { fetchNodeManifest })

    await expect(test.coordinator.run(peer.id)).resolves.toMatchObject({ imported: 0, exported: 0 })
    expect(fetchNodeManifest).toHaveBeenCalledTimes(2)
    expect(test.progress.at(-1)).toMatchObject({ lastRunStatus: 'succeeded', watermark: expect.stringMatching(/^sha256:/) })
  })

  it('records that session sync is pending and performs no node transfer', async () => {
    const sessionPeer = { ...peer, syncSessions: true }
    const test = fakeCoordinator([], [], {
      fetchNodeManifest: vi.fn(),
    }, sessionPeer)

    await expect(test.coordinator.run(peer.id)).rejects.toBeInstanceOf(SyncCoordinatorError)
    expect(test.transport.fetchNodeManifest).not.toHaveBeenCalled()
    expect(test.progress.at(-1)).toMatchObject({ lastRunStatus: 'failed', lastErrorCode: 'sessions-unavailable' })
  })
})
