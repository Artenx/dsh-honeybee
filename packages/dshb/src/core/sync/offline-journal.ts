import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface SyncOfflineImportJournal {
  version: 1
  batchId: string
  stagingDirectory: string
  zipDigest: string
  includeSessions: boolean
  nodesApplied: boolean
  sessionsApplied: boolean
  startedAt: string
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
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
        throw new AggregateError([error, cleanupError], 'offline journal write and cleanup failed')
      }
    }
    throw error
  }
}

function validateJournal(value: unknown): SyncOfflineImportJournal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid offline import journal')
  const journal = value as Record<string, unknown>
  if (journal.version !== 1 || typeof journal.batchId !== 'string' || !/^[a-f0-9]{32}$/.test(journal.batchId) ||
    typeof journal.stagingDirectory !== 'string' || journal.stagingDirectory !== `sync-offline-staging-${journal.batchId}` ||
    typeof journal.zipDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(journal.zipDigest) ||
    typeof journal.includeSessions !== 'boolean' || typeof journal.nodesApplied !== 'boolean' ||
    typeof journal.sessionsApplied !== 'boolean' || (!journal.includeSessions && !journal.sessionsApplied) ||
    (journal.includeSessions && journal.sessionsApplied && !journal.nodesApplied) ||
    typeof journal.startedAt !== 'string' || journal.startedAt.length > 64) {
    throw new Error('Invalid offline import journal fields')
  }
  return journal as unknown as SyncOfflineImportJournal
}

export class SyncOfflineArchiveJournalStore {
  private readonly filePath: string

  constructor(home: string) {
    this.filePath = join(home, 'dshb', 'sync-offline-journal.json')
  }

  read(): SyncOfflineImportJournal | undefined {
    try {
      return validateJournal(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  begin(journal: SyncOfflineImportJournal): void {
    if (this.read()) throw new Error('An offline import batch is already pending')
    atomicWrite(this.filePath, validateJournal(journal))
  }

  update(patch: Partial<Pick<SyncOfflineImportJournal, 'nodesApplied' | 'sessionsApplied'>>): SyncOfflineImportJournal {
    const current = this.read()
    if (!current) throw new Error('Offline import journal is missing')
    const updated = validateJournal({ ...current, ...patch })
    atomicWrite(this.filePath, updated)
    return updated
  }

  complete(): void {
    try {
      unlinkSync(this.filePath)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
}
