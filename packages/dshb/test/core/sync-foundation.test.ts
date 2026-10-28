import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compareSyncRevision, HybridLogicalClock } from '../../src/core/sync/revision.js'
import { parseSyncPeer, syncRecordKey, type SyncPeerDraft, type SyncRecordMetadata } from '../../src/core/sync/model.js'
import { getOrCreateSyncInstanceId, SyncPeerStore, SyncStateStore } from '../../src/core/sync/stores.js'

const homes: string[] = []

function createHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dshb-sync-test-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const peerDraft: SyncPeerDraft = {
  name: 'Build host',
  host: 'build.example.com',
  port: 22,
  username: 'deploy',
  authKind: 'key',
  remoteDshHome: '/home/deploy/.dsh',
  direction: 'pull',
  schedule: 'manual',
  syncSessions: false,
  enabled: true,
}

describe('sync peer model and persistence', () => {
  it('normalizes valid peer values and stores them without secret fields', () => {
    const home = createHome()
    const store = new SyncPeerStore(home)
    const peer = store.create({ ...peerDraft, name: '  Build host  ', host: ' build.example.com ' })

    expect(peer.id).toMatch(/^p-[a-f0-9]{24}$/)
    expect(peer.name).toBe('Build host')
    expect(peer.host).toBe('build.example.com')
    expect(new SyncPeerStore(home).get(peer.id)).toEqual(peer)
    expect(readFileSync(join(home, 'dshb', 'sync-peers.json'), 'utf8')).not.toMatch(/password|privateKey|passphrase/)
    expect(statSync(join(home, 'dshb', 'sync-peers.json')).mode & 0o777).toBe(0o600)
  })

  it('returns copies and preserves the peer identity on update', () => {
    const store = new SyncPeerStore(createHome())
    const peer = store.create(peerDraft)
    const result = store.list()
    result[0].name = 'mutated'

    expect(store.get(peer.id)?.name).toBe('Build host')
    expect(store.update(peer.id, { schedule: 'every-5m', enabled: false })).toMatchObject({
      id: peer.id,
      schedule: 'every-5m',
      enabled: false,
    })
    expect(store.remove(peer.id)).toBe(true)
    expect(store.remove(peer.id)).toBe(false)
  })

  it('rejects unsafe peer fields and invalid connection settings', () => {
    expect(() => parseSyncPeer({ ...peerDraft, id: 'peer-1', password: 'secret' })).toThrow('unsupported field')
    expect(() => parseSyncPeer({ ...peerDraft, id: 'peer-1', port: 0 })).toThrow('port')
    expect(() => parseSyncPeer({ ...peerDraft, id: 'peer-1', remoteDshHome: '../outside' })).toThrow('absolute path')
    expect(() => parseSyncPeer({ ...peerDraft, id: 'peer-1', remoteDshHome: '/home/deploy/../other' })).toThrow('absolute path')
    expect(() => parseSyncPeer({ ...peerDraft, id: 'peer-1', direction: 'push' })).toThrow('direction')
  })

  it('fails closed on malformed peer state', () => {
    const home = createHome()
    mkdirSync(join(home, 'dshb'), { recursive: true, mode: 0o700 })
    const file = join(home, 'dshb', 'sync-peers.json')
    writeFileSync(file, '{invalid', { mode: 0o600 })

    expect(() => new SyncPeerStore(home).list()).toThrow('Invalid JSON')
    expect(readFileSync(file, 'utf8')).toBe('{invalid')
  })
})

