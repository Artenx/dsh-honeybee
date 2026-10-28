import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSyncSessionBundle, SyncSessionError } from '../../src/core/sync/session-sync.js'
import {
  SyncOfflineArchiveService,
  SyncOfflineArchiveError,
  validateOfflineZipArchive,
} from '../../src/core/sync/offline-archive.js'
import { SyncOfflineArchiveJournalStore } from '../../src/core/sync/offline-journal.js'

const homes: string[] = []
const instanceId = 'i-11111111111111111111111111111111'

interface FakeServices {
  archives: SyncOfflineArchiveService
  nodeApplies: Array<{ records: unknown; sourceName: string; importedVia: string }>
  sessionApplies: Array<{ options: unknown }>
}

function createServices(
  home: string,
  getAvailableBytes?: (path: string) => bigint,
  testOptions: { failNodePreflight?: boolean; failSessionPreflight?: boolean; failSessionApplyOnce?: boolean } = {},
): FakeServices {
  const nodeApplies: FakeServices['nodeApplies'] = []
  const sessionApplies: FakeServices['sessionApplies'] = []
  const nodes = {
    async exportManifest() {
      return {
        protocolVersion: 1,
        instanceId,
        records: [{
          metadata: {
            kind: 'node',
            originInstanceId: instanceId,
            originEntityId: 'node-private',
            localEntityId: 'node-private',
            revision: { physicalTimeMs: 1, logicalCounter: 0, writerInstanceId: instanceId },
            contentDigest: `sha256:${'a'.repeat(64)}`,
          },
          profile: {
            name: 'Private build node',
            type: 'remote-ssh',
            ssh: { host: 'secret-host.internal', port: 22, username: 'operator', auth: { kind: 'password' } },
          },
          secrets: { password: 'super-secret-node-password' },
        }],
      }
    },
    validateManifest() { return [] },
    async preflightManifest() {
      if (testOptions.failNodePreflight) throw new Error('node revision conflict')
    },
    async applyManifest(records: unknown, sourceName: string, importedVia: string) {
      nodeApplies.push({ records, sourceName, importedVia })
      return { created: 0, updated: 0, deleted: 0, pendingRemoval: 0, skipped: 0 }
    },
  }
  const sessions = {
    async exportBundle() { return makeSyncSessionBundle(instanceId, []) },
    async recoverPending() {},
    preflightBundle() {
      if (testOptions.failSessionPreflight) throw new SyncSessionError('revision-conflict', 'session revision conflict')
    },
    async applyBundle(_bundle: unknown, _sourceName: string, _peerId: string, options: unknown) {
      sessionApplies.push({ options })
      if (testOptions.failSessionApplyOnce) {
        testOptions.failSessionApplyOnce = false
        throw new Error('simulated session apply failure')
      }
      return { created: 0, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }
    },
  }
  return {
    archives: new SyncOfflineArchiveService(nodes as never, sessions as never, home, getAvailableBytes),
    nodeApplies,
    sessionApplies,
  }
}

