import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { SyncImportMethod } from './model.js'

interface JournalBatch {
  peerId: string
  sourceName: string
  bundleDigest: string
  startedAt: string
  recordKeys: string[]
  importedVia?: SyncImportMethod
  allowSameInstance?: boolean
}

interface JournalData {
  version: 1
  batches: Record<string, JournalBatch>
}

function sessionHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function validBatch(value: unknown): value is JournalBatch {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const batch = value as Record<string, unknown>
  return typeof batch.peerId === 'string' && /^p-[a-f0-9]{24}$/.test(batch.peerId) &&
    typeof batch.sourceName === 'string' && batch.sourceName.length <= 128 && !/[\u0000-\u001f\u007f]/.test(batch.sourceName) &&
    typeof batch.bundleDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(batch.bundleDigest) &&
    typeof batch.startedAt === 'string' && batch.startedAt.length <= 64 &&
    Array.isArray(batch.recordKeys) && batch.recordKeys.every((key) => typeof key === 'string' && key.length <= 8192) &&
    (batch.importedVia === undefined || batch.importedVia === 'peer' || batch.importedVia === 'offline') &&
    (batch.allowSameInstance === undefined || typeof batch.allowSameInstance === 'boolean')
}

function validateJournal(value: unknown): JournalData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sync session journal')
  const journal = value as Record<string, unknown>
  if (journal.version !== 1 || journal.batches === null || typeof journal.batches !== 'object' || Array.isArray(journal.batches)) {
    throw new Error('Invalid sync session journal')
  }
  const batches = Object.create(null) as Record<string, JournalBatch>
  for (const [id, batch] of Object.entries(journal.batches)) {
    if (!/^b-[a-f0-9]{32}$/.test(id) || !validBatch(batch)) throw new Error('Invalid sync session journal batch')
    batches[id] = {
      ...batch,
      importedVia: batch.importedVia ?? 'peer',
      allowSameInstance: batch.allowSameInstance ?? false,
      recordKeys: [...batch.recordKeys],
    }
  }
  return { version: 1, batches }
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(temporary)
    } catch (cleanupError) {
      if (!(cleanupError instanceof Error) || !('code' in cleanupError) || cleanupError.code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'session journal write and cleanup failed')
      }
    }
    throw error
  }
}

export class SyncSessionJournalStore {
  private readonly home: string
  private readonly filePath: string
  private data: JournalData | undefined

  constructor(home?: string) {
    this.home = sessionHome(home)
    this.filePath = join(this.home, 'dshb', 'sync-session-journal.json')
  }

  begin(
    peerId: string,
    sourceName: string,
    bundleDigest: string,
    recordKeys: readonly string[],
    startedAt = new Date().toISOString(),
    importedVia: SyncImportMethod = 'peer',
    allowSameInstance = false,
  ): string {
    const batchId = `b-${createHash('sha256').update(JSON.stringify([peerId, bundleDigest])).digest('hex').slice(0, 32)}`
    const data = this.load()
    const existing = data.batches[batchId]
    const batch: JournalBatch = {
      peerId,
      sourceName,
      bundleDigest,
      startedAt: existing?.startedAt ?? startedAt,
      recordKeys: [...new Set([...(existing?.recordKeys ?? []), ...recordKeys])],
      importedVia,
      allowSameInstance,
    }
    data.batches[batchId] = batch
    this.save()
    return batchId
  }

  beginWithBundle(
    peerId: string,
    sourceName: string,
    bundleDigest: string,
    recordKeys: readonly string[],
    bundle: unknown,
    startedAt = new Date().toISOString(),
    importedVia: SyncImportMethod = 'peer',
    allowSameInstance = false,
  ): string {
    const batchId = `b-${createHash('sha256').update(JSON.stringify([peerId, bundleDigest])).digest('hex').slice(0, 32)}`
    this.writeBundle(batchId, bundle)
    const registered = this.begin(
      peerId,
      sourceName,
      bundleDigest,
      recordKeys,
      startedAt,
      importedVia,
      allowSameInstance,
    )
    if (registered !== batchId) throw new Error('Session journal batch identity changed')
    return batchId
  }

  pendingPeerIds(): string[] {
    return [...new Set(Object.values(this.load().batches).map((batch) => batch.peerId))]
  }

  pendingBatches(): Array<{ batchId: string; peerId: string; sourceName: string; bundleDigest: string; importedVia: SyncImportMethod; allowSameInstance: boolean }> {
    return Object.entries(this.load().batches).map(([batchId, batch]) => ({
      batchId,
      peerId: batch.peerId,
      sourceName: batch.sourceName,
      bundleDigest: batch.bundleDigest,
      importedVia: batch.importedVia ?? 'peer',
      allowSameInstance: batch.allowSameInstance ?? false,
    }))
  }

  findBatch(peerId: string, bundleDigest: string): {
    batchId: string
    peerId: string
    sourceName: string
    bundleDigest: string
    importedVia: SyncImportMethod
    allowSameInstance: boolean
  } | undefined {
    const match = Object.entries(this.load().batches).find(([, batch]) =>
      batch.peerId === peerId && batch.bundleDigest === bundleDigest,
    )
    if (!match) return undefined
    const [batchId, batch] = match
    return {
      batchId,
      peerId: batch.peerId,
      sourceName: batch.sourceName,
      bundleDigest: batch.bundleDigest,
      importedVia: batch.importedVia ?? 'peer',
      allowSameInstance: batch.allowSameInstance ?? false,
    }
  }

  writeBundle(batchId: string, value: unknown): void {
    if (!/^b-[a-f0-9]{32}$/.test(batchId)) throw new Error('Invalid sync session batch ID')
    atomicWrite(this.bundlePath(batchId), value)
  }

  readBundle(batchId: string): unknown | undefined {
    try {
      return JSON.parse(readFileSync(this.bundlePath(batchId), 'utf8')) as unknown
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  writePrepared(batchId: string, recordKey: string, value: unknown): void {
    if (!/^b-[a-f0-9]{32}$/.test(batchId)) throw new Error('Invalid sync session batch ID')
    const file = this.preparedPath(batchId, recordKey)
    atomicWrite(file, value)
  }

  readPrepared(batchId: string, recordKey: string): unknown | undefined {
    const file = this.preparedPath(batchId, recordKey)
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as unknown
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  complete(batchId: string): void {
    const data = this.load()
    delete data.batches[batchId]
    this.save()
    rmSync(join(this.home, 'dshb', 'sync-session-staging', batchId), { recursive: true, force: true })
  }

  cleanupOrphanedStaging(): void {
    const root = join(this.home, 'dshb', 'sync-session-staging')
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    const activeBatches = new Set(Object.keys(this.load().batches))
    for (const entry of entries) {
      if (entry.isDirectory() && /^b-[a-f0-9]{32}$/.test(entry.name) && !activeBatches.has(entry.name)) {
        rmSync(join(root, entry.name), { recursive: true, force: true })
      }
    }
  }

  private preparedPath(batchId: string, recordKey: string): string {
    const digest = createHash('sha256').update(recordKey).digest('hex')
    return join(this.home, 'dshb', 'sync-session-staging', batchId, `${digest}.json`)
  }

  private bundlePath(batchId: string): string {
    return join(this.home, 'dshb', 'sync-session-staging', batchId, 'bundle.json')
  }

  private load(): JournalData {
    if (this.data) return this.data
    try {
      this.data = validateJournal(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.data = { version: 1, batches: {} }
      } else {
        throw error
      }
    }
    return this.data
  }

  private save(): void {
    atomicWrite(this.filePath, this.load())
  }
}
