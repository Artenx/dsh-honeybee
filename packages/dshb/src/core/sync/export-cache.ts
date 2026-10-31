import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isRecord, isNonNegativeSafeInteger } from './model.js'
import type { SyncRecordMetadata } from './model.js'

const MAX_EXPORT_CACHE_FILE_BYTES = 8 * 1024 * 1024

export interface PersistedSessionExportCacheEntry {
  fingerprint: string
  metadata: SyncRecordMetadata
  eventCount: number
  eventDigest: string
  inheritedEventCount: number
}

interface PersistedExportCache {
  version: 1
  entries: Record<string, PersistedSessionExportCacheEntry>
}

function cacheHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function atomicWrite(file: string, content: string): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
    chmodSync(file, 0o600)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

function validRevision(value: unknown): boolean {
  return isRecord(value) && isNonNegativeSafeInteger(value.physicalTimeMs) &&
    isNonNegativeSafeInteger(value.logicalCounter) && typeof value.writerInstanceId === 'string' && !!value.writerInstanceId
}

function validEntry(value: unknown): value is PersistedSessionExportCacheEntry {
  if (!isRecord(value) || typeof value.fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.fingerprint) ||
    !isRecord(value.metadata) || typeof value.metadata.contentDigest !== 'string' || !validRevision(value.metadata.revision) ||
    !isNonNegativeSafeInteger(value.eventCount) || typeof value.eventDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.eventDigest) || !isNonNegativeSafeInteger(value.inheritedEventCount)) {
    return false
  }
  return true
}

export class SyncSessionExportCacheStore {
  private readonly filePath: string
  private data: PersistedExportCache | undefined
  private dirty = false

  constructor(home?: string) {
    this.filePath = join(cacheHome(home), 'dshb', 'sync-export-cache.json')
  }

  get(key: string): PersistedSessionExportCacheEntry | undefined {
    return this.load().entries[key]
  }

  set(key: string, entry: PersistedSessionExportCacheEntry): void {
    if (!validEntry(entry)) return
    this.load().entries[key] = entry
    this.dirty = true
  }

  delete(key: string): void {
    if (!(key in this.load().entries)) return
    delete this.load().entries[key]
    this.dirty = true
  }

  flush(): void {
    if (!this.dirty || !this.data) return
    this.dirty = false
    try {
      atomicWrite(this.filePath, `${JSON.stringify(this.data)}\n`)
    } catch {
      this.dirty = true
    }
  }

  entries(): Iterable<[string, PersistedSessionExportCacheEntry]> {
    return Object.entries(this.load().entries)
  }

  private load(): PersistedExportCache {
    if (this.data) return this.data
    let restored: PersistedExportCache = { version: 1, entries: {} }
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      if (raw.length <= MAX_EXPORT_CACHE_FILE_BYTES) {
        const parsed: unknown = JSON.parse(raw)
        if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.entries)) {
          const entries: Record<string, PersistedSessionExportCacheEntry> = {}
          for (const [key, entry] of Object.entries(parsed.entries)) {
            if (/^\[".+?",(null|".*?")\]$/.test(key) && validEntry(entry)) entries[key] = entry
          }
          restored = { version: 1, entries }
        }
      }
    } catch {}
    this.data = restored
    return restored
  }
}