async function* oneChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipWithUnsafeEntry(name: string, declaredBytes = 1): Buffer {
  const data = Buffer.from([0])
  const encodedName = Buffer.from(name)
  const checksum = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(declaredBytes, 22)
  local.writeUInt16LE(encodedName.length, 26)
  const first = Buffer.concat([local, encodedName, data])
  const secondName = Buffer.from('nodes.json')
  const empty = Buffer.alloc(0)
  const secondLocal = Buffer.alloc(30)
  secondLocal.writeUInt32LE(0x04034b50, 0)
  secondLocal.writeUInt16LE(20, 4)
  secondLocal.writeUInt16LE(0x0800, 6)
  secondLocal.writeUInt16LE(0, 8)
  secondLocal.writeUInt32LE(crc32(empty), 14)
  secondLocal.writeUInt32LE(0, 18)
  secondLocal.writeUInt32LE(0, 22)
  secondLocal.writeUInt16LE(secondName.length, 26)
  const second = Buffer.concat([secondLocal, secondName])
  const centralEntries: Buffer[] = []
  for (const entry of [
    { name: encodedName, checksum, compressed: 1, expanded: declaredBytes, offset: 0 },
    { name: secondName, checksum: crc32(empty), compressed: 0, expanded: 0, offset: first.length },
  ]) {
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(entry.checksum, 16)
    central.writeUInt32LE(entry.compressed, 20)
    central.writeUInt32LE(entry.expanded, 24)
    central.writeUInt16LE(entry.name.length, 28)
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38)
    central.writeUInt32LE(entry.offset, 42)
    centralEntries.push(central, entry.name)
  }
  const central = Buffer.concat(centralEntries)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(2, 8)
  end.writeUInt16LE(2, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(first.length + second.length, 16)
  return Buffer.concat([first, second, central, end])
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('offline sync archive', () => {
  it('encrypts a default configuration export and imports it as offline provenance', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'dshb-offline-source-'))
    const targetHome = mkdtempSync(join(tmpdir(), 'dshb-offline-target-'))
    homes.push(sourceHome, targetHome)
    const source = createServices(sourceHome)
    const archive = await source.archives.exportArchive('correct horse battery staple')
    try {
      const bytes = readFileSync(archive.path)
      expect(bytes.subarray(0, 8).toString()).toBe('DSHBSYNC')
      expect(bytes.includes(Buffer.from('nodes.json'))).toBe(false)
      expect(bytes.includes(Buffer.from('secret-host.internal'))).toBe(false)
      expect(bytes.includes(Buffer.from('super-secret-node-password'))).toBe(false)
      const target = createServices(targetHome)
      const result = await target.archives.importArchive('correct horse battery staple', oneChunk(bytes))
      expect(result.nodes.created).toBe(0)
      expect(target.nodeApplies).toHaveLength(1)
      expect(target.nodeApplies[0]?.importedVia).toBe('offline')
      expect(target.sessionApplies).toHaveLength(0)
    } finally {
      archive.cleanup()
    }
  })

  it('includes sessions only when explicitly enabled and preserves offline session provenance', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'dshb-offline-source-'))
    const targetHome = mkdtempSync(join(tmpdir(), 'dshb-offline-target-'))
    homes.push(sourceHome, targetHome)
    const source = createServices(sourceHome)
    const archive = await source.archives.exportArchive('correct horse battery staple', true)
    try {
      const target = createServices(targetHome)
      await target.archives.importArchive('correct horse battery staple', oneChunk(readFileSync(archive.path)))
      expect(target.sessionApplies).toHaveLength(1)
      expect(target.sessionApplies[0]?.options).toMatchObject({ importedVia: 'offline', allowSameInstance: true })
    } finally {
      archive.cleanup()
    }
  })

  it('rejects wrong passwords and ciphertext tampering before applying records', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'dshb-offline-source-'))
    const targetHome = mkdtempSync(join(tmpdir(), 'dshb-offline-target-'))
    homes.push(sourceHome, targetHome)
    const source = createServices(sourceHome)
    const archive = await source.archives.exportArchive('correct horse battery staple')
    try {
      const bytes = readFileSync(archive.path)
      const target = createServices(targetHome)
      await expect(target.archives.importArchive('incorrect password', oneChunk(bytes)))
        .rejects.toMatchObject({ code: 'password-or-integrity' })
      const tampered = Buffer.from(bytes)
      tampered[Math.floor(tampered.length / 2)]! ^= 1
      await expect(target.archives.importArchive('correct horse battery staple', oneChunk(tampered)))
        .rejects.toMatchObject({ code: 'password-or-integrity' })
      expect(target.nodeApplies).toHaveLength(0)
    } finally {
      archive.cleanup()
    }
  })

  it('rejects imports before apply when available disk space is insufficient', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'dshb-offline-source-'))
    const targetHome = mkdtempSync(join(tmpdir(), 'dshb-offline-target-'))
    homes.push(sourceHome, targetHome)
    const source = createServices(sourceHome)
    const archive = await source.archives.exportArchive('correct horse battery staple')
    try {
      const target = createServices(targetHome, () => 0n)
      await expect(target.archives.importArchive('correct horse battery staple', oneChunk(readFileSync(archive.path))))
        .rejects.toMatchObject({ code: 'disk-space' })
      expect(target.nodeApplies).toHaveLength(0)
    } finally {
      archive.cleanup()
    }
  })

  it('preflights target revision conflicts before importing nodes', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'dshb-offline-source-'))
    const targetHome = mkdtempSync(join(tmpdir(), 'dshb-offline-target-'))
    homes.push(sourceHome, targetHome)
    const source = createServices(sourceHome)
    const archive = await source.archives.exportArchive('correct horse battery staple', true)
    try {
      const target = createServices(targetHome, undefined, { failSessionPreflight: true })
      await expect(target.archives.importArchive('correct horse battery staple', oneChunk(readFileSync(archive.path))))
        .rejects.toMatchObject({ code: 'revision-conflict' })
      expect(target.nodeApplies).toHaveLength(0)
      expect(target.sessionApplies).toHaveLength(0)
    } finally {
      archive.cleanup()
    }
  })

  it('resumes node and session phases from the archive journal after a session failure', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'dshb-offline-source-'))
    const targetHome = mkdtempSync(join(tmpdir(), 'dshb-offline-target-'))
    homes.push(sourceHome, targetHome)
    const source = createServices(sourceHome)
    const archive = await source.archives.exportArchive('correct horse battery staple', true)
    try {
      const target = createServices(targetHome, undefined, { failSessionApplyOnce: true })
      const bytes = readFileSync(archive.path)
      await expect(target.archives.importArchive('correct horse battery staple', oneChunk(bytes)))
        .rejects.toMatchObject({ code: 'archive-import-failed' })
      expect(target.nodeApplies).toHaveLength(1)
      expect(target.sessionApplies).toHaveLength(1)

      await target.archives.recoverPending()

      expect(target.nodeApplies).toHaveLength(1)
      expect(target.sessionApplies).toHaveLength(2)
      expect(readdirSync(join(targetHome, 'dshb')).some((name) => name.startsWith('sync-offline-staging-'))).toBe(false)
    } finally {
      archive.cleanup()
    }
  })

  it('cleans abandoned encrypted and decrypted offline staging directories at startup', () => {
    const home = mkdtempSync(join(tmpdir(), 'dshb-offline-recovery-'))
    homes.push(home)
    const root = join(home, 'dshb')
    const abandonedImport = join(root, 'sync-offline-staging-abandoned')
    const abandonedExport = join(root, 'sync-offline-export-abandoned')
    const unrelated = join(root, 'sync-state-backup')
    mkdirSync(abandonedImport, { recursive: true })
    mkdirSync(abandonedExport, { recursive: true })
    mkdirSync(unrelated, { recursive: true })
    const service = createServices(home)

    service.archives.cleanupStagingDirectories()

    expect(existsSync(abandonedImport)).toBe(false)
    expect(existsSync(abandonedExport)).toBe(false)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('rejects impossible offline journal phase combinations', () => {
    const home = mkdtempSync(join(tmpdir(), 'dshb-offline-journal-'))
    homes.push(home)
    const journal = new SyncOfflineArchiveJournalStore(home)
    expect(() => journal.begin({
      version: 1,
      batchId: 'a'.repeat(32),
      stagingDirectory: `sync-offline-staging-${'a'.repeat(32)}`,
      zipDigest: `sha256:${'b'.repeat(64)}`,
      includeSessions: true,
      nodesApplied: false,
      sessionsApplied: true,
      startedAt: new Date().toISOString(),
    })).toThrow(/Invalid offline import journal fields/)
    expect(journal.read()).toBeUndefined()
  })

  it('rejects unsupported headers, unsafe ZIP paths and oversized expanded entries', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'dshb-offline-source-'))
    const targetHome = mkdtempSync(join(tmpdir(), 'dshb-offline-target-'))
    homes.push(sourceHome, targetHome)
    const source = createServices(sourceHome)
    const archive = await source.archives.exportArchive('correct horse battery staple')
    try {
      const bytes = readFileSync(archive.path)
      const unsupported = Buffer.from(bytes)
      unsupported.writeUInt16BE(9, 8)
      const target = createServices(targetHome)
      await expect(target.archives.importArchive('correct horse battery staple', oneChunk(unsupported)))
        .rejects.toMatchObject({ code: 'format-unsupported' })
      expect(() => validateOfflineZipArchive(zipWithUnsafeEntry('../escape'))).toThrow(SyncOfflineArchiveError)
      expect(() => validateOfflineZipArchive(zipWithUnsafeEntry('sessions.json', 129 * 1024 * 1024)))
        .toThrow(/oversized path/)
      expect(target.nodeApplies).toHaveLength(0)
    } finally {
      archive.cleanup()
    }
  })
})