describe('hybrid logical clock', () => {
  it('is monotonic when local wall time moves backwards and merges remote clocks', () => {
    const clock = new HybridLogicalClock('i-local')

    expect(clock.tick(100)).toEqual({ physicalTimeMs: 100, logicalCounter: 0, writerInstanceId: 'i-local' })
    expect(clock.tick(90)).toEqual({ physicalTimeMs: 100, logicalCounter: 1, writerInstanceId: 'i-local' })
    expect(clock.observe({ physicalTimeMs: 120, logicalCounter: 5, writerInstanceId: 'i-peer' }, 110)).toEqual({
      physicalTimeMs: 120,
      logicalCounter: 6,
      writerInstanceId: 'i-local',
    })
    expect(clock.tick(119)).toEqual({ physicalTimeMs: 120, logicalCounter: 7, writerInstanceId: 'i-local' })
  })

  it('uses writer identity as a deterministic tie breaker', () => {
    const base = { physicalTimeMs: 10, logicalCounter: 2 }
    expect(compareSyncRevision({ ...base, writerInstanceId: 'i-a' }, { ...base, writerInstanceId: 'i-b' })).toBe(-1)
    expect(compareSyncRevision({ ...base, writerInstanceId: 'i-b' }, { ...base, writerInstanceId: 'i-a' })).toBe(1)
  })

  it('rejects invalid clock values', () => {
    expect(() => new HybridLogicalClock('i-local', { physicalTimeMs: -1, logicalCounter: 0 })).toThrow()
    expect(() => new HybridLogicalClock('i-local').tick(Number.NaN)).toThrow()
  })

  it('keeps its snapshot unchanged when a remote counter overflows', () => {
    const snapshot = { physicalTimeMs: 10, logicalCounter: Number.MAX_SAFE_INTEGER }
    const clock = new HybridLogicalClock('i-local', snapshot)

    expect(() => clock.observe({ ...snapshot, writerInstanceId: 'i-peer' }, 10)).toThrow('safe integer')
    expect(clock.snapshot()).toEqual(snapshot)
  })
})

describe('sync state persistence', () => {
  it('persists one stable instance ID and protects it with mode 0600', () => {
    const home = createHome()
    const id = getOrCreateSyncInstanceId(home)

    expect(id).toMatch(/^i-[a-f0-9]{32}$/)
    expect(getOrCreateSyncInstanceId(home)).toBe(id)
    expect(statSync(join(home, 'dshb', 'instance-id')).mode & 0o777).toBe(0o600)
  })

  it('persists HLC revisions and record mappings across store instances', () => {
    const home = createHome()
    const store = new SyncStateStore(home)
    const instanceId = store.instanceId()
    const revision = store.nextRevision(100)
    const metadata: SyncRecordMetadata = {
      kind: 'node',
      originInstanceId: instanceId,
      originEntityId: 'node-a',
      localEntityId: 'node-a',
      revision,
      contentDigest: 'sha256:abc',
    }

    store.update((state) => {
      state.records[syncRecordKey(metadata.kind, metadata)] = metadata
      state.peers['p-0123456789abcdef01234567'] = { lastSuccessAt: '2026-10-26T00:00:00.000Z', watermark: 'w1' }
    })

    const restored = new SyncStateStore(home)
    expect(restored.instanceId()).toBe(instanceId)
    expect(restored.read().records[syncRecordKey('node', metadata)]).toEqual(metadata)
    expect(restored.read().peers['p-0123456789abcdef01234567']?.watermark).toBe('w1')
    expect(restored.nextRevision(90).logicalCounter).toBe(1)
    expect(statSync(join(home, 'dshb', 'sync-state.json')).mode & 0o777).toBe(0o600)
  })

  it('does not silently replace a corrupt instance identity or sync state', () => {
    const home = createHome()
    const directory = join(home, 'dshb')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const instanceFile = join(directory, 'instance-id')
    writeFileSync(instanceFile, 'broken-id\n', { mode: 0o600 })
    expect(() => getOrCreateSyncInstanceId(home)).toThrow('Invalid DSHB sync instance ID')
    expect(readFileSync(instanceFile, 'utf8')).toBe('broken-id\n')

    const stateFile = join(directory, 'sync-state.json')
    writeFileSync(stateFile, JSON.stringify({ version: 2 }), { mode: 0o600 })
    expect(() => new SyncStateStore(home).read()).toThrow('Unsupported sync state version')
    expect(readFileSync(stateFile, 'utf8')).toBe(JSON.stringify({ version: 2 }))
  })
})
