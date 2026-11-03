import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, createReadStream, mkdirSync } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { access, lstat, mkdir, open, readdir, realpath, rename, stat as statFs, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, normalize as normalizeHostPath, posix, resolve } from 'node:path'
import {
  SESSION_FORMAT_VERSION,
  SessionId as makeSessionId,
  snapshotSessionEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { assertContiguous, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { INSTRUCTION_MAX_BYTES, InstructionSizeError, sharedWorkspaceInstructionStore, type SessionInstructionSnapshot } from '../workspace-instructions.js'
import { SessionInstructionSnapshotStore, WorkspaceInstructionStore } from '../workspace-instructions.js'
import type { NodeRegistry, NodeType } from '../node-registry.js'
import type { WorkspaceBindingsStore } from '../workspace-bindings.js'
import { SyncNodeService } from './node-sync.js'
import { compareSyncRevision, HybridLogicalClock } from './revision.js'
import type { SyncRevision } from './revision.js'
import { isNonNegativeSafeInteger, isRecord, syncRecordKey, syncWorkspaceKey } from './model.js'
import type {
  SyncCatalogSession,
  SyncCatalogWorkspace,
  SyncImportMethod,
  SyncOrigin,
  SyncRecordMetadata,
  SyncSessionArchive,
  SyncState,
  SyncWorkspaceMapping,
} from './model.js'
import { SyncStateStore } from './stores.js'
import { SyncSessionJournalStore } from './session-journal.js'
import { SyncSessionExportCacheStore } from './export-cache.js'
import { MAX_SESSION_OBJECT_INLINE_BYTES, MAX_SESSION_OBJECT_STREAM_BYTES, MAX_SYNC_TRANSFER_BYTES } from './protocol.js'

const SESSION_READ_PAGE_SIZE = 256
const MAX_SYNC_SESSIONS = 10_000
// 单个会话条目的序列化体积上限：MAX_SYNC_TRANSFER_BYTES 内为 bundle 信封与
// 同批其他条目留出余量。超出该体积的会话在导出时记为 skipped（见
// exportSessionEntry），保证一个巨型会话不会让整次同步反复失败。
const MAX_SESSION_EXPORT_ENTRY_BYTES = 96 * 1024 * 1024
const MAX_MANIFEST_PAYLOAD_CACHE_BYTES = 4 * 1024 * 1024
const MAX_MANIFEST_PAYLOAD_CACHE_COUNT = 8
// Bump when sessionEventDigest's normalization changes.
const SESSION_EXPORT_CACHE_VERSION = 1
const SPILL_META_VERSION = 1
const SPILL_ARTIFACT_META_KEY = '@deepseek-ai/dsh-spill'

interface SpillTransferReference {
  owner: { sessionId: string }
  source: { toolName: string; callId: string; label: string }
  suggestedName: string
  ref: { locator: string; bytes?: number; retrievalHint: string }
}

const LEGACY_LOCAL_SPILL_HINT = 'Use read with offset/limit, or grep this path to search within it.'
const LEGACY_LOCAL_SPILL_MARKER = 'Full formatted result stored at: '
const LEGACY_LOCAL_SPILL_SUFFIX = `. ${LEGACY_LOCAL_SPILL_HINT})`

export interface SyncSessionWorkspace {
  originInstanceId: string
  originWorkspaceId: string
  nodeOrigin: SyncOrigin
  remotePath: string
  title: string
  revision: SyncRevision
  contentDigest: string
}

export interface SyncSessionInstructionSnapshot {
  text: string
  capturedAt: string
  workspaceOrigin?: SyncOrigin
  workspaceRemotePath?: string
  workspaceRevision?: number
  digest?: string
  inheritedFromOrigin?: SyncOrigin
}

export interface SyncSessionEventDelta {
  baseEventCount: number
  baseEventDigest: string
  baseInheritedEventCount: number
  fullEventCount: number
  fullEventDigest: string
}

export type SyncSessionObject =
  | { id: string; kind: 'image'; ref: ImageAttachmentRef; bytes: number; digest: string; data: string; deferred?: boolean }
  | { id: string; kind: 'file'; ref: FileAttachmentRef; bytes: number; digest: string; data: string; deferred?: boolean }
  | {
      id: string
      kind: 'spill'
      reference: SpillTransferReference
      bytes: number
      digest: string
      data: string
      unavailable?: boolean
      deferred?: boolean
    }

export interface SyncSessionEntry {
  metadata: SyncRecordMetadata
  branchId?: string
  sourceLocalSessionId?: string
  header?: SessionHeader
  inheritedEventCount?: number
  parentOrigin?: SyncOrigin
  workspace?: SyncSessionWorkspace
  workspacePosition?: number
  archived?: boolean
  pinned?: boolean
  instructionSnapshot?: SyncSessionInstructionSnapshot
  events?: SessionEvent[]
  objects?: SyncSessionObject[]
  sharedObjectIds?: string[]
  eventDelta?: SyncSessionEventDelta
  eventCount?: number
  eventDigest?: string
}

export interface SyncSessionBundle {
  protocolVersion: 1
  instanceId: string
  entries: SyncSessionEntry[]
  skipped: Array<{ sessionId: string; reason: string }>
  objects?: SyncSessionObject[]
  digest: string
}

export type SyncSessionManifestEntry = Pick<SyncSessionEntry, 'metadata' | 'branchId'> & {
  eventCount?: number
  eventDigest?: string
  inheritedEventCount?: number
}

export interface SyncSessionEventPrefix {
  key: string
  eventCount: number
  eventDigest: string
  inheritedEventCount: number
}

export interface SyncSessionManifest {
  protocolVersion: 1
  instanceId: string
  entries: SyncSessionManifestEntry[]
  skipped: Array<{ sessionId: string; reason: string }>
  digest: string
}

export interface SyncSessionApplyResult {
  created: number
  updated: number
  archived: number
  deleted: number
  skipped: number
  unmapped: number
}

interface PreparedSyncSession {
  metadata: SyncRecordMetadata
  branchId?: string
  localSessionId: SessionId
  header: SessionHeader
  inheritedEventCount: number
  events: SessionEvent[]
  workspaceId: string
  workspacePath: string
  workspace: SyncSessionWorkspace
  workspacePosition: number
  archived: boolean
  pinned: boolean
  sourceName: string
  importedVia: SyncImportMethod
  instructionSnapshot?: SessionInstructionSnapshot
}

export interface SyncSessionApplyOptions {
  importedVia?: SyncImportMethod
  allowSameInstance?: boolean
}

type SyncSessionJournalBatch = ReturnType<SyncSessionJournalStore['pendingBatches']>[number]

type ImportedSessionObjectRef = ImageAttachmentRef | FileAttachmentRef | SpillTransferReference['ref']

interface SessionExportCacheEntry {
  fingerprint: string
  metadata: SyncRecordMetadata
  eventCount: number
  eventDigest: string
  inheritedEventCount: number
}

interface SessionExportResult {
  entry: SyncSessionEntry
  eventCount: number
  eventDigest: string
  inheritedEventCount: number
}

interface SessionExportOptions {
  manifestOnly?: boolean
  selectedKeys?: ReadonlySet<string>
  payloadCache?: SessionManifestPayloadCache
  catalog?: { workspaces: Map<string, SyncCatalogWorkspace>; sessions: SyncCatalogSession[] }
  sharedObjects?: boolean
  deferredObjects?: boolean
}

interface ExportObjectCacheEntry {
  object: SyncSessionObject
}

/**
 * 带外对象收件箱：对端推送/拉取的大对象（附件/spill）先落盘到
 * `<home>/dshb/sync-objects/<sha256hex>`，apply 阶段按 digest 流式水合进
 * 本地存储并删除。落盘全程流式（内存 O(单帧)），对象总体积不受堆约束。
 * apply 失败时收件箱保留（journal 回放仍可水合），孤儿文件由 TTL 清扫回收。
 */
export interface SyncObjectInboxWriter {
  write(chunk: Uint8Array): Promise<void>
  commit(): Promise<void>
  abort(): Promise<void>
}

export class SyncSessionObjectInbox {
  private readonly root: string

  constructor(home?: string) {
    this.root = join(home ?? process.env.DSH_HOME ?? homedir(), 'dshb', 'sync-objects')
  }

  get path(): string {
    return this.root
  }

  private fileFor(digest: string): string | undefined {
    const match = /^sha256:([a-f0-9]{64})$/.exec(digest)
    if (!match) return undefined
    return join(this.root, match[1])
  }

  /**
   * 打开一个收件箱写入器：逐帧流式写盘 + 增量摘要校验，内存 O(帧)。
   * commit() 校验字节数与 digest 后原子重命名；abort() 清理临时文件。
   */
  async writerFor(digest: string, expectedBytes: number): Promise<SyncObjectInboxWriter> {
    const file = this.fileFor(digest)
    if (!file) throw new SyncSessionError('object-invalid', 'session object digest is invalid')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    const hash = createHash('sha256')
    const handle = await open(temporary, 'wx', 0o600)
    let written = 0
    let closed = false
    const closeHandle = async (): Promise<void> => {
      if (closed) return
      closed = true
      await handle.close().catch(() => {})
    }
    return {
      async write(chunk: Uint8Array): Promise<void> {
        if (closed) throw new SyncSessionError('object-invalid', 'session object writer is closed')
        written += chunk.byteLength
        if (written > expectedBytes) throw new SyncSessionError('object-integrity', 'session object stream exceeds declared bytes')
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null)
          if (bytesWritten <= 0) throw new SyncSessionError('object-integrity', 'session object stream write made no progress')
          offset += bytesWritten
        }
      },
      async commit(): Promise<void> {
        if (written !== expectedBytes || `sha256:${hash.digest('hex')}` !== digest) {
          await closeHandle()
          try {
            await unlink(temporary)
          } catch {}
          throw new SyncSessionError('object-integrity', 'session object stream digest mismatch')
        }
        await handle.sync()
        await closeHandle()
        await rename(temporary, file)
      },
      async abort(): Promise<void> {
        await closeHandle()
        try {
          await unlink(temporary)
        } catch {}
      },
    }
  }

  /** 便捷写入：把对象流整段写进收件箱（测试与小对象用）。 */
  async write(digest: string, bytes: number, stream: AsyncIterable<Uint8Array>): Promise<void> {
    const writer = await this.writerFor(digest, bytes)
    try {
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
          throw new SyncSessionError('object-invalid', 'session object stream contains an invalid chunk')
        }
        await writer.write(chunk)
      }
      await writer.commit()
    } catch (error) {
      await writer.abort()
      throw error
    }
  }

  /** 打开收件箱文件的只读流（apply 水合用）；调用方负责消费完毕。 */
  async read(digest: string): Promise<AsyncIterable<Uint8Array>> {
    const file = this.fileFor(digest)
    if (!file) throw new SyncSessionError('object-missing', 'session object is not in the inbox')
    try {
      await access(file)
    } catch {
      throw new SyncSessionError('object-missing', 'session object is not in the inbox')
    }
    return createReadStream(file)
  }

  async delete(digest: string): Promise<void> {
    const file = this.fileFor(digest)
    if (!file) return
    try {
      await unlink(file)
    } catch {}
  }

  /** TTL 清扫：删除超过 maxAgeMs 未修改的孤儿文件。 */
  async sweep(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return 0
    }
    const cutoff = Date.now() - maxAgeMs
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}(\.|$)/.test(entry.name)) continue
      const file = join(this.root, entry.name)
      try {
        const stats: Stats = await statFs(file)
        if (stats.mtimeMs < cutoff) {
          await unlink(file)
          removed += 1
        }
      } catch {}
    }
    return removed
  }
}


/**
 * 导出期附件对象缓存：跨会话去重同一附件（同 id 只读一次存储、只算一次摘要）。
 * 附件对象携带 base64 数据，若整轮导出无上限持有（此前是普通 Map），多图会话的
 * 首次同步会把堆吃满（桌面端 OOM 崩溃的直接推手之一）。这里按原始字节数做
 * LRU 上限，超限淘汰最早条目；被淘汰的附件在后续会话中按 cache miss 重新读取。
 */
const MAX_EXPORT_OBJECT_CACHE_BYTES = 64 * 1024 * 1024

export class ExportObjectCache {
  private readonly entries = new Map<string, ExportObjectCacheEntry>()
  private bytes = 0

  get(key: string): ExportObjectCacheEntry | undefined {
    return this.entries.get(key)
  }

  set(key: string, entry: ExportObjectCacheEntry): void {
    const existing = this.entries.get(key)
    if (existing) this.bytes -= existing.object.bytes
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.bytes += entry.object.bytes
    while (this.bytes > MAX_EXPORT_OBJECT_CACHE_BYTES && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      const removed = this.entries.get(oldest)
      this.entries.delete(oldest)
      if (removed) this.bytes -= removed.object.bytes
    }
  }
}

interface SessionManifestPayloadCache {
  instanceId: string
  entries: Map<string, SyncSessionEntry>
  bytes: number
}

export interface SyncSessionTransferPlan {
  toLocal: SyncSessionEntry[]
  toRemote: SyncSessionEntry[]
  skipped: number
}

export class SyncSessionError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SyncSessionError'
  }
}

interface SessionSnapshotLike {
  header: SessionHeader
  formatStatus?: 'current' | 'migration-required'
  revision: unknown
  eventCount?: number
  sizeBytes?: number
}

interface SessionMetadataSnapshot {
  snapshot: SessionSnapshotLike
  header: SessionHeader
  inheritedEventCount: number
}

interface SessionHandleLike {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  read(offset?: number, length?: number): Promise<{ events: readonly SessionEvent[] }>
  append(events: readonly SessionEvent[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

interface SessionPersistenceLike {
  flush(): Promise<void>
  list(): Promise<readonly SessionSnapshotLike[]>
  stat(id: SessionId): Promise<SessionSnapshotLike | undefined>
  open(id: SessionId, access: 'read' | 'write'): Promise<SessionHandleLike>
  create(header: SessionHeader, options?: { inheritedEventCount?: number }): Promise<SessionHandleLike>
}

async function readStableSessionMetadata(
  persistence: SessionPersistenceLike,
  sessionId: SessionId,
  firstSnapshot: SessionSnapshotLike,
): Promise<SessionMetadataSnapshot | undefined> {
  const handle = await persistence.open(sessionId, 'read')
  try {
    const snapshot = await persistence.stat(sessionId)
    if (!snapshot || snapshot.formatStatus === 'migration-required') return undefined
    try {
      if (
        canonicalJson(firstSnapshot.revision) !== canonicalJson(snapshot.revision) ||
        canonicalJson(firstSnapshot.header) !== canonicalJson(snapshot.header) ||
        canonicalJson(handle.header) !== canonicalJson(snapshot.header)
      ) return undefined
    } catch {
      return undefined
    }
    const inheritedEventCount = Number(handle.inheritedEventCount)
    if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) return undefined
    return { snapshot, header: handle.header, inheritedEventCount }
  } finally {
    await handle.close()
  }
}

interface WorkspaceLike {
  id: string
  path: string
  title: string
  sessionIds: readonly SessionId[]
  setTitle(title: string): Promise<void>
  attachSession(sessionId: SessionId): Promise<void>
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>
}

export interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  get(id: string): WorkspaceLike | undefined
  create(path: string, title?: string): Promise<WorkspaceLike>
  archiveSession(sessionId: SessionId, options?: { stopActivity?: boolean }): Promise<void>
  unarchiveSession(sessionId: SessionId): Promise<void>
  pinSession?(sessionId: SessionId): Promise<void>
  unpinSession?(sessionId: SessionId): Promise<void>
  readonly archivedSessionIds: readonly SessionId[]
  readonly pinnedSessionIds?: readonly SessionId[]
}

interface AttachmentStoreLike {
  readImage(ref: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
  saveImage(input: { data: Uint8Array; mediaType: ImageAttachmentRef['mediaType']; name?: string }): Promise<ImageAttachmentRef>
  readFileStream(ref: FileAttachmentRef): AsyncIterable<Uint8Array>
  saveFileStream(input: { data: AsyncIterable<Uint8Array>; name?: string }): Promise<FileAttachmentRef>
}

interface SpillStoreLike {
  root?: string
  readTextStream?(input: { owner: { sessionId: SessionId }; ref: SpillTransferReference['ref'] }): AsyncIterable<Uint8Array>
  saveTextStream?(input: {
    owner: { sessionId: SessionId }
    source: SpillTransferReference['source']
    suggestedName: string
    transferId: string
    bytes: number
    digest: string
    content: AsyncIterable<Uint8Array>
  }): Promise<SpillTransferReference['ref']>
}

function spillSessionDirectoryName(sessionId: string): string {
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
}

function spillTransferReferenceError(cause?: unknown): SyncSessionError {
  return new SyncSessionError('spill-integrity', 'spill artifact could not be safely transferred', cause)
}

async function* readLocalSpillFile(
  configuredRoot: string | undefined,
  reference: SpillTransferReference,
): AsyncGenerator<Uint8Array> {
  const filePath = resolve(reference.ref.locator)
  const sessionDirectory = dirname(filePath)
  const root = dirname(sessionDirectory)
  const expectedSessionDirectory = spillSessionDirectoryName(reference.owner.sessionId)
  const leaf = basename(filePath)
  if (
    filePath !== reference.ref.locator || basename(sessionDirectory) !== expectedSessionDirectory ||
    !/^(?:[a-f0-9]{12}-.+|transfer-[a-f0-9]{64})$/.test(leaf)
  ) throw spillTransferReferenceError()

  const normalizedRoot = resolve(root)
  const normalizedConfiguredRoot = configuredRoot === undefined ? undefined : resolve(configuredRoot)
  if (normalizedRoot !== normalizedConfiguredRoot) {
    const tempRoot = resolve(tmpdir())
    if (dirname(normalizedRoot) !== tempRoot || !basename(normalizedRoot).startsWith('dsh-spill-')) {
      throw spillTransferReferenceError()
    }
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const rootPath = await realpath(normalizedRoot)
    const expectedDirectory = join(rootPath, expectedSessionDirectory)
    if (await realpath(sessionDirectory) !== expectedDirectory) throw spillTransferReferenceError()
    const directoryStat = await lstat(sessionDirectory)
    const entryStat = await lstat(filePath)
    const expectedBytes = reference.ref.bytes ?? entryStat.size
    if (
      directoryStat.isSymbolicLink() || !directoryStat.isDirectory() ||
      entryStat.isSymbolicLink() || !entryStat.isFile() || entryStat.size !== expectedBytes ||
      !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
      (process.platform !== 'win32' && ((directoryStat.mode & 0o077) !== 0 || (entryStat.mode & 0o077) !== 0))
    ) throw spillTransferReferenceError()

    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow)
    const openedStat = await handle.stat()
    if (
      !openedStat.isFile() || openedStat.size !== expectedBytes ||
      (entryStat.ino !== 0 && openedStat.ino !== 0 && entryStat.ino !== openedStat.ino) ||
      (entryStat.dev !== 0 && openedStat.dev !== 0 && entryStat.dev !== openedStat.dev)
    ) throw spillTransferReferenceError()

    let bytes = 0
    for (;;) {
      const buffer = Buffer.allocUnsafe(64 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      bytes += bytesRead
      if (bytes > expectedBytes) throw spillTransferReferenceError()
      yield buffer.subarray(0, bytesRead)
    }
    const finalStat = await handle.stat()
    if (bytes !== expectedBytes || finalStat.size !== expectedBytes || finalStat.mtimeMs !== openedStat.mtimeMs) {
      throw spillTransferReferenceError()
    }
  } catch (error) {
    if (error instanceof SyncSessionError) throw error
    throw spillTransferReferenceError(error)
  } finally {
    if (handle) await handle.close()
  }
}

function isUnownedSpillRead(error: unknown): boolean {
  return error instanceof Error && error.name === 'SpillReadError' &&
    'code' in error && (error as Error & { code?: unknown }).code === 'not-owned'
}

async function* readSpillStream(store: SpillStoreLike, reference: SpillTransferReference): AsyncGenerator<Uint8Array> {
  if (store.readTextStream) {
    try {
      yield* store.readTextStream({ owner: { sessionId: makeSessionId(reference.owner.sessionId) }, ref: reference.ref })
      return
    } catch (error) {
      if (!isUnownedSpillRead(error)) throw error
    }
  }
  yield* readLocalSpillFile(store.root, reference)
}

async function writeLocalSpillTransfer(
  root: string,
  input: {
    owner: { sessionId: SessionId }
    transferId: string
    bytes: number
    digest: string
    data: Buffer
  },
): Promise<SpillTransferReference['ref']> {
  if (!input.transferId || input.transferId.length > 4096 || input.bytes !== input.data.byteLength || sha256(input.data) !== input.digest) {
    throw new SyncSessionError('spill-integrity', 'spill transfer metadata is invalid')
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(input.data)
  } catch (error) {
    throw new SyncSessionError('spill-integrity', 'spill content is not valid UTF-8', error)
  }

  let rootPath: string
  let directory: string
  let filePath: string
  const sessionId = String(input.owner.sessionId)
  try {
    await mkdir(resolve(root), { recursive: true, mode: 0o700 })
    rootPath = await realpath(resolve(root))
    directory = join(rootPath, spillSessionDirectoryName(sessionId))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await realpath(directory) !== directory) throw spillTransferReferenceError()
    const directoryStat = await lstat(directory)
    if (
      directoryStat.isSymbolicLink() || !directoryStat.isDirectory() ||
      (process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0)
    ) throw spillTransferReferenceError()
    filePath = join(directory, `transfer-${createHash('sha256').update(input.transferId).digest('hex')}`)
  } catch (error) {
    if (error instanceof SyncSessionError) throw error
    throw spillTransferReferenceError(error)
  }

  const ref: SpillTransferReference['ref'] = {
    locator: filePath as SpillTransferReference['ref']['locator'],
    bytes: input.bytes,
    retrievalHint: LEGACY_LOCAL_SPILL_HINT,
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'wx', 0o600)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await collectBytes(readLocalSpillFile(rootPath, { owner: { sessionId }, source: { toolName: 'sync', callId: input.transferId, label: 'spill' }, suggestedName: 'spill.txt', ref }))
      if (existing.byteLength === input.bytes && sha256(existing) === input.digest) return ref
      throw new SyncSessionError('spill-transfer-conflict', 'spill transfer key already contains different content', error)
    }
    throw spillTransferReferenceError(error)
  }

  try {
    let offset = 0
    while (offset < input.data.byteLength) {
      const { bytesWritten } = await handle.write(input.data, offset, input.data.byteLength - offset, null)
      if (bytesWritten === 0) throw spillTransferReferenceError()
      offset += bytesWritten
    }
    await handle.sync()
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== input.bytes || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw spillTransferReferenceError()
    }
  } catch (error) {
    await handle.close()
    handle = undefined
    try {
      await unlink(filePath)
    } catch {}
    if (error instanceof SyncSessionError) throw error
    throw spillTransferReferenceError(error)
  } finally {
    if (handle) await handle.close()
  }
  return ref
}

async function saveSpillTransfer(
  store: SpillStoreLike,
  input: {
    owner: { sessionId: SessionId }
    source: SpillTransferReference['source']
    suggestedName: string
    transferId: string
    bytes: number
    digest: string
    /** 内联路径的载荷；content 提供时可不传。 */
    data?: Buffer
    /** 带外水合：已校验摘要的原始内容流（需要 store 支持 saveTextStream）。 */
    content?: AsyncIterable<Uint8Array>
  },
): Promise<SpillTransferReference['ref']> {
  if (store.saveTextStream) {
    if (input.content !== undefined) {
      return store.saveTextStream({
        owner: input.owner,
        source: input.source,
        suggestedName: input.suggestedName,
        transferId: input.transferId,
        bytes: input.bytes,
        digest: input.digest,
        content: input.content,
      })
    }
    return store.saveTextStream({
      owner: input.owner,
      source: input.source,
      suggestedName: input.suggestedName,
      transferId: input.transferId,
      bytes: input.bytes,
      digest: input.digest,
      content: oneChunk(input.data!),
    })
  }
  if (typeof store.root === 'string' && input.content === undefined && input.data !== undefined) {
    return writeLocalSpillTransfer(store.root, { ...input, data: input.data })
  }
  throw new SyncSessionError('spill-transfer-unavailable', '目标实例的 spill provider 不支持安全写入')
}

interface WorkspaceCandidate {
  workspace: WorkspaceLike
  binding: { mirrorPath: string; nodeId: string; remotePath: string; workspaceId?: string }
  nodeOrigin: SyncOrigin
  nodeType: NodeType
  descriptor: SyncSessionWorkspace
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function objectKey(kind: SyncSessionObject['kind'], id: string): string {
  return JSON.stringify([kind, id])
}

function attachmentKey(kind: 'image' | 'file', ref: ImageAttachmentRef | FileAttachmentRef): string {
  return objectKey(kind, `${ref.attachmentId}\0${ref.name ?? ''}`)
}

function spillKey(reference: SpillTransferReference): string {
  return objectKey('spill', `${reference.owner.sessionId}\0${reference.ref.locator}`)
}

function sessionOriginKey(metadata: SyncRecordMetadata): string {
  return syncRecordKey('session', metadata)
}

function isImageRef(value: unknown): value is ImageAttachmentRef {
  return isRecord(value) && typeof value.attachmentId === 'string' && typeof value.mediaType === 'string' &&
    isNonNegativeSafeInteger(value.bytes) && isNonNegativeSafeInteger(value.width) && isNonNegativeSafeInteger(value.height)
}

function isFileRef(value: unknown): value is FileAttachmentRef {
  return isRecord(value) && typeof value.attachmentId === 'string' && typeof value.name === 'string' &&
    isNonNegativeSafeInteger(value.bytes) && value.mediaType === undefined
}

function spillReferences(value: unknown): SpillTransferReference[] {
  const output: SpillTransferReference[] = []
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry)
      return
    }
    if (!isRecord(current)) return
    const spillMeta = current[SPILL_ARTIFACT_META_KEY]
    if (spillMeta !== undefined) {
      if (
        !isRecord(spillMeta) || spillMeta.version !== SPILL_META_VERSION || !Array.isArray(spillMeta.references)
      ) throw new SyncSessionError('spill-metadata-invalid', 'spill references are invalid')
      for (const reference of spillMeta.references) {
        if (
          !isRecord(reference) || !isRecord(reference.owner) || typeof reference.owner.sessionId !== 'string' ||
          !isRecord(reference.source) || typeof reference.source.toolName !== 'string' ||
          typeof reference.source.callId !== 'string' || typeof reference.source.label !== 'string' ||
          typeof reference.suggestedName !== 'string' || !isRecord(reference.ref) ||
          typeof reference.ref.locator !== 'string' ||
          (reference.ref.bytes !== undefined && !isNonNegativeSafeInteger(reference.ref.bytes)) ||
          typeof reference.ref.retrievalHint !== 'string'
        ) throw new SyncSessionError('spill-metadata-invalid', 'spill reference fields are invalid')
        output.push(reference as unknown as SpillTransferReference)
      }
    }
    for (const child of Object.values(current)) visit(child)
  }
  visit(value)
  return output
}

function legacySpillReferences(events: readonly SessionEvent[], sessionId: string): SpillTransferReference[] {
  const toolNames = new Map<string, string>()
  for (const event of events as readonly { type: string; data: unknown }[]) {
    if (event.type !== 'tool/call') continue
    const data = isRecord(event.data) ? event.data as { callId?: string; name?: string } : {}
    if (typeof data.callId === 'string' && typeof data.name === 'string') toolNames.set(data.callId, data.name)
  }
  const found = new Map<string, SpillTransferReference>()
  const scan = (value: unknown, source: SpillTransferReference['source']): void => {
    if (Array.isArray(value)) {
      for (const child of value) scan(child, source)
      return
    }
    if (!isRecord(value)) return
    if (value.type === 'text' && typeof value.text === 'string') {
      let start = value.text.indexOf(LEGACY_LOCAL_SPILL_MARKER)
      while (start >= 0) {
        const locatorStart = start + LEGACY_LOCAL_SPILL_MARKER.length
        const end = value.text.indexOf(LEGACY_LOCAL_SPILL_SUFFIX, locatorStart)
        if (end < 0) throw new SyncSessionError('spill-format-unsupported', '旧 spill 通知格式无法安全识别')
        const locator = value.text.slice(locatorStart, end)
        if (!locator || locator.length > 4096 || /[\u0000-\u001f\u007f]/.test(locator)) {
          throw new SyncSessionError('spill-format-unsupported', '旧 spill locator 无效')
        }
        const reference: SpillTransferReference = {
          owner: { sessionId },
          source,
          suggestedName: `${source.toolName}.txt`,
          ref: { locator, retrievalHint: LEGACY_LOCAL_SPILL_HINT },
        }
        found.set(spillKey(reference), reference)
        start = value.text.indexOf(LEGACY_LOCAL_SPILL_MARKER, end + LEGACY_LOCAL_SPILL_SUFFIX.length)
      }
    }
    for (const child of Object.values(value)) scan(child, source)
  }

  for (const event of events as readonly { type: string; data: unknown }[]) {
    if (event.type === 'tool/result') {
      const data = isRecord(event.data) ? event.data : {}
      const message = isRecord(data.message) ? data.message as { source?: { callId?: string }; content?: unknown } : {}
      const callId = message.source?.callId
      if (typeof callId === 'string') {
        scan(message.content, { toolName: toolNames.get(callId) ?? 'unknown', callId, label: 'result' })
      }
    } else if (event.type === 'tool/code-dispatch') {
      const data = isRecord(event.data) ? event.data as { name?: string; subCallId?: string; content?: unknown } : {}
      if (typeof data.name === 'string' && typeof data.subCallId === 'string') {
        scan(data.content, { toolName: data.name, callId: data.subCallId, label: 'dispatch' })
      }
    }
  }
  return [...found.values()]
}

function attachmentReferences(events: readonly SessionEvent[]): { images: ImageAttachmentRef[]; files: FileAttachmentRef[] } {
  const images = new Map<string, ImageAttachmentRef>()
  const files = new Map<string, FileAttachmentRef>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (!isRecord(value)) return
    if (value.type === 'image' && isImageRef(value.attachment)) images.set(attachmentKey('image', value.attachment), value.attachment)
    if (value.type === 'file' && isFileRef(value.attachment)) files.set(attachmentKey('file', value.attachment), value.attachment)
    for (const child of Object.values(value)) visit(child)
  }
  for (const event of events) visit(event)
  return { images: [...images.values()], files: [...files.values()] }
}

function sessionEventDigest(
  header: SessionHeader,
  inheritedEventCount: number,
  events: readonly SessionEvent[],
  workspace: SyncSessionWorkspace,
  instructionSnapshot: SyncSessionInstructionSnapshot | undefined,
  objects: readonly SyncSessionObject[],
  parentOrigin: SyncOrigin | undefined,
): string {
  const imageDigests = new Map<string, SyncSessionObject>()
  const fileDigests = new Map<string, SyncSessionObject>()
  const spillDigests = new Map<string, SyncSessionObject>()
  for (const object of objects) {
    if (object.kind === 'image') imageDigests.set(attachmentKey('image', object.ref), object)
    else if (object.kind === 'file') fileDigests.set(attachmentKey('file', object.ref), object)
    else spillDigests.set(spillKey(object.reference), object)
  }

  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (!isRecord(value)) return value
    if (value.type === 'image' && isImageRef(value.attachment)) {
      const object = imageDigests.get(attachmentKey('image', value.attachment))
      return object
        ? { type: 'image', digest: object.digest, ...(value.attachment.name ? { name: value.attachment.name } : {}) }
        : { type: 'image', missing: value.attachment.attachmentId }
    }
    if (value.type === 'file' && isFileRef(value.attachment)) {
      const object = fileDigests.get(attachmentKey('file', value.attachment))
      return object ? { type: 'file', digest: object.digest, name: value.attachment.name } : { type: 'file', missing: value.attachment.attachmentId }
    }
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === SPILL_ARTIFACT_META_KEY && isRecord(child) && Array.isArray(child.references)) {
        output[key] = {
          version: child.version,
          references: child.references.map((reference) => {
            if (!isRecord(reference) || !isRecord(reference.ref)) return reference
            const spill = spillDigests.get(spillKey(reference as unknown as SpillTransferReference))
            return spill
              ? { source: reference.source, suggestedName: reference.suggestedName, digest: spill.digest, bytes: spill.bytes }
              : { source: reference.source, suggestedName: reference.suggestedName, missing: reference.ref.locator }
          }),
        }
      } else if (key === 'text' && typeof child === 'string') {
        let text = child
        for (const object of objects) {
          if (object.kind !== 'spill') continue
          const ref = object.reference.ref
          text = text.replaceAll(
            `Full formatted result stored at: ${ref.locator}. ${ref.retrievalHint}`,
            `Full formatted result stored at: ${object.digest}.`,
          )
        }
        output[key] = text
      } else {
        output[key] = normalize(child)
      }
    }
    return output
  }

  const { id: _id, cwd: _cwd, parentSession: _parent, ...stableHeader } = header
  void _id
  void _cwd
  void _parent
  // 与 sha256(canonicalJson({header, inheritedEventCount, events: events.map(normalize), ...}))
  // 逐字节等价：canonicalJson 对对象的输出是 '{' + 按 key 字典序 "key":value 以 ',' 连接 + '}'，
  // value 为 undefined 时输出字面量 "undefined"（JSON.stringify(undefined) 经模板插值）。
  // 事件逐条 normalize → canonicalJson 后直接喂哈希，避免 events.map 全量深拷贝与
  // 整体巨型字符串（桌面端首次同步 OOM 的直接推手之一）。
  const hash = createHash('sha256')
  hash.update('{"events":[')
  for (let index = 0; index < events.length; index += 1) {
    if (index > 0) hash.update(',')
    hash.update(canonicalJson(normalize(events[index])))
  }
  hash.update(']')
  hash.update(`,"header":${canonicalJson(stableHeader)}`)
  hash.update(`,"inheritedEventCount":${canonicalJson(inheritedEventCount)}`)
  hash.update(`,"instructionSnapshot":${instructionSnapshot ? canonicalJson({
    text: instructionSnapshot.text,
    capturedAt: instructionSnapshot.capturedAt,
    ...(instructionSnapshot.workspaceOrigin === undefined ? {} : { workspaceOrigin: instructionSnapshot.workspaceOrigin }),
    ...(instructionSnapshot.workspaceRemotePath === undefined ? {} : { workspaceRemotePath: instructionSnapshot.workspaceRemotePath }),
    ...(instructionSnapshot.workspaceRevision === undefined ? {} : { workspaceRevision: instructionSnapshot.workspaceRevision }),
    ...(instructionSnapshot.digest === undefined ? {} : { digest: instructionSnapshot.digest }),
    ...(instructionSnapshot.inheritedFromOrigin === undefined ? {} : { inheritedFromOrigin: instructionSnapshot.inheritedFromOrigin }),
  }) : 'undefined'}`)
  hash.update(`,"parentOrigin":${parentOrigin ? canonicalJson(parentOrigin) : 'undefined'}`)
  hash.update(`,"workspace":${canonicalJson({
    originInstanceId: workspace.originInstanceId,
    originWorkspaceId: workspace.originWorkspaceId,
    nodeOrigin: workspace.nodeOrigin,
    remotePath: workspace.remotePath,
  })}`)
  hash.update('}')
  return `sha256:${hash.digest('hex')}`
}

export function sessionEventListDigest(events: readonly SessionEvent[]): string {
  // 与 sha256(canonicalJson(events)) 逐字节等价：canonicalJson 对数组的输出是
  // '[' + 逐项 canonicalJson 以 ',' 连接 + ']'。逐事件喂入哈希可避免为整个
  // 事件列表构造巨型 JSON 字符串（大会话在 1.4GB 堆上直接 OOM 的推手之一）。
  const hash = createHash('sha256')
  hash.update('[')
  for (let index = 0; index < events.length; index += 1) {
    if (index > 0) hash.update(',')
    hash.update(canonicalJson(events[index]))
  }
  hash.update(']')
  return `sha256:${hash.digest('hex')}`
}

function sessionStateDigest(
  workspace: SyncSessionWorkspace,
  workspacePosition: number,
  archived: boolean,
  pinned: boolean,
): string {
  // workspacePosition 故意不参与摘要：导入时 attachSession 把会话前插到工作区
  // 首位，其余会话位置整体位移，若位置参与摘要，每次导入都会让工作区里全部
  // 会话的状态摘要/修订号跳新，双向 every-5m 调度器之间形成"拉回-推回"的无限
  // 乒乓与 session-manifest-stale 竞态（0.1.36 实测）。显示顺序是本地偏好。
  void workspacePosition
  return sha256(canonicalJson({
    workspace: {
      originInstanceId: workspace.originInstanceId,
      originWorkspaceId: workspace.originWorkspaceId,
      nodeOrigin: workspace.nodeOrigin,
      remotePath: workspace.remotePath,
      title: workspace.title,
      revision: workspace.revision,
      contentDigest: workspace.contentDigest,
    },
    archived,
    pinned,
  }))
}

function sessionExportFingerprint(input: {
  revision: unknown
  header: SessionHeader
  inheritedEventCount: number
  workspace: SyncSessionWorkspace
  instructionSnapshot?: SyncSessionInstructionSnapshot
  parentOrigin?: SyncOrigin
}): string | undefined {
  if (input.revision === undefined) return undefined
  try {
    return sha256(canonicalJson({ version: SESSION_EXPORT_CACHE_VERSION, ...input }))
  } catch {
    return undefined
  }
}

function sessionExportCacheKey(sessionId: string, branchId?: string): string {
  return JSON.stringify([sessionId, branchId ?? null])
}

export function estimateJsonBytes(value: unknown, limit: number): number | undefined {
  const active = new WeakSet<object>()
  const measure = (item: unknown): number => {
    if (item === null) return 4
    if (typeof item === 'string') {
      const bytes = Buffer.byteLength(item, 'utf8')
      return bytes > limit / 6 ? limit + 1 : bytes * 6 + 2
    }
    if (typeof item === 'number') return Number.isFinite(item) ? String(item).length : 4
    if (typeof item === 'boolean') return item ? 4 : 5
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return 4
    if (typeof item === 'bigint') return limit + 1
    if (Array.isArray(item)) {
      if (active.has(item)) return limit + 1
      active.add(item)
      let bytes = 2
      for (let index = 0; index < item.length; index += 1) {
        if (index > 0) bytes += 1
        bytes += measure(item[index])
        if (bytes > limit) break
      }
      active.delete(item)
      return bytes
    }
    if (typeof item === 'object') {
      if (active.has(item)) return limit + 1
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) return limit + 1
      active.add(item)
      let bytes = 2
      let first = true
      for (const [key, child] of Object.entries(item)) {
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue
        if (!first) bytes += 1
        first = false
        bytes += Buffer.byteLength(key, 'utf8') * 6 + 3 + measure(child)
        if (bytes > limit) break
      }
      active.delete(item)
      return bytes
    }
    return limit + 1
  }
  try {
    const bytes = measure(value)
    return bytes <= limit ? bytes : undefined
  } catch {
    return undefined
  }
}

export function planSessionTransfers(
  direction: 'pull' | 'bidirectional',
  localEntries: readonly SyncSessionEntry[],
  remoteEntries: readonly SyncSessionEntry[],
): SyncSessionTransferPlan {
  const toLocal: SyncSessionEntry[] = []
  const toRemote: SyncSessionEntry[] = []
  const keyOf = (entry: SyncSessionEntry): string => entry.branchId ?? sessionOriginKey(entry.metadata)
  const localByKey = new Map(localEntries.map((entry) => [keyOf(entry), entry]))
  const remoteByKey = new Map(remoteEntries.map((entry) => [keyOf(entry), entry]))
  if (direction === 'pull') {
    let skipped = 0
    for (const [key, remote] of remoteByKey) {
      const local = localByKey.get(key)
      if (!local) {
        toLocal.push(remote)
        continue
      }
      const comparison = compareSyncRevision(local.metadata.revision, remote.metadata.revision)
      if (comparison < 0) toLocal.push(remote)
      else if (comparison === 0) {
        if (
          local.metadata.contentDigest !== remote.metadata.contentDigest ||
          local.metadata.stateDigest !== remote.metadata.stateDigest ||
          Boolean(local.metadata.deleted) !== Boolean(remote.metadata.deleted)
        ) throw new SyncSessionError('revision-conflict', 'Equal session revisions contain different content')
        skipped += 1
      } else skipped += 1
    }
    return { toLocal, toRemote, skipped }
  }
  const keys = new Set([...localByKey.keys(), ...remoteByKey.keys()])
  let skipped = 0
  for (const key of keys) {
    const local = localByKey.get(key)
    const remote = remoteByKey.get(key)
    if (!local) { toLocal.push(remote!); continue }
    if (!remote) { toRemote.push(local); continue }
    const comparison = compareSyncRevision(local.metadata.revision, remote.metadata.revision)
    if (comparison > 0) toRemote.push(local)
    else if (comparison < 0) toLocal.push(remote)
    else if (
      local.metadata.contentDigest === remote.metadata.contentDigest &&
      local.metadata.stateDigest === remote.metadata.stateDigest &&
      Boolean(local.metadata.deleted) === Boolean(remote.metadata.deleted)
    ) skipped += 1
    else throw new SyncSessionError('revision-conflict', 'Equal session revisions contain different content')
  }
  return { toLocal, toRemote, skipped }
}

async function collectBytes(stream: AsyncIterable<Uint8Array>, maxBytes = MAX_SYNC_TRANSFER_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new SyncSessionError('object-invalid', 'session object stream contains a non-byte chunk')
    size += chunk.byteLength
    if (size > maxBytes) throw new SyncSessionError('bundle-too-large', 'session object exceeds the transfer limit')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, size)
}

/** 流式计算对象摘要：内存 O(单块)，供超过内联阈值的带外对象测长 + 摘要。 */
async function hashStream(stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ bytes: number; digest: string }> {
  const hash = createHash('sha256')
  let total = 0
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new SyncSessionError('object-invalid', 'session object stream contains a non-byte chunk')
    total += chunk.byteLength
    if (total > maxBytes) throw new SyncSessionError('bundle-too-large', 'session object exceeds the transfer limit')
    hash.update(chunk)
  }
  return { bytes: total, digest: `sha256:${hash.digest('hex')}` }
}

/**
 * 带外水合的内容流：边消费边校验字节数与摘要，全部消费完才放行
 * （摘要不符在流末尾抛出，内存 O(单块)）。
 */
async function* verifiedObjectStream(
  stream: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  expectedDigest: string,
): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256')
  let total = 0
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new SyncSessionError('object-invalid', 'session object stream contains a non-byte chunk')
    total += chunk.byteLength
    if (total > expectedBytes) throw new SyncSessionError('object-integrity', 'session object content exceeds declared bytes')
    hash.update(chunk)
    yield chunk
  }
  if (total !== expectedBytes || `sha256:${hash.digest('hex')}` !== expectedDigest) {
    throw new SyncSessionError('object-integrity', 'session object content failed digest validation')
  }
}

/** 校验带外对象帧头：{"id":"...","bytes":N,"digest":"sha256:..."} */
function parseObjectStreamHeader(line: Buffer): { id: string; bytes: number; digest: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line.toString('utf8'))
  } catch {
    throw new SyncSessionError('object-invalid', 'object stream header is not valid JSON')
  }
  if (!isRecord(parsed) || typeof parsed.id !== 'string' || !parsed.id ||
    !isNonNegativeSafeInteger(parsed.bytes) || parsed.bytes > MAX_SESSION_OBJECT_STREAM_BYTES ||
    typeof parsed.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(parsed.digest)) {
    throw new SyncSessionError('object-invalid', 'object stream header is invalid')
  }
  return { id: parsed.id, bytes: parsed.bytes, digest: parsed.digest }
}

async function* oneChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data
}

function findSessionRecordByLocalId(state: SyncState, localSessionId: string): SyncRecordMetadata | undefined {
  return Object.values(state.records)
    .filter((metadata) => metadata.kind === 'session' && metadata.localEntityId === localSessionId)
    .sort((a, b) => compareSyncRevision(b.revision, a.revision))[0]
}

interface SessionStateIndex {
  state: SyncState
  recordsByLocalId: Map<string, SyncRecordMetadata>
  workspacesByLocalId: Map<string, SyncWorkspaceMapping[]>
  archivesByLocalSessionId: Map<string, SyncSessionArchive>
}

function createSessionStateIndex(state: SyncState): SessionStateIndex {
  const index: SessionStateIndex = {
    state,
    recordsByLocalId: new Map(),
    workspacesByLocalId: new Map(),
    archivesByLocalSessionId: new Map(),
  }
  for (const metadata of Object.values(state.records)) {
    if (metadata.kind !== 'session') continue
    const current = index.recordsByLocalId.get(metadata.localEntityId)
    if (!current || compareSyncRevision(metadata.revision, current.revision) > 0) {
      index.recordsByLocalId.set(metadata.localEntityId, metadata)
    }
  }
  for (const mapping of Object.values(state.workspaces)) {
    const mappings = index.workspacesByLocalId.get(mapping.localWorkspaceId) ?? []
    mappings.push(mapping)
    index.workspacesByLocalId.set(mapping.localWorkspaceId, mappings)
  }
  for (const archive of Object.values(state.archives)) {
    if (!index.archivesByLocalSessionId.has(archive.localSessionId)) {
      index.archivesByLocalSessionId.set(archive.localSessionId, archive)
    }
  }
  return index
}

function indexSessionRecord(index: SessionStateIndex, metadata: SyncRecordMetadata): void {
  const key = sessionOriginKey(metadata)
  const previous = index.state.records[key]
  if (previous && previous.localEntityId !== metadata.localEntityId &&
    index.recordsByLocalId.get(previous.localEntityId) === previous) {
    delete index.state.records[key]
    index.recordsByLocalId.delete(previous.localEntityId)
    for (const candidate of Object.values(index.state.records)) {
      if (candidate.kind !== 'session' || candidate.localEntityId !== previous.localEntityId) continue
      const current = index.recordsByLocalId.get(previous.localEntityId)
      if (!current || compareSyncRevision(candidate.revision, current.revision) > 0) {
        index.recordsByLocalId.set(previous.localEntityId, candidate)
      }
    }
  }
  index.state.records[key] = metadata
  const current = index.recordsByLocalId.get(metadata.localEntityId)
  if (current === previous || !current || compareSyncRevision(metadata.revision, current.revision) > 0) {
    index.recordsByLocalId.set(metadata.localEntityId, metadata)
  }
}

function indexWorkspaceMapping(index: SessionStateIndex, key: string, mapping: SyncWorkspaceMapping): void {
  const previous = index.state.workspaces[key]
  if (previous) {
    const mappings = index.workspacesByLocalId.get(previous.localWorkspaceId)
    const previousIndex = mappings?.findIndex((item) =>
      syncWorkspaceKey(item.originInstanceId, item.originWorkspaceId, item.remotePath) === key,
    ) ?? -1
    if (mappings && previousIndex !== -1 && previous.localWorkspaceId === mapping.localWorkspaceId) {
      index.state.workspaces[key] = mapping
      mappings[previousIndex] = mapping
      return
    }
    if (mappings && previousIndex !== -1) mappings.splice(previousIndex, 1)
    if (mappings?.length === 0) index.workspacesByLocalId.delete(previous.localWorkspaceId)
  }
  index.state.workspaces[key] = mapping
  const mappings = index.workspacesByLocalId.get(mapping.localWorkspaceId) ?? []
  mappings.push(mapping)
  index.workspacesByLocalId.set(mapping.localWorkspaceId, mappings)
}

function indexArchive(index: SessionStateIndex, previousBranchId: string, archive: SyncSessionArchive): void {
  delete index.state.archives[previousBranchId]
  index.state.archives[archive.branchId] = archive
  index.archivesByLocalSessionId.clear()
  for (const entry of Object.values(index.state.archives)) {
    if (!index.archivesByLocalSessionId.has(entry.localSessionId)) {
      index.archivesByLocalSessionId.set(entry.localSessionId, entry)
    }
  }
}

function findSessionRecordByOrigin(state: SyncState, origin: SyncOrigin): SyncRecordMetadata | undefined {
  return state.records[syncRecordKey('session', origin)]
}

function findSessionOriginByLocalId(state: SyncState, localSessionId: string): SyncOrigin | undefined {
  const metadata = findSessionRecordByLocalId(state, localSessionId)
  return metadata ? { originInstanceId: metadata.originInstanceId, originEntityId: metadata.originEntityId } : undefined
}

function workspaceDigest(workspace: Omit<SyncSessionWorkspace, 'revision' | 'contentDigest'>): string {
  return sha256(canonicalJson(workspace))
}

function workspaceCandidateKey(workspace: WorkspaceLike): string {
  return normalizeHostPath(workspace.path)
}

export function validateObjectPayload(object: unknown): SyncSessionObject {
  if (!isRecord(object) || typeof object.id !== 'string' || !object.id || typeof object.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(object.digest) || !isNonNegativeSafeInteger(object.bytes) || typeof object.data !== 'string') {
    throw new SyncSessionError('object-invalid', 'session object metadata is invalid')
  }
  const isDeferred = object.deferred === true && object.data === ''
  const isUnavailableSpill = object.kind === 'spill' && object.unavailable === true && object.bytes === 0 && object.data === ''
  if (!isDeferred && !isUnavailableSpill) {
    const bytes = Buffer.from(object.data, 'base64')
    if (bytes.toString('base64') !== object.data || bytes.byteLength !== object.bytes || sha256(bytes) !== object.digest) {
      throw new SyncSessionError('object-invalid', 'session object encoding or digest is invalid')
    }
  }
  if (object.kind === 'image' && isImageRef(object.ref) && object.id === attachmentKey('image', object.ref)) {
    return object as unknown as SyncSessionObject
  }
  if (object.kind === 'file' && isFileRef(object.ref) && object.id === attachmentKey('file', object.ref)) {
    return object as unknown as SyncSessionObject
  }
  if (
    object.kind === 'spill' && isRecord(object.reference) && isRecord(object.reference.owner) &&
    typeof object.reference.owner.sessionId === 'string' && isRecord(object.reference.ref) &&
    typeof object.reference.ref.locator === 'string' && object.id === spillKey(object.reference as unknown as SpillTransferReference)
  ) {
    return object as unknown as SyncSessionObject
  }
  throw new SyncSessionError('object-invalid', 'session object kind or reference is invalid')
}

function validateEventDelta(value: unknown): SyncSessionEventDelta {
  if (!isRecord(value) || !isNonNegativeSafeInteger(value.baseEventCount) ||
    typeof value.baseEventDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.baseEventDigest) ||
    !isNonNegativeSafeInteger(value.baseInheritedEventCount) ||
    !isNonNegativeSafeInteger(value.fullEventCount) || value.fullEventCount < value.baseEventCount ||
    typeof value.fullEventDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.fullEventDigest)) {
    throw new SyncSessionError('manifest-invalid', 'session event delta metadata is invalid')
  }
  return {
    baseEventCount: value.baseEventCount,
    baseEventDigest: value.baseEventDigest,
    baseInheritedEventCount: value.baseInheritedEventCount,
    fullEventCount: value.fullEventCount,
    fullEventDigest: value.fullEventDigest,
  }
}

function validateEntry(entry: unknown): SyncSessionEntry {
  if (!isRecord(entry) || !isRecord(entry.metadata) || entry.metadata.kind !== 'session') {
    throw new SyncSessionError('manifest-invalid', 'session entry metadata is invalid')
  }
  const metadata = entry.metadata as unknown as SyncRecordMetadata
  if (
    typeof metadata.originInstanceId !== 'string' || !metadata.originInstanceId || metadata.originInstanceId.length > 512 || /[\u0000-\u001f\u007f]/.test(metadata.originInstanceId) ||
    typeof metadata.originEntityId !== 'string' || !metadata.originEntityId || metadata.originEntityId.length > 512 || /[\u0000-\u001f\u007f]/.test(metadata.originEntityId) ||
    typeof metadata.localEntityId !== 'string' || !metadata.localEntityId || metadata.localEntityId.length > 512 || /[\u0000-\u001f\u007f]/.test(metadata.localEntityId) ||
    typeof metadata.contentDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.contentDigest) || !metadata.revision ||
    !isNonNegativeSafeInteger(metadata.revision.physicalTimeMs) ||
    !isNonNegativeSafeInteger(metadata.revision.logicalCounter) || typeof metadata.revision.writerInstanceId !== 'string' ||
    !metadata.revision.writerInstanceId || /[\u0000-\u001f\u007f]/.test(metadata.revision.writerInstanceId)
  ) throw new SyncSessionError('manifest-invalid', 'session entry metadata fields are invalid')
  if (metadata.stateDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(metadata.stateDigest)) {
    throw new SyncSessionError('manifest-invalid', 'session state digest is invalid')
  }
  if (metadata.deleted !== undefined && typeof metadata.deleted !== 'boolean') {
    throw new SyncSessionError('manifest-invalid', 'session tombstone flag is invalid')
  }
  if (entry.branchId !== undefined && (typeof entry.branchId !== 'string' || !/^b-[a-f0-9]{32}$/.test(entry.branchId))) {
    throw new SyncSessionError('manifest-invalid', 'session branch ID is invalid')
  }
  if (metadata.workspaceOrigin !== undefined) validateOrigin(metadata.workspaceOrigin)
  const eventDelta = entry.eventDelta === undefined ? undefined : validateEventDelta(entry.eventDelta)
  if (metadata.deleted) {
    if (eventDelta) throw new SyncSessionError('manifest-invalid', 'session tombstones cannot carry event deltas')
    if (metadata.contentDigest !== sessionTombstoneDigest(metadata)) throw new SyncSessionError('manifest-invalid', 'session tombstone digest is invalid')
    return { metadata, ...(entry.branchId ? { branchId: entry.branchId as string } : {}) }
  }
  const workspace = isRecord(entry.workspace) ? entry.workspace : undefined
  const workspaceRevision = workspace && isRecord(workspace.revision) ? workspace.revision : undefined
  if (
    typeof entry.sourceLocalSessionId !== 'string' || !isRecord(entry.header) ||
    typeof entry.inheritedEventCount !== 'number' || !Number.isSafeInteger(entry.inheritedEventCount) || entry.inheritedEventCount < 0 ||
    !Array.isArray(entry.events) || !workspace || !Array.isArray(entry.objects) ||
    typeof workspace.originInstanceId !== 'string' || typeof workspace.originWorkspaceId !== 'string' ||
    !isRecord(workspace.nodeOrigin) || typeof workspace.nodeOrigin.originInstanceId !== 'string' ||
    typeof workspace.nodeOrigin.originEntityId !== 'string' || typeof workspace.remotePath !== 'string' ||
    !posix.isAbsolute(workspace.remotePath) || posix.normalize(workspace.remotePath) !== workspace.remotePath ||
    typeof workspace.title !== 'string' || typeof workspace.contentDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(workspace.contentDigest) ||
    !workspaceRevision || !isNonNegativeSafeInteger(workspaceRevision.physicalTimeMs) ||
    !isNonNegativeSafeInteger(workspaceRevision.logicalCounter) ||
    typeof workspaceRevision.writerInstanceId !== 'string' ||
    typeof entry.workspacePosition !== 'number' || !Number.isSafeInteger(entry.workspacePosition) || entry.workspacePosition < 0 ||
    typeof entry.archived !== 'boolean' || typeof entry.pinned !== 'boolean'
  ) throw new SyncSessionError('manifest-invalid', 'active session entry fields are invalid')
  if (eventDelta && (entry.branchId !== undefined || entry.archived)) {
    throw new SyncSessionError('manifest-invalid', 'archives cannot use event tail deltas')
  }
  if (entry.events.length > MAX_SYNC_SESSIONS * 100) throw new SyncSessionError('manifest-invalid', 'session event count exceeds limit')
  const header = entry.header as unknown as SessionHeader
  if (header.version !== SESSION_FORMAT_VERSION || header.id !== entry.sourceLocalSessionId) {
    throw new SyncSessionError('session-format', 'session header format or id is invalid')
  }
  let events: SessionEvent[]
  if (eventDelta) {
    if (eventDelta.baseInheritedEventCount !== entry.inheritedEventCount ||
      eventDelta.fullEventCount > MAX_SYNC_SESSIONS * 100 ||
      eventDelta.fullEventCount - eventDelta.baseEventCount !== entry.events.length) {
      throw new SyncSessionError('manifest-invalid', 'session event delta counts are inconsistent')
    }
    events = structuredClone(entry.events) as SessionEvent[]
    for (let index = 0; index < events.length; index += 1) {
      if (!isNonNegativeSafeInteger(events[index]?.seq) || events[index]?.seq !== eventDelta.baseEventCount + index) {
        throw new SyncSessionError('manifest-invalid', 'session event delta sequence is invalid')
      }
    }
  } else {
    events = validateStoredEvents(header, structuredClone(entry.events) as SessionEvent[])
    assertContiguous(header.id, events, 0)
  }
  const objects = entry.objects.map(validateObjectPayload)
  if (new Set(objects.map((object) => object.id)).size !== objects.length) {
    throw new SyncSessionError('manifest-invalid', 'session entry contains duplicate objects')
  }
  const workspaceValue = workspace as unknown as SyncSessionWorkspace
  const workspaceBase = {
    originInstanceId: workspaceValue.originInstanceId,
    originWorkspaceId: workspaceValue.originWorkspaceId,
    nodeOrigin: workspaceValue.nodeOrigin,
    remotePath: workspaceValue.remotePath,
    title: workspaceValue.title,
  }
  if (workspaceDigest(workspaceBase) !== workspaceValue.contentDigest) {
    throw new SyncSessionError('manifest-invalid', 'workspace content digest is invalid')
  }
  const instructionSnapshot = entry.instructionSnapshot === undefined
    ? undefined
    : validateInstructionSnapshot(entry.instructionSnapshot)
  const referencedObjects = new Set<string>()
  const attachments = attachmentReferences(events)
  for (const ref of attachments.images) referencedObjects.add(attachmentKey('image', ref))
  for (const ref of attachments.files) referencedObjects.add(attachmentKey('file', ref))
  for (const reference of [...spillReferences(events), ...legacySpillReferences(events, String(header.id))]) {
    referencedObjects.add(spillKey(reference))
  }
  const objectIds = new Set(objects.map((object) => object.id))
  if ([...referencedObjects].some((id) => !objectIds.has(id)) ||
    (!eventDelta && [...objectIds].some((id) => !referencedObjects.has(id)))) {
    throw new SyncSessionError('manifest-invalid', 'session object references and payloads do not match')
  }
  const parentOrigin = entry.parentOrigin === undefined ? undefined : validateOrigin(entry.parentOrigin)
  if (!eventDelta) {
    const contentDigest = sessionEventDigest(
      header,
      entry.inheritedEventCount as number,
      events,
      workspaceValue,
      instructionSnapshot,
      objects,
      parentOrigin,
    )
    if (contentDigest !== metadata.contentDigest) throw new SyncSessionError('manifest-invalid', 'session content digest is invalid')
  }
  if (metadata.stateDigest !== sessionStateDigest(workspaceValue, entry.workspacePosition as number, entry.archived as boolean, entry.pinned as boolean)) {
    throw new SyncSessionError('manifest-invalid', 'session state digest is invalid')
  }
  return {
    metadata,
    ...(entry.branchId ? { branchId: entry.branchId as string } : {}),
    sourceLocalSessionId: entry.sourceLocalSessionId,
    header,
    inheritedEventCount: entry.inheritedEventCount,
    ...(parentOrigin ? { parentOrigin } : {}),
    workspace: workspaceValue,
    workspacePosition: entry.workspacePosition,
    archived: entry.archived,
    pinned: entry.pinned,
    ...(instructionSnapshot ? { instructionSnapshot } : {}),
    events,
    objects,
    ...(eventDelta ? { eventDelta } : {}),
  }
}

function validateManifestEntry(entry: unknown): SyncSessionManifestEntry {
  if (!isRecord(entry) || !isRecord(entry.metadata) || entry.metadata.kind !== 'session') {
    throw new SyncSessionError('manifest-invalid', 'session manifest entry metadata is invalid')
  }
  const metadata = entry.metadata as unknown as SyncRecordMetadata
  if (
    typeof metadata.originInstanceId !== 'string' || !metadata.originInstanceId || metadata.originInstanceId.length > 512 || /[\u0000-\u001f\u007f]/.test(metadata.originInstanceId) ||
    typeof metadata.originEntityId !== 'string' || !metadata.originEntityId || metadata.originEntityId.length > 512 || /[\u0000-\u001f\u007f]/.test(metadata.originEntityId) ||
    typeof metadata.localEntityId !== 'string' || !metadata.localEntityId || metadata.localEntityId.length > 512 || /[\u0000-\u001f\u007f]/.test(metadata.localEntityId) ||
    typeof metadata.contentDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(metadata.contentDigest) || !metadata.revision ||
    !isNonNegativeSafeInteger(metadata.revision.physicalTimeMs) ||
    !isNonNegativeSafeInteger(metadata.revision.logicalCounter) || typeof metadata.revision.writerInstanceId !== 'string' ||
    !metadata.revision.writerInstanceId || /[\u0000-\u001f\u007f]/.test(metadata.revision.writerInstanceId)
  ) throw new SyncSessionError('manifest-invalid', 'session manifest metadata fields are invalid')
  if (metadata.stateDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(metadata.stateDigest)) {
    throw new SyncSessionError('manifest-invalid', 'session manifest state digest is invalid')
  }
  if (metadata.deleted !== undefined && typeof metadata.deleted !== 'boolean') {
    throw new SyncSessionError('manifest-invalid', 'session manifest tombstone flag is invalid')
  }
  const hasEventCount = entry.eventCount !== undefined
  const hasEventDigest = entry.eventDigest !== undefined
  const hasInheritedEventCount = entry.inheritedEventCount !== undefined
  if (hasEventCount || hasEventDigest || hasInheritedEventCount) {
    if (!hasEventCount || !hasEventDigest || !hasInheritedEventCount || metadata.deleted ||
      !isNonNegativeSafeInteger(entry.eventCount) || entry.eventCount > MAX_SYNC_SESSIONS * 100 ||
      typeof entry.eventDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(entry.eventDigest) ||
      !isNonNegativeSafeInteger(entry.inheritedEventCount) || entry.inheritedEventCount > entry.eventCount) {
      throw new SyncSessionError('manifest-invalid', 'session event summary is invalid')
    }
  }
  if (entry.branchId !== undefined && (typeof entry.branchId !== 'string' || !/^b-[a-f0-9]{32}$/.test(entry.branchId))) {
    throw new SyncSessionError('manifest-invalid', 'session manifest branch ID is invalid')
  }
  if (metadata.workspaceOrigin !== undefined) validateOrigin(metadata.workspaceOrigin)
  if (metadata.deleted && metadata.contentDigest !== sessionTombstoneDigest(metadata)) {
    throw new SyncSessionError('manifest-invalid', 'session manifest tombstone digest is invalid')
  }
  return {
    metadata,
    ...(entry.branchId ? { branchId: entry.branchId as string } : {}),
    ...(hasEventCount ? { eventCount: entry.eventCount as number } : {}),
    ...(hasEventDigest ? { eventDigest: entry.eventDigest as string } : {}),
    ...(hasInheritedEventCount ? { inheritedEventCount: entry.inheritedEventCount as number } : {}),
  }
}

function bundleDigest(bundle: Pick<SyncSessionBundle, 'instanceId' | 'entries' | 'skipped' | 'objects'>): string {
  const sharedObjects = new Map((bundle.objects ?? []).map((object) => [object.id, object]))
  const manifest = bundle.entries.map((entry) => ({
    key: entry.branchId ?? sessionOriginKey(entry.metadata),
    revision: entry.metadata.revision,
    contentDigest: entry.metadata.contentDigest,
    stateDigest: entry.metadata.stateDigest,
    deleted: Boolean(entry.metadata.deleted),
    objects: (entry.objects ?? (entry.sharedObjectIds ?? []).map((id) => {
      const object = sharedObjects.get(id)
      if (!object) throw new SyncSessionError('manifest-invalid', 'session shared object id is unknown')
      return object
    })).map((object) => ({ id: object.id, digest: object.digest, bytes: object.bytes }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    eventDelta: entry.eventDelta === undefined ? undefined : {
      ...entry.eventDelta,
      suffixDigest: sessionEventListDigest(entry.events ?? []),
    },
  })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const skipped = bundle.skipped.map((entry) => ({ sessionId: entry.sessionId, reason: entry.reason }))
    .sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
  return sha256(canonicalJson({ instanceId: bundle.instanceId, entries: manifest, skipped }))
}

function materializeSharedObjects(bundle: {
  objects?: SyncSessionObject[]
  entries: Array<Pick<SyncSessionEntry, 'sharedObjectIds'>>
}): Map<string, SyncSessionObject> {
  const shared = bundle.objects === undefined ? new Map<string, SyncSessionObject>() : new Map(
    bundle.objects.map((object) => {
      const validated = validateObjectPayload(object)
      return [validated.id, validated] as const
    }),
  )
  if (shared.size !== (bundle.objects?.length ?? 0)) {
    throw new SyncSessionError('manifest-invalid', 'session bundle contains duplicate shared objects')
  }
  for (const entry of bundle.entries) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.sharedObjectIds !== undefined && (!Array.isArray(entry.sharedObjectIds) ||
      new Set(entry.sharedObjectIds).size !== entry.sharedObjectIds.length ||
      entry.sharedObjectIds.some((id) => !shared.has(id)))) {
      throw new SyncSessionError('manifest-invalid', 'session entry shared object references are invalid')
    }
  }
  return shared
}

export function validateSyncSessionBundle(value: unknown): SyncSessionBundle {
  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.instanceId !== 'string' ||
    !/^i-[a-f0-9]{32}$/.test(value.instanceId) || !Array.isArray(value.entries) || typeof value.digest !== 'string') {
    throw new SyncSessionError('manifest-invalid', 'session bundle header is invalid')
  }
  if (value.objects !== undefined && (!Array.isArray(value.objects) || value.objects.some((object) => !isRecord(object)))) {
    throw new SyncSessionError('manifest-invalid', 'session bundle shared object table is invalid')
  }
  const sharedObjects = materializeSharedObjects({
    ...(value.objects === undefined ? {} : { objects: value.objects as SyncSessionObject[] }),
    entries: value.entries as Array<Pick<SyncSessionEntry, 'sharedObjectIds'>>,
  })
  const skipped = value.skipped === undefined ? [] : value.skipped
  if (!Array.isArray(skipped) || skipped.some((item) =>
    !isRecord(item) || typeof item.sessionId !== 'string' || typeof item.reason !== 'string'
  )) throw new SyncSessionError('manifest-invalid', 'session bundle skip report is invalid')
  if (value.entries.length > MAX_SYNC_SESSIONS) throw new SyncSessionError('manifest-invalid', 'session bundle contains too many records')
  const entries = value.entries.map((entry) => {
    const materialized: SyncSessionEntry = { ...entry } as SyncSessionEntry
    if (materialized.sharedObjectIds !== undefined) {
      if (materialized.objects !== undefined) {
        throw new SyncSessionError('manifest-invalid', 'session entry cannot carry inline and shared objects')
      }
      materialized.objects = materialized.sharedObjectIds.map((id) => sharedObjects.get(id)!)
    }
    return validateEntry(materialized)
  })
  const keys = entries.map((entry) => entry.branchId ?? sessionOriginKey(entry.metadata))
  if (new Set(keys).size !== keys.length) throw new SyncSessionError('manifest-invalid', 'session bundle contains duplicate records')
  const bundle: SyncSessionBundle = {
    protocolVersion: 1,
    instanceId: value.instanceId,
    entries,
    skipped: skipped as Array<{ sessionId: string; reason: string }>,
    ...(value.objects === undefined ? {} : { objects: value.objects as SyncSessionObject[] }),
    digest: value.digest,
  }
  if (bundleDigest(bundle) !== bundle.digest) throw new SyncSessionError('manifest-digest', 'session bundle digest does not match')
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_SYNC_TRANSFER_BYTES) {
    throw new SyncSessionError('bundle-too-large', 'session bundle exceeds the transfer limit')
  }
  return bundle
}

export function makeSyncSessionBundle(
  instanceId: string,
  entries: SyncSessionEntry[],
  skipped: Array<{ sessionId: string; reason: string }> = [],
  sharedObjects?: SyncSessionObject[],
): SyncSessionBundle {
  if (sharedObjects !== undefined) {
    const referencesShared = entries.some((entry) => (entry.objects?.length ?? 0) > 0 || entry.sharedObjectIds !== undefined)
    const inlineEntries = referencesShared
      ? entries.map((entry) => {
          if (entry.objects === undefined) return entry
          const { objects, ...rest } = entry
          void objects
          return { ...rest, sharedObjectIds: objects.map((object) => object.id) }
        })
      : entries
    const bundle: SyncSessionBundle = {
      protocolVersion: 1,
      instanceId,
      entries: inlineEntries,
      skipped,
      ...(referencesShared ? { objects: sharedObjects } : {}),
      digest: '',
    }
    bundle.digest = bundleDigest(bundle)
    if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_SYNC_TRANSFER_BYTES) {
      throw new SyncSessionError('bundle-too-large', 'session bundle exceeds the transfer limit')
    }
    return bundle
  }
  const bundle: SyncSessionBundle = { protocolVersion: 1, instanceId, entries, skipped, digest: '' }
  bundle.digest = bundleDigest(bundle)
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_SYNC_TRANSFER_BYTES) {
    throw new SyncSessionError('bundle-too-large', 'session bundle exceeds the transfer limit')
  }
  return bundle
}

export function syncSessionEntryKey(entry: Pick<SyncSessionManifestEntry, 'metadata' | 'branchId'>): string {
  return entry.branchId ?? sessionOriginKey(entry.metadata)
}

function withEventTail(entry: SyncSessionEntry, prefix?: SyncSessionEventPrefix): SyncSessionEntry {
  if (!prefix || entry.metadata.deleted || entry.branchId || !entry.events || entry.events.length === 0 ||
    prefix.eventCount === 0 || prefix.eventCount > entry.events.length ||
    prefix.inheritedEventCount !== entry.inheritedEventCount) return entry
  const baseEvents = entry.events.slice(0, prefix.eventCount)
  if (sessionEventListDigest(baseEvents) !== prefix.eventDigest) return entry
  const fullEventDigest = entry.eventDigest !== undefined && entry.eventCount === entry.events.length
    ? entry.eventDigest
    : sessionEventListDigest(entry.events)
  return {
    ...entry,
    eventDelta: {
      baseEventCount: prefix.eventCount,
      baseEventDigest: prefix.eventDigest,
      baseInheritedEventCount: prefix.inheritedEventCount,
      fullEventCount: entry.events.length,
      fullEventDigest,
    },
    events: entry.events.slice(prefix.eventCount),
  }
}

function sessionManifestDigest(manifest: Pick<SyncSessionManifest, 'instanceId' | 'entries' | 'skipped'>): string {
  const entries = manifest.entries.map((entry) => ({
    key: syncSessionEntryKey(entry),
    metadata: entry.metadata,
    eventCount: entry.eventCount,
    eventDigest: entry.eventDigest,
    inheritedEventCount: entry.inheritedEventCount,
  }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const skipped = manifest.skipped.map((entry) => ({ sessionId: entry.sessionId, reason: entry.reason }))
    .sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
  return sha256(canonicalJson({ instanceId: manifest.instanceId, entries, skipped }))
}

export function makeSyncSessionManifest(
  instanceId: string,
  entries: readonly SyncSessionManifestEntry[],
  skipped: Array<{ sessionId: string; reason: string }> = [],
): SyncSessionManifest {
  const manifest: SyncSessionManifest = {
    protocolVersion: 1,
    instanceId,
    entries: entries.map((entry) => ({
      metadata: entry.metadata,
      ...(entry.branchId ? { branchId: entry.branchId } : {}),
      ...(entry.eventCount === undefined ? {} : { eventCount: entry.eventCount }),
      ...(entry.eventDigest === undefined ? {} : { eventDigest: entry.eventDigest }),
      ...(entry.inheritedEventCount === undefined ? {} : { inheritedEventCount: entry.inheritedEventCount }),
    })),
    skipped,
    digest: '',
  }
  manifest.digest = sessionManifestDigest(manifest)
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_SYNC_TRANSFER_BYTES) {
    throw new SyncSessionError('bundle-too-large', 'session manifest exceeds the transfer limit')
  }
  return manifest
}

export function validateSyncSessionManifest(value: unknown): SyncSessionManifest {
  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.instanceId !== 'string' ||
    !/^i-[a-f0-9]{32}$/.test(value.instanceId) || !Array.isArray(value.entries) || typeof value.digest !== 'string') {
    throw new SyncSessionError('manifest-invalid', 'session manifest header is invalid')
  }
  const skipped = value.skipped === undefined ? [] : value.skipped
  if (!Array.isArray(skipped) || skipped.some((item) =>
    !isRecord(item) || typeof item.sessionId !== 'string' || typeof item.reason !== 'string'
  )) throw new SyncSessionError('manifest-invalid', 'session manifest skip report is invalid')
  if (value.entries.length > MAX_SYNC_SESSIONS) throw new SyncSessionError('manifest-invalid', 'session manifest contains too many records')
  const entries = value.entries.map(validateManifestEntry)
  const keys = entries.map(syncSessionEntryKey)
  if (new Set(keys).size !== keys.length) throw new SyncSessionError('manifest-invalid', 'session manifest contains duplicate records')
  const manifest: SyncSessionManifest = {
    protocolVersion: 1,
    instanceId: value.instanceId,
    entries,
    skipped: skipped as Array<{ sessionId: string; reason: string }>,
    digest: value.digest,
  }
  if (sessionManifestDigest(manifest) !== manifest.digest) {
    throw new SyncSessionError('manifest-digest', 'session manifest digest does not match')
  }
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_SYNC_TRANSFER_BYTES) {
    throw new SyncSessionError('bundle-too-large', 'session manifest exceeds the transfer limit')
  }
  return manifest
}

function emptyApplyResult(): SyncSessionApplyResult {
  return { created: 0, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }
}

function isNodeRemoteType(type: NodeType): boolean {
  return type === 'remote-ssh' || type === 'remote-docker'
}

function branchIdFor(metadata: SyncRecordMetadata): string {
  return `b-${createHash('sha256').update(canonicalJson({
    originInstanceId: metadata.originInstanceId,
    originEntityId: metadata.originEntityId,
    contentDigest: metadata.contentDigest,
  })).digest('hex').slice(0, 32)}`
}

function sessionTombstoneDigest(metadata: Pick<SyncRecordMetadata, 'originInstanceId' | 'originEntityId'>): string {
  return sha256(canonicalJson({
    kind: 'session',
    originInstanceId: metadata.originInstanceId,
    originEntityId: metadata.originEntityId,
    deleted: true,
  }))
}

function validateOrigin(value: unknown): SyncOrigin {
  if (!isRecord(value) || typeof value.originInstanceId !== 'string' || !value.originInstanceId ||
    typeof value.originEntityId !== 'string' || !value.originEntityId ||
    value.originInstanceId.length > 512 || value.originEntityId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value.originInstanceId) || /[\u0000-\u001f\u007f]/.test(value.originEntityId)) {
    throw new SyncSessionError('manifest-invalid', 'session origin reference is invalid')
  }
  return { originInstanceId: value.originInstanceId, originEntityId: value.originEntityId }
}

function validateInstructionSnapshot(value: unknown): SyncSessionInstructionSnapshot {
  if (!isRecord(value) || typeof value.text !== 'string' ||
    Buffer.byteLength(value.text, 'utf8') > INSTRUCTION_MAX_BYTES ||
    typeof value.capturedAt !== 'string' || value.capturedAt.length > 64) {
    throw new SyncSessionError('manifest-invalid', 'session instruction snapshot is invalid')
  }
  if (value.workspaceRevision !== undefined && !isNonNegativeSafeInteger(value.workspaceRevision)) {
    throw new SyncSessionError('manifest-invalid', 'instruction workspace revision is invalid')
  }
  if (value.digest !== undefined && (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest))) {
    throw new SyncSessionError('manifest-invalid', 'instruction digest is invalid')
  }
  if (value.workspaceRemotePath !== undefined && (
    typeof value.workspaceRemotePath !== 'string' || !posix.isAbsolute(value.workspaceRemotePath) ||
    posix.normalize(value.workspaceRemotePath) !== value.workspaceRemotePath
  )) throw new SyncSessionError('manifest-invalid', 'instruction workspace path is invalid')
  return {
    text: value.text,
    capturedAt: value.capturedAt,
    ...(value.workspaceOrigin === undefined ? {} : { workspaceOrigin: validateOrigin(value.workspaceOrigin) }),
    ...(value.workspaceRemotePath === undefined ? {} : { workspaceRemotePath: value.workspaceRemotePath as string }),
    ...(value.workspaceRevision === undefined ? {} : { workspaceRevision: value.workspaceRevision as number }),
    ...(value.digest === undefined ? {} : { digest: value.digest as string }),
    ...(value.inheritedFromOrigin === undefined ? {} : { inheritedFromOrigin: validateOrigin(value.inheritedFromOrigin) }),
  }
}

function importedSessionId(metadata: SyncRecordMetadata): SessionId {
  const identity = canonicalJson({
    originInstanceId: metadata.originInstanceId,
    originEntityId: metadata.originEntityId,
    contentDigest: metadata.contentDigest,
  })
  return makeSessionId(`session-sync-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`)
}

function archivedSessionId(branchId: string): SessionId {
  return makeSessionId(`session-archive-${createHash('sha256').update(branchId).digest('hex').slice(0, 32)}`)
}

function tombstoneDigest(metadata: Pick<SyncRecordMetadata, 'originInstanceId' | 'originEntityId'>): string {
  return sha256(canonicalJson({ kind: 'session', originInstanceId: metadata.originInstanceId, originEntityId: metadata.originEntityId, deleted: true }))
}

function arrayBuffer(data: string): Buffer {
  const value = Buffer.from(data, 'base64')
  if (value.toString('base64') !== data) throw new SyncSessionError('object-invalid', 'session object is not canonical base64')
  return value
}

function instructionsForSession(
  store: SessionInstructionSnapshotStore,
  sessionId: string,
  stateIndex: SessionStateIndex,
  preferredWorkspaceOrigin?: SyncOrigin,
): SyncSessionInstructionSnapshot | undefined {
  const snapshot = store.get(sessionId)
  if (!snapshot) return undefined
  const workspaceMappings = snapshot.workspaceId
    ? stateIndex.workspacesByLocalId.get(snapshot.workspaceId) ?? []
    : []
  const workspaceMapping = preferredWorkspaceOrigin
    ? workspaceMappings.find((mapping) => mapping.originInstanceId === preferredWorkspaceOrigin.originInstanceId &&
      mapping.originWorkspaceId === preferredWorkspaceOrigin.originEntityId) ??
      (workspaceMappings.length === 1 ? workspaceMappings[0] : undefined)
    : workspaceMappings.length === 1 ? workspaceMappings[0] : undefined
  const inheritedFrom = snapshot.inheritedFromSessionId
    ? stateIndex.recordsByLocalId.get(snapshot.inheritedFromSessionId)
    : undefined
  const inheritedFromOrigin = inheritedFrom
    ? { originInstanceId: inheritedFrom.originInstanceId, originEntityId: inheritedFrom.originEntityId }
    : undefined
  return {
    text: snapshot.text,
    capturedAt: snapshot.capturedAt,
    ...(workspaceMapping ? {
      workspaceOrigin: { originInstanceId: workspaceMapping.originInstanceId, originEntityId: workspaceMapping.originWorkspaceId },
      workspaceRemotePath: workspaceMapping.remotePath,
    } : {}),
    ...(snapshot.workspaceRevision === undefined ? {} : { workspaceRevision: snapshot.workspaceRevision }),
    ...(snapshot.digest === undefined ? {} : { digest: snapshot.digest }),
    ...(inheritedFromOrigin ? { inheritedFromOrigin } : {}),
  }
}

export class SyncSessionService {
  private operationTail: Promise<void> = Promise.resolve()
  private readonly exportCache = new Map<string, SessionExportCacheEntry>()
  private readonly exportCacheStore: SyncSessionExportCacheStore
  private readonly manifestPayloadCache = new Map<string, SessionManifestPayloadCache>()
  private manifestPayloadCacheBytes = 0
  /** 带外对象收件箱：对象流 RPC 的落盘暂存区，apply 水合后删除。 */
  readonly objectInbox: SyncSessionObjectInbox
  /** 工作区级指令存储：导入采纳写入，驱动该工作区新会话的指令注入。 */
  readonly workspaceInstructions: WorkspaceInstructionStore

  constructor(
    private readonly state: SyncStateStore,
    private readonly nodes: SyncNodeService,
    private readonly registry: NodeRegistry,
    private readonly bindings: WorkspaceBindingsStore,
    private readonly getWorkspaces: () => WorkspaceRegistryLike | undefined,
    private readonly getPersistence: () => SessionPersistenceLike | undefined,
    private readonly getAttachments: () => AttachmentStoreLike | undefined,
    private readonly getSpills: () => SpillStoreLike | undefined,
    private readonly instructions: SessionInstructionSnapshotStore,
    private readonly journal = new SyncSessionJournalStore(),
    private readonly now: () => number = Date.now,
    home?: string,
    workspaceInstructions?: WorkspaceInstructionStore,
  ) {
    this.exportCacheStore = new SyncSessionExportCacheStore(home)
    this.objectInbox = new SyncSessionObjectInbox(home)
    this.workspaceInstructions = workspaceInstructions ?? sharedWorkspaceInstructionStore()
    for (const [key, entry] of this.exportCacheStore.entries()) {
      if (!this.exportCache.has(key)) {
        this.exportCache.set(key, entry)
      }
    }
  }

  exportBundle(): Promise<SyncSessionBundle> {
    return this.serializeMutation(() => this.exportBundleNow())
  }

  exportManifest(): Promise<SyncSessionManifest> {
    return this.serializeMutation(async () => {
      const payloadCache: SessionManifestPayloadCache = {
        instanceId: this.state.instanceId(),
        entries: new Map(),
        bytes: 0,
      }
      const bundle = await this.exportBundleNow({ manifestOnly: true, payloadCache })
      const manifest = makeSyncSessionManifest(bundle.instanceId, bundle.entries, bundle.skipped)
      this.rememberManifestPayloads(manifest.digest, payloadCache)
      return manifest
    })
  }

  exportEntries(
    keys: readonly string[],
    manifestDigest?: string,
    prefixes: readonly SyncSessionEventPrefix[] = [],
    options: { sharedObjects?: boolean; deferredObjects?: boolean } = {},
  ): Promise<SyncSessionBundle> {
    return this.serializeMutation(async () => {
      if (keys.length > MAX_SYNC_SESSIONS || keys.some((key) => typeof key !== 'string' || key.length > 2048) ||
        new Set(keys).size !== keys.length) {
        throw new SyncSessionError('manifest-invalid', 'session entry selection is invalid')
      }
      if (manifestDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(manifestDigest)) {
        throw new SyncSessionError('manifest-invalid', 'session manifest digest is invalid')
      }
      const selectedKeys = new Set(keys)
      const prefixesByKey = new Map<string, SyncSessionEventPrefix>()
      for (const prefix of prefixes) {
        if (!selectedKeys.has(prefix.key) || prefixesByKey.has(prefix.key) ||
          !isNonNegativeSafeInteger(prefix.eventCount) || prefix.eventCount > MAX_SYNC_SESSIONS * 100 ||
          !/^sha256:[a-f0-9]{64}$/.test(prefix.eventDigest) ||
          !isNonNegativeSafeInteger(prefix.inheritedEventCount) || prefix.inheritedEventCount > prefix.eventCount) {
          throw new SyncSessionError('manifest-invalid', 'session event prefix is invalid')
        }
        prefixesByKey.set(prefix.key, prefix)
      }
      let bundle: SyncSessionBundle
      const payloadCache = manifestDigest ? this.manifestPayloadCache.get(manifestDigest) : undefined
      if (payloadCache) {
        const cachedEntries = keys.flatMap((key) => {
          const entry = payloadCache.entries.get(key)
          return entry ? [entry] : []
        })
        const cachedKeys = new Set(cachedEntries.map(syncSessionEntryKey))
        const missingKeys = keys.filter((key) => !cachedKeys.has(key))
        const additional = missingKeys.length > 0
          ? await this.exportBundleNow({ selectedKeys: new Set(missingKeys) })
          : makeSyncSessionBundle(payloadCache.instanceId, [])
        bundle = makeSyncSessionBundle(payloadCache.instanceId, [...cachedEntries, ...additional.entries], additional.skipped)
      } else {
        bundle = await this.exportBundleNow({ selectedKeys, sharedObjects: options.sharedObjects === true, deferredObjects: options.deferredObjects === true })
      }
      const withTails = bundle.entries.map((entry) => withEventTail(entry, prefixesByKey.get(syncSessionEntryKey(entry))))
      if (bundle.objects !== undefined) {
        return makeSyncSessionBundle(bundle.instanceId, withTails, bundle.skipped, bundle.objects)
      }
      const inlineEntries = withTails.map((entry) => {
        if (entry.sharedObjectIds === undefined) return entry
        const { sharedObjectIds, ...rest } = entry
        void sharedObjectIds
        return rest
      })
      const sharedObjects = options.sharedObjects === true ? this.dedupeBundleObjects(inlineEntries) : undefined
      return makeSyncSessionBundle(bundle.instanceId, inlineEntries, bundle.skipped, sharedObjects)
    })
  }

  private rememberManifestPayloads(digest: string, payloads: SessionManifestPayloadCache): void {
    if (payloads.entries.size === 0 || payloads.bytes > MAX_MANIFEST_PAYLOAD_CACHE_BYTES) return
    const previous = this.manifestPayloadCache.get(digest)
    if (previous) {
      this.manifestPayloadCacheBytes -= previous.bytes
      this.manifestPayloadCache.delete(digest)
    }
    while (this.manifestPayloadCache.size >= MAX_MANIFEST_PAYLOAD_CACHE_COUNT ||
      this.manifestPayloadCacheBytes + payloads.bytes > MAX_MANIFEST_PAYLOAD_CACHE_BYTES) {
      const oldest = this.manifestPayloadCache.entries().next().value as [string, SessionManifestPayloadCache] | undefined
      if (!oldest) return
      this.manifestPayloadCache.delete(oldest[0])
      this.manifestPayloadCacheBytes -= oldest[1].bytes
    }
    this.manifestPayloadCache.set(digest, payloads)
    this.manifestPayloadCacheBytes += payloads.bytes
  }

  applyBundle(
    value: unknown,
    sourceName: string,
    peerId = 'p-000000000000000000000000',
    options: SyncSessionApplyOptions = {},
  ): Promise<SyncSessionApplyResult> {
    return this.serializeMutation(() => this.applyBundleNow(value, sourceName, peerId, options))
  }

  preflightBundle(value: unknown, options: SyncSessionApplyOptions = {}): void {
    const bundle = validateSyncSessionBundle(value)
    if (bundle.instanceId === this.state.instanceId() && !options.allowSameInstance) {
      throw new SyncSessionError('same-instance', 'cannot import sessions from this instance')
    }
    const state = this.state.read()
    for (const entry of bundle.entries) {
      if (entry.metadata.deleted) {
        const current = state.records[sessionOriginKey(entry.metadata)]
        if (!current) continue
        const comparison = compareSyncRevision(entry.metadata.revision, current.revision)
        if (comparison === 0 && (entry.metadata.contentDigest !== current.contentDigest || !current.deleted)) {
          throw new SyncSessionError('revision-conflict', 'Equal session revisions contain different tombstone state')
        }
        continue
      }
      if (entry.branchId) {
        const current = state.archives[entry.branchId]
        if (!current) continue
        const comparison = compareSyncRevision(entry.metadata.revision, current.revision)
        if (comparison === 0 && (entry.metadata.contentDigest !== current.contentDigest || entry.metadata.stateDigest !== current.stateDigest)) {
          throw new SyncSessionError('revision-conflict', 'Equal archive revisions contain different content')
        }
        if (comparison > 0 && entry.metadata.contentDigest !== current.contentDigest) {
          throw new SyncSessionError('archive-conflict', 'A session archive ID was reused for different content')
        }
        continue
      }
      const current = state.records[sessionOriginKey(entry.metadata)]
      if (!current || current.deleted) continue
      const comparison = compareSyncRevision(entry.metadata.revision, current.revision)
      if (comparison === 0 && (entry.metadata.contentDigest !== current.contentDigest || entry.metadata.stateDigest !== current.stateDigest)) {
        throw new SyncSessionError('revision-conflict', 'Equal session revisions contain different content')
      }
    }
  }

  pendingPeerIds(): string[] {
    return this.journal.pendingPeerIds()
  }

  /**
   * 丢弃指定对端的全部未完成 journal 批次（含正在应用中的当前批）。
   * 手动停止同步时调用：未应用的条目不再落地，重启后也不会回放；
   * 已应用完成的条目不受影响。
   */
  discardPendingBatches(peerId: string): number {
    let discarded = 0
    for (const batch of this.journal.pendingBatches()) {
      if (batch.peerId !== peerId) continue
      this.journal.discard(batch.batchId)
      discarded += 1
    }
    return discarded
  }

  async recoverPending(): Promise<void> {
    const failures: unknown[] = []
    for (const batch of this.journal.pendingBatches()) {
      try {
        const bundle = this.journal.readBundle(batch.batchId)
        if (bundle === undefined) throw new SyncSessionError('journal-missing-bundle', '未完成的会话 journal 缺少 bundle')
        const validatedBundle = validateSyncSessionBundle(bundle)
        if (validatedBundle.digest !== batch.bundleDigest) {
          throw new SyncSessionError('journal-bundle-mismatch', '会话 journal bundle 摘要不匹配')
        }
        await this.serializeMutation(() => this.applyBundleNow(bundle, batch.sourceName, batch.peerId, {
          importedVia: batch.importedVia,
          allowSameInstance: batch.allowSameInstance,
        }, batch))
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more sync session batches remain pending')
    }
  }

  cleanupOrphanedStaging(): void {
    this.journal.cleanupOrphanedStaging()
  }

  listArchives(): SyncSessionArchive[] {
    return Object.values(this.state.read().archives).sort((a, b) => a.archivedAt.localeCompare(b.archivedAt))
  }

  exportCatalog(): Promise<{ workspaces: SyncCatalogWorkspace[]; sessions: SyncCatalogSession[] }> {
    return this.serializeMutation(async () => {
      const catalog = { workspaces: new Map<string, SyncCatalogWorkspace>(), sessions: [] as SyncCatalogSession[] }
      for (const mapping of Object.values(this.state.read().workspaces)) {
        const nodeOrigin = this.nodes.originForLocalNode(mapping.localNodeId)
        if (!nodeOrigin) continue
        const workspace: SyncCatalogWorkspace = {
          origin: { originInstanceId: mapping.originInstanceId, originEntityId: mapping.originWorkspaceId },
          nodeOrigin,
          remotePath: mapping.remotePath,
          title: mapping.title,
        }
        catalog.workspaces.set(syncWorkspaceKey(mapping.originInstanceId, mapping.originWorkspaceId, mapping.remotePath), workspace)
      }
      await this.exportBundleNow({ manifestOnly: true, catalog })
      return { workspaces: [...catalog.workspaces.values()], sessions: catalog.sessions }
    })
  }

  async listSessionSizes(): Promise<Array<{ sessionId: string; sizeBytes?: number }>> {
    const persistence = this.requirePersistence()
    const snapshots = await persistence.list()
    return snapshots.map((snapshot) => ({
      sessionId: String(snapshot.header.id),
      ...(isNonNegativeSafeInteger(snapshot.sizeBytes) ? { sizeBytes: snapshot.sizeBytes } : {}),
    }))
  }

  restoreArchive(branchId: string): Promise<SessionId> {
    return this.serializeMutation(() => this.restoreArchiveNow(branchId))
  }

  private async reuseCachedManifestEntry(
    persistence: SessionPersistenceLike,
    workspace: WorkspaceLike,
    descriptor: SyncSessionWorkspace,
    workspacePosition: number,
    sessionId: SessionId,
    firstSnapshot: SessionSnapshotLike,
    pinned: boolean,
    current: SyncRecordMetadata | undefined,
    stateIndex: SessionStateIndex,
  ): Promise<SyncSessionEntry | undefined> {
    if (!current || current.deleted || !current.workspaceOrigin) return undefined
    const cache = this.exportCache.get(sessionExportCacheKey(String(sessionId)))
    if (!cache || cache.metadata.contentDigest !== current.contentDigest ||
      cache.metadata.originInstanceId !== current.originInstanceId || cache.metadata.originEntityId !== current.originEntityId ||
      current.workspaceOrigin.originInstanceId !== descriptor.originInstanceId ||
      current.workspaceOrigin.originEntityId !== descriptor.originWorkspaceId ||
      current.stateDigest !== sessionStateDigest(descriptor, workspacePosition, false, pinned)) return undefined

    const stable = await readStableSessionMetadata(persistence, sessionId, firstSnapshot)
    if (!stable || !stable.header.cwd || posix.normalize(stable.header.cwd) !== posix.normalize(workspace.path)) return undefined
    const parentMetadata = stable.header.parentSession
      ? stateIndex.recordsByLocalId.get(String(stable.header.parentSession))
      : undefined
    const parentOrigin = parentMetadata
      ? { originInstanceId: parentMetadata.originInstanceId, originEntityId: parentMetadata.originEntityId }
      : undefined
    const instructionSnapshot = instructionsForSession(
      this.instructions,
      String(sessionId),
      stateIndex,
      { originInstanceId: descriptor.originInstanceId, originEntityId: descriptor.originWorkspaceId },
    )
    const fingerprint = sessionExportFingerprint({
      revision: stable.snapshot.revision,
      header: stable.header,
      inheritedEventCount: stable.inheritedEventCount,
      workspace: descriptor,
      instructionSnapshot,
      parentOrigin,
    })
    if (!fingerprint || fingerprint !== cache.fingerprint) return undefined
    return {
      metadata: current,
      eventCount: cache.eventCount,
      eventDigest: cache.eventDigest,
      inheritedEventCount: cache.inheritedEventCount,
    }
  }

  private async exportBundleNow(options: SessionExportOptions = {}): Promise<SyncSessionBundle> {
    const { manifestOnly = false, selectedKeys, sharedObjects: useSharedObjects = false } = options
    const persistence = this.requirePersistence()
    const workspaceRegistry = this.getWorkspaces()
    if (!workspaceRegistry) throw new SyncSessionError('workspace-unavailable', '工作区注册表不可用')
    await persistence.flush()

    const stateIndex = createSessionStateIndex(this.state.read())
    const instanceId = this.state.instanceId()
    const bindings = this.bindings.list()
    const bindingByMirrorPath = new Map<string, (typeof bindings)[number]>()
    for (const binding of bindings) {
      const key = normalizeHostPath(binding.mirrorPath)
      if (!bindingByMirrorPath.has(key)) bindingByMirrorPath.set(key, binding)
    }
    const workspaces = workspaceRegistry.list()
    const archivedIds = new Set(workspaceRegistry.archivedSessionIds.map(String))
    const pinnedIds = new Set((workspaceRegistry.pinnedSessionIds ?? []).map(String))
    const entries: SyncSessionEntry[] = []
    const skipped: Array<{ sessionId: string; reason: string }> = []
    const eligibleLocalIds = new Set<string>()
    // 因体积超限被跳过的活跃会话仍然存在于本地，绝不能被底部墓碑清理当成
    // "已消失"生成删除标记（否则远端会删掉这份还能正常打开的会话）。
    const preservedLocalIds = new Set<string>()
    const workspaceById = new Map<string, WorkspaceLike>()
    const archivedBranchSessionIds = new Set(Object.values(stateIndex.state.archives).map((archive) => archive.localSessionId))
    const objectCache = new ExportObjectCache()
    const descriptorCache = new Map<string, SyncSessionWorkspace>()
    const getWorkspaceDescriptor = (
      workspace: WorkspaceLike,
      binding: (typeof bindings)[number],
      nodeOrigin: SyncOrigin,
      preferredOrigin?: SyncOrigin,
    ): SyncSessionWorkspace => {
      const key = canonicalJson({
        workspace: { id: String(workspace.id), path: workspace.path, title: workspace.title },
        binding: { mirrorPath: normalizeHostPath(binding.mirrorPath), nodeId: binding.nodeId, remotePath: posix.normalize(binding.remotePath) },
        nodeOrigin,
        preferredOrigin,
      })
      const cached = descriptorCache.get(key)
      if (cached) return cached
      const descriptor = this.workspaceDescriptor(workspace, binding, nodeOrigin, preferredOrigin, stateIndex)
      descriptorCache.set(key, descriptor)
      return descriptor
    }
    const catalogWorkspacesByOrigin = new Map<string, SyncCatalogWorkspace>()
    for (const workspace of options.catalog?.workspaces.values() ?? []) {
      catalogWorkspacesByOrigin.set(JSON.stringify([workspace.origin.originInstanceId, workspace.origin.originEntityId]), workspace)
    }
    const collectWorkspace = (descriptor: SyncSessionWorkspace): SyncCatalogWorkspace | undefined => {
      if (!options.catalog) return undefined
      const origin = { originInstanceId: descriptor.originInstanceId, originEntityId: descriptor.originWorkspaceId }
      const workspace: SyncCatalogWorkspace = {
        origin,
        nodeOrigin: descriptor.nodeOrigin,
        remotePath: descriptor.remotePath,
        title: descriptor.title,
      }
      options.catalog.workspaces.set(syncWorkspaceKey(origin.originInstanceId, origin.originEntityId, descriptor.remotePath), workspace)
      catalogWorkspacesByOrigin.set(JSON.stringify([origin.originInstanceId, origin.originEntityId]), workspace)
      return workspace
    }
    const collectSession = (
      metadata: SyncRecordMetadata,
      workspace: SyncCatalogWorkspace | undefined,
      sessionId: string,
      sizeBytes?: number,
      extra: { branchId?: string; deleted?: boolean } = {},
    ): void => {
      if (!options.catalog) return
      options.catalog.sessions.push({
        origin: { originInstanceId: metadata.originInstanceId, originEntityId: metadata.originEntityId },
        ...(workspace ? {
          workspaceOrigin: workspace.origin,
          workspaceRemotePath: workspace.remotePath,
          nodeOrigin: workspace.nodeOrigin,
        }
          : metadata.workspaceOrigin ? { workspaceOrigin: metadata.workspaceOrigin } : {}),
        sessionId,
        ...(isNonNegativeSafeInteger(sizeBytes) ? { sizeBytes } : {}),
        ...(extra.branchId ? { branchId: extra.branchId } : {}),
        ...(extra.deleted ? { deleted: true } : {}),
      })
    }

    for (const workspace of workspaces) {
      workspaceById.set(String(workspace.id), workspace)
      const binding = bindingByMirrorPath.get(workspaceCandidateKey(workspace))
      if (!binding) continue
      const node = this.registry.get(binding.nodeId)
      if (!node || !isNodeRemoteType(node.type)) continue
      const nodeOrigin = this.nodes.originForLocalNode(node.id)
      if (!nodeOrigin) continue

      if (workspace.sessionIds.length > 0) {
        collectWorkspace(getWorkspaceDescriptor(workspace, binding, nodeOrigin))
      }

      for (let position = 0; position < workspace.sessionIds.length; position += 1) {
        const sessionId = String(workspace.sessionIds[position])
        if (archivedBranchSessionIds.has(sessionId)) continue
        const currentSession = stateIndex.recordsByLocalId.get(sessionId)
        if (currentSession?.deleted) continue
        const localKey = currentSession
          ? syncSessionEntryKey({ metadata: currentSession })
          : syncRecordKey('session', { originInstanceId: instanceId, originEntityId: sessionId })
        if (selectedKeys && !selectedKeys.has(localKey)) continue
        const descriptor = getWorkspaceDescriptor(workspace, binding, nodeOrigin, currentSession?.workspaceOrigin)
        const catalogWorkspace = collectWorkspace(descriptor)
        const snapshot = await persistence.stat(makeSessionId(sessionId))
        if (!snapshot) continue
        if (snapshot.formatStatus === 'migration-required') {
          throw new SyncSessionError('session-format', '会话格式需要由当前 DSH 版本迁移')
        }
        if (manifestOnly) {
          const cached = await this.reuseCachedManifestEntry(
            persistence,
            workspace,
            descriptor,
            position,
            makeSessionId(sessionId),
            snapshot,
            pinnedIds.has(sessionId),
            currentSession,
            stateIndex,
          )
          if (cached) {
            entries.push(cached)
            collectSession(cached.metadata, catalogWorkspace, sessionId, snapshot.sizeBytes)
            eligibleLocalIds.add(sessionId)
            continue
          }
        }
        let exported: SessionExportResult | undefined
        try {
          exported = await this.exportSessionEntry(
            persistence,
            workspace,
            descriptor,
            position,
            makeSessionId(sessionId),
            snapshot,
            archivedIds.has(sessionId),
            pinnedIds.has(sessionId),
            undefined,
            stateIndex,
            objectCache,
            options.deferredObjects === true,
          )
        } catch (error) {
          if (!(error instanceof SyncSessionError && error.code === 'session-too-large')) throw error
          skipped.push({ sessionId, reason: 'session-payload-too-large' })
          preservedLocalIds.add(sessionId)
          continue
        }
        if (exported) {
          const { entry } = exported
          collectSession(entry.metadata, catalogWorkspace, sessionId, snapshot.sizeBytes)
          if (manifestOnly && options.payloadCache) {
            const key = syncSessionEntryKey(entry)
            const size = estimateJsonBytes(entry, MAX_MANIFEST_PAYLOAD_CACHE_BYTES - options.payloadCache.bytes)
            if (size !== undefined) {
              options.payloadCache.entries.set(key, entry)
              options.payloadCache.bytes += size
            }
          }
          entries.push(manifestOnly
            ? {
                metadata: entry.metadata,
                ...(entry.branchId ? { branchId: entry.branchId } : {}),
                eventCount: exported.eventCount,
                eventDigest: exported.eventDigest,
                inheritedEventCount: exported.inheritedEventCount,
              }
            : entry)
          eligibleLocalIds.add(sessionId)
        } else skipped.push({ sessionId, reason: 'workspace-cwd-mismatch' })
      }
    }

    const initial = stateIndex.state
    for (const metadata of Object.values(initial.records)) {
      if (
        metadata.kind !== 'session' || archivedBranchSessionIds.has(metadata.localEntityId)
      ) continue
      if (selectedKeys && !selectedKeys.has(syncSessionEntryKey({ metadata }))) continue
      if (metadata.deleted) {
        entries.push({ metadata })
        const workspaceOrigin = metadata.workspaceOrigin
        const catalogWorkspace = workspaceOrigin
          ? catalogWorkspacesByOrigin.get(JSON.stringify([workspaceOrigin.originInstanceId, workspaceOrigin.originEntityId]))
          : undefined
        collectSession(metadata, catalogWorkspace, metadata.localEntityId, undefined, { deleted: true })
        const tombstoneKey = sessionExportCacheKey(metadata.localEntityId)
        this.exportCache.delete(tombstoneKey)
        this.exportCacheStore.delete(tombstoneKey)
        continue
      }
      if (eligibleLocalIds.has(metadata.localEntityId)) continue
      if (preservedLocalIds.has(metadata.localEntityId)) continue
      const tombstone: SyncRecordMetadata = {
        ...metadata,
        revision: this.state.nextRevision(this.now()),
        contentDigest: tombstoneDigest(metadata),
        deleted: true,
      }
      this.state.update((state) => {
        state.records[sessionOriginKey(metadata)] = tombstone
      })
      indexSessionRecord(stateIndex, tombstone)
      const tombstoneKey = sessionExportCacheKey(metadata.localEntityId)
      this.exportCache.delete(tombstoneKey)
      this.exportCacheStore.delete(tombstoneKey)
      entries.push({ metadata: tombstone })
    }

    for (const archive of Object.values(stateIndex.state.archives)) {
      if (selectedKeys && !selectedKeys.has(archive.branchId)) continue
      const workspace = archive.workspaceId ? workspaceById.get(archive.workspaceId) : undefined
      if (!workspace) continue
      const binding = bindingByMirrorPath.get(workspaceCandidateKey(workspace))
      const node = binding ? this.registry.get(binding.nodeId) : undefined
      if (!binding || !node || !isNodeRemoteType(node.type)) continue
      const nodeOrigin = this.nodes.originForLocalNode(node.id)
      if (!nodeOrigin) continue
      const archivedMetadata = stateIndex.archivesByLocalSessionId.get(archive.localSessionId)
      const descriptor = getWorkspaceDescriptor(workspace, binding, nodeOrigin, archivedMetadata?.workspaceOrigin)
      const catalogWorkspace = collectWorkspace(descriptor)
      const snapshot = await persistence.stat(makeSessionId(archive.localSessionId))
      if (!snapshot) continue
      let exported: SessionExportResult | undefined
      try {
        exported = await this.exportSessionEntry(
          persistence,
          workspace,
          descriptor,
          archive.workspacePosition,
          makeSessionId(archive.localSessionId),
          snapshot,
          true,
          false,
          archive,
          stateIndex,
          objectCache,
          options.deferredObjects === true,
        )
      } catch (error) {
        if (!(error instanceof SyncSessionError && error.code === 'session-too-large')) throw error
        skipped.push({ sessionId: archive.localSessionId, reason: 'session-payload-too-large' })
        preservedLocalIds.add(archive.localSessionId)
        continue
      }
      if (exported) {
        const { entry } = exported
        collectSession(entry.metadata, catalogWorkspace, archive.localSessionId, snapshot.sizeBytes, { branchId: archive.branchId })
        if (manifestOnly && options.payloadCache) {
          const key = syncSessionEntryKey(entry)
          const size = estimateJsonBytes(entry, MAX_MANIFEST_PAYLOAD_CACHE_BYTES - options.payloadCache.bytes)
          if (size !== undefined) {
            options.payloadCache.entries.set(key, entry)
            options.payloadCache.bytes += size
          }
        }
        entries.push(manifestOnly
          ? {
              metadata: entry.metadata,
              ...(entry.branchId ? { branchId: entry.branchId } : {}),
              eventCount: exported.eventCount,
              eventDigest: exported.eventDigest,
              inheritedEventCount: exported.inheritedEventCount,
            }
          : entry)
      } else skipped.push({ sessionId: archive.localSessionId, reason: 'archive-workspace-cwd-mismatch' })
    }

    const bundleSharedObjects = useSharedObjects && entries.some((entry) => (entry.objects?.length ?? 0) > 0)
      ? this.dedupeBundleObjects(entries)
      : undefined
    this.exportCacheStore.flush()
    return makeSyncSessionBundle(instanceId, entries, skipped, bundleSharedObjects)
  }

  private dedupeBundleObjects(entries: SyncSessionEntry[]): SyncSessionObject[] {
    const shared = new Map<string, SyncSessionObject>()
    for (const entry of entries) {
      for (const object of entry.objects ?? []) {
        const current = shared.get(object.id)
        if (current === undefined) shared.set(object.id, object)
        else if (current.digest !== object.digest || current.bytes !== object.bytes) {
          throw new SyncSessionError('object-invalid', 'the same object id carries different payloads')
        }
      }
    }
    return [...shared.values()]
  }

  private async applyBundleNow(
    value: unknown,
    sourceName: string,
    peerId: string,
    options: SyncSessionApplyOptions,
    recoveryBatch?: SyncSessionJournalBatch,
  ): Promise<SyncSessionApplyResult> {
    const transferredBundle = validateSyncSessionBundle(value)
    const importedVia = recoveryBatch?.importedVia ?? options.importedVia ?? 'peer'
    if (importedVia !== 'peer' && transferredBundle.entries.some((entry) => entry.eventDelta)) {
      throw new SyncSessionError('manifest-invalid', 'event tail deltas are only accepted from sync peers')
    }
    let pendingBatch = recoveryBatch ?? this.journal.findBatch(peerId, transferredBundle.digest)
    if (pendingBatch && !transferredBundle.entries.some((entry) => entry.eventDelta) &&
      (pendingBatch.bundleDigest !== transferredBundle.digest || pendingBatch.peerId !== peerId)) {
      throw new SyncSessionError('journal-bundle-mismatch', '会话 journal batch 与 bundle 不匹配')
    }
    if (!pendingBatch) await this.exportBundleNow({ manifestOnly: true })
    const bundle = await this.expandEventDeltas(transferredBundle)
    pendingBatch ??= recoveryBatch ?? this.journal.findBatch(peerId, bundle.digest)
    if (pendingBatch && (pendingBatch.bundleDigest !== bundle.digest || pendingBatch.peerId !== peerId)) {
      throw new SyncSessionError('journal-bundle-mismatch', '会话 journal batch 与 bundle 不匹配')
    }
    const resolvedImportedVia = pendingBatch?.importedVia ?? importedVia
    const allowSameInstance = pendingBatch?.allowSameInstance ?? options.allowSameInstance ?? false
    const localInstanceId = this.state.instanceId()
    if (bundle.instanceId === localInstanceId && !allowSameInstance) {
      throw new SyncSessionError('same-instance', 'cannot import sessions from this instance')
    }
    this.preflightBundle(bundle, { importedVia: resolvedImportedVia, allowSameInstance })
    const safeSourceName = (pendingBatch?.sourceName ?? sourceName).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128) || 'sync peer'
    const recordKeys = bundle.entries.map((entry) => entry.branchId ?? sessionOriginKey(entry.metadata))
    const batchId = pendingBatch?.batchId ?? this.journal.beginWithBundle(
      peerId,
      safeSourceName,
      bundle.digest,
      recordKeys,
      bundle,
      new Date(this.now()).toISOString(),
      resolvedImportedVia,
      allowSameInstance,
    )
    const result = emptyApplyResult()
    const attachmentImportCache = new Map<string, ImportedSessionObjectRef>()
    // 带外对象水合时消费的收件箱 digest；apply 成功后统一删除。
    const inboxConsumed = new Set<string>()
    result.skipped += bundle.skipped.length
    result.unmapped += bundle.skipped.length
    const workspaceOrders = new Map<string, Array<{ id: SessionId; position: number }>>()
    const plannedSessionIds = new Map<string, SessionId>()
    for (const entry of bundle.entries) {
      if (!entry.metadata.deleted && !entry.branchId) {
        const current = this.state.read().records[sessionOriginKey(entry.metadata)]
        const localId = current && !current.deleted && current.contentDigest === entry.metadata.contentDigest
          ? makeSessionId(current.localEntityId)
          : importedSessionId(entry.metadata)
        plannedSessionIds.set(sessionOriginKey(entry.metadata), localId)
      }
    }
    const workspaceResolutions = new Map<string, Promise<WorkspaceLike | undefined>>()
    const resolveWorkspace = (entry: SyncSessionEntry): Promise<WorkspaceLike | undefined> => {
      const descriptor = entry.workspace
      if (!descriptor) return Promise.resolve(undefined)
      const workspaceKey = syncWorkspaceKey(descriptor.originInstanceId, descriptor.originWorkspaceId, descriptor.remotePath)
      let resolution = workspaceResolutions.get(workspaceKey)
      if (!resolution) {
        resolution = this.ensureWorkspace(descriptor).catch((error: unknown) => {
          if (error instanceof SyncSessionError && error.code === 'workspace-unmapped') return undefined
          throw error
        })
        workspaceResolutions.set(workspaceKey, resolution)
      }
      return resolution
    }

    try {
      const queueWorkspaceOrder = (workspaceId: string, id: SessionId, position: number): void => {
        const order = workspaceOrders.get(workspaceId) ?? []
        order.push({ id, position })
        workspaceOrders.set(workspaceId, order)
      }
      const entries = [...bundle.entries].sort((a, b) => {
        if (a.branchId || b.branchId) return (a.branchId ?? '').localeCompare(b.branchId ?? '')
        if (a.workspace?.originWorkspaceId !== b.workspace?.originWorkspaceId) {
          return (a.workspace?.originWorkspaceId ?? '').localeCompare(b.workspace?.originWorkspaceId ?? '')
        }
        return (b.workspacePosition ?? 0) - (a.workspacePosition ?? 0)
      })

      for (const entry of entries) {
        const key = entry.branchId ?? sessionOriginKey(entry.metadata)
        if (entry.metadata.deleted) {
          const changed = await this.applyTombstone(entry.metadata)
          if (changed) result.deleted += 1
          else result.skipped += 1
          continue
        }
        const entryWorkspace = await resolveWorkspace(entry)
        if (!entryWorkspace) {
          result.skipped += 1
          result.unmapped += 1
          continue
        }

        const currentState = this.state.read()
        const currentArchive = entry.branchId ? currentState.archives[entry.branchId] : undefined
        if (entry.branchId && currentArchive) {
          const comparison = compareSyncRevision(entry.metadata.revision, currentArchive.revision)
          if (comparison < 0) {
            result.skipped += 1
            continue
          }
          if (comparison === 0) {
            if (entry.metadata.contentDigest !== currentArchive.contentDigest || entry.metadata.stateDigest !== currentArchive.stateDigest) {
              throw new SyncSessionError('revision-conflict', 'Equal archive revisions contain different content')
            }
            const sessionId = makeSessionId(currentArchive.localSessionId)
            const snapshot = await this.requirePersistence().stat(sessionId)
            if (snapshot && normalizeHostPath(snapshot.header.cwd ?? '') === normalizeHostPath(entryWorkspace.path)) {
              await entryWorkspace.attachSession(sessionId)
              queueWorkspaceOrder(entryWorkspace.id, sessionId, entry.workspacePosition ?? currentArchive.workspacePosition)
            }
            result.skipped += 1
            continue
          }
          if (entry.metadata.contentDigest !== currentArchive.contentDigest) {
            throw new SyncSessionError('archive-conflict', 'A session archive ID was reused for different content')
          }
          await this.applyArchiveStateOnly(entry, currentArchive, entryWorkspace)
          result.updated += 1
          queueWorkspaceOrder(entryWorkspace.id, makeSessionId(currentArchive.localSessionId), entry.workspacePosition ?? 0)
          continue
        }
        const current = entry.branchId ? undefined : currentState.records[sessionOriginKey(entry.metadata)]
        if (current) {
          const comparison = compareSyncRevision(entry.metadata.revision, current.revision)
          if (comparison < 0) {
            result.skipped += 1
            continue
          }
          if (comparison === 0) {
            if (current.deleted || entry.metadata.contentDigest !== current.contentDigest || entry.metadata.stateDigest !== current.stateDigest) {
              throw new SyncSessionError('revision-conflict', 'Equal session revisions contain different content')
            }
            const sessionId = makeSessionId(current.localEntityId)
            const snapshot = await this.requirePersistence().stat(sessionId)
            if (snapshot && normalizeHostPath(snapshot.header.cwd ?? '') === normalizeHostPath(entryWorkspace.path)) {
              await entryWorkspace.attachSession(sessionId)
              queueWorkspaceOrder(entryWorkspace.id, sessionId, entry.workspacePosition ?? 0)
            }
            result.skipped += 1
            continue
          }
          if (!current.deleted && entry.metadata.contentDigest === current.contentDigest && (await this.requirePersistence().stat(makeSessionId(current.localEntityId)))) {
            await this.applyMembershipOnly(entry, current, safeSourceName, entryWorkspace, resolvedImportedVia)
            result.updated += 1
            queueWorkspaceOrder(entryWorkspace.id, makeSessionId(current.localEntityId), entry.workspacePosition ?? 0)
            continue
          }
        }

        let preparedValue = this.journal.readPrepared(batchId, key)
        let prepared: PreparedSyncSession
        if (preparedValue === undefined) {
          try {
            prepared = await this.prepareEntry(entry, safeSourceName, plannedSessionIds, entryWorkspace, resolvedImportedVia, attachmentImportCache, inboxConsumed)
          } catch (error) {
            if (error instanceof SyncSessionError && error.code === 'workspace-unmapped') {
              result.skipped += 1
              result.unmapped += 1
              continue
            }
            throw error
          }
          this.journal.writePrepared(batchId, key, prepared)
          preparedValue = prepared
        }
        prepared = this.validatePrepared(preparedValue)

        if (current && !current.deleted && current.localEntityId !== prepared.localSessionId) {
          if (await this.archiveCurrent(current)) result.archived += 1
        }

        const existed = (await this.requirePersistence().stat(prepared.localSessionId)) !== undefined
        await this.applyPrepared(prepared)
        if (prepared.branchId) result.archived += 1
        else if (existed) result.updated += 1
        else result.created += 1

        queueWorkspaceOrder(prepared.workspaceId, prepared.localSessionId, prepared.workspacePosition)
      }

      await this.orderWorkspaceSessions(workspaceOrders)
      this.journal.complete(batchId)
      this.exportCacheStore.flush()
      // 批量应用成功：水合已完成的带外对象收件箱文件可以删除了。
      // 失败路径保留收件箱，journal 回放仍能水合。
      if (inboxConsumed.size > 0) await this.deleteInboxedObjects(inboxConsumed)
      return result
    } catch (error) {
      if (error instanceof SyncSessionError) throw error
      throw new SyncSessionError('session-apply-failed', '会话同步应用失败', error)
    }
  }

  private async expandEventDeltas(bundle: SyncSessionBundle): Promise<SyncSessionBundle> {
    if (!bundle.entries.some((entry) => entry.eventDelta)) return bundle
    const persistence = this.requirePersistence()
    const state = this.state.read()
    const entries: SyncSessionEntry[] = []
    for (const entry of bundle.entries) {
      const delta = entry.eventDelta
      if (!delta) {
        entries.push(entry)
        continue
      }
      const current = state.records[sessionOriginKey(entry.metadata)]
      if (!current || current.deleted) throw new SyncSessionError('session-delta-prefix', 'event delta base session is missing')
      const snapshot = await persistence.stat(makeSessionId(current.localEntityId))
      if (!snapshot) throw new SyncSessionError('session-delta-prefix', 'event delta base session is missing')
      const stable = await this.readStableSession(persistence, makeSessionId(current.localEntityId), snapshot)
      if (stable.events.length !== delta.baseEventCount ||
        stable.inheritedEventCount !== delta.baseInheritedEventCount ||
        sessionEventListDigest(stable.events) !== delta.baseEventDigest) {
        throw new SyncSessionError('session-delta-prefix', 'event delta base prefix no longer matches')
      }
      const events = [...stable.events, ...(entry.events ?? [])]
      if (events.length !== delta.fullEventCount || sessionEventListDigest(events) !== delta.fullEventDigest) {
        throw new SyncSessionError('manifest-invalid', 'expanded event delta digest does not match')
      }
      const fullEntry: SyncSessionEntry = { ...entry, events }
      delete fullEntry.eventDelta
      entries.push(fullEntry)
    }
    return validateSyncSessionBundle(makeSyncSessionBundle(bundle.instanceId, entries, bundle.skipped))
  }

  private async prepareEntry(
    entry: SyncSessionEntry,
    sourceName: string,
    plannedSessionIds: ReadonlyMap<string, SessionId>,
    workspace: WorkspaceLike,
    importedVia: SyncImportMethod,
    attachmentImportCache?: Map<string, ImportedSessionObjectRef>,
    inboxConsumed?: Set<string>,
  ): Promise<PreparedSyncSession> {
    if (!entry.header || !entry.events || !entry.workspace || !entry.objects) {
      throw new SyncSessionError('manifest-invalid', 'active session entry is incomplete')
    }
    const sessionId = entry.branchId ? archivedSessionId(entry.branchId) : importedSessionId(entry.metadata)
    const sourceHeader = entry.header
    const headerWithoutLocalFields = { ...sourceHeader } as Record<string, unknown>
    delete headerWithoutLocalFields.id
    delete headerWithoutLocalFields.cwd
    delete headerWithoutLocalFields.parentSession
    const parentSession = (entry.parentOrigin
      ? plannedSessionIds.get(syncRecordKey('session', entry.parentOrigin)) ?? this.localSessionIdForOrigin(entry.parentOrigin)
      : undefined) ?? sourceHeader.parentSession
    const header: SessionHeader = {
      ...headerWithoutLocalFields,
      id: sessionId,
      cwd: workspace.path,
      ...(parentSession ? { parentSession } : {}),
    } as SessionHeader
    const inheritedEventCount = entry.inheritedEventCount ?? 0
    const persistence = this.requirePersistence()
    if (await persistence.stat(sessionId)) {
      const handle = await persistence.open(sessionId, 'read')
      try {
        if (canonicalJson(handle.header) !== canonicalJson(header) || handle.inheritedEventCount !== inheritedEventCount) {
          throw new SyncSessionError('session-id-conflict', '目标 session ID 已被其他 header 占用')
        }
      } finally {
        await handle.close()
      }
    }
    const objectMap = await this.importObjects(entry.objects, sessionId, attachmentImportCache, inboxConsumed)
    const events = this.rewriteEvents(entry.events, entry.objects, objectMap, sessionId, String(entry.header.id))
    const validatedEvents = validateStoredEvents(header, events)
    assertContiguous(sessionId, validatedEvents, 0)
    const instructionWorkspaceId = entry.instructionSnapshot?.workspaceOrigin
      ? this.localWorkspaceIdForOrigin(entry.instructionSnapshot.workspaceOrigin, entry.instructionSnapshot.workspaceRemotePath)
      : undefined
    const instructionSnapshot: SessionInstructionSnapshot | undefined = entry.instructionSnapshot
      ? {
          sessionId,
          ...(instructionWorkspaceId ? { workspaceId: instructionWorkspaceId } : {}),
          ...(entry.instructionSnapshot.workspaceRevision === undefined ? {} : { workspaceRevision: entry.instructionSnapshot.workspaceRevision }),
          ...(entry.instructionSnapshot.digest === undefined ? {} : { digest: entry.instructionSnapshot.digest }),
          text: entry.instructionSnapshot.text,
          capturedAt: entry.instructionSnapshot.capturedAt,
          ...(parentSession ? { inheritedFromSessionId: parentSession } : {}),
        }
      : undefined
    return {
      metadata: entry.metadata,
      ...(entry.branchId ? { branchId: entry.branchId } : {}),
      localSessionId: sessionId,
      header,
      inheritedEventCount,
      events: [...validatedEvents],
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      workspace: entry.workspace,
      workspacePosition: entry.workspacePosition ?? 0,
      archived: Boolean(entry.archived || entry.branchId),
      pinned: Boolean(entry.pinned && !entry.archived && !entry.branchId),
      sourceName,
      importedVia,
      ...(instructionSnapshot ? { instructionSnapshot } : {}),
    }
  }

  private async ensureWorkspace(descriptor: SyncSessionWorkspace): Promise<WorkspaceLike> {
    const workspaceRegistry = this.getWorkspaces()
    if (!workspaceRegistry) throw new SyncSessionError('workspace-unavailable', '工作区注册表不可用')
    const key = syncWorkspaceKey(descriptor.originInstanceId, descriptor.originWorkspaceId, descriptor.remotePath)
    const committedWorkspace = await this.nodes.withAvailableRemoteNode(descriptor.nodeOrigin, async (activeNodeId) => {
      const node = this.registry.get(activeNodeId)
      if (!node || !isNodeRemoteType(node.type)) return undefined
      const latest = this.state.read().workspaces[key]
      const latestComparison = latest ? compareSyncRevision(descriptor.revision, latest.revision) : 1
      if (latest && latestComparison === 0 && latest.contentDigest !== descriptor.contentDigest) {
        throw new SyncSessionError('workspace-conflict', 'Equal workspace revisions contain different content')
      }
      const latestTitle = latest && latestComparison < 0 ? latest.title : descriptor.title
      let binding = this.bindings.list().find((item) =>
        item.nodeId === activeNodeId && posix.normalize(item.remotePath) === descriptor.remotePath,
      )
      let workspace = latest ? workspaceRegistry.get(latest.localWorkspaceId) : undefined
      if (!workspace && binding) {
        workspace = workspaceRegistry.list().find((item) => normalizeHostPath(item.path) === normalizeHostPath(binding!.mirrorPath))
      }
      if (!workspace) {
        const mirrorPath = latest?.localPath ?? binding?.mirrorPath ??
          this.bindings.mirrorRoot(activeNodeId, `sync-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`)
        mkdirSync(mirrorPath, { recursive: true, mode: 0o700 })
        workspace = await workspaceRegistry.create(mirrorPath, latestTitle)
      }
      if (workspace.title !== latestTitle) await workspace.setTitle(latestTitle)

      let activeBinding = binding ?? this.bindings.list().find((item) =>
        normalizeHostPath(item.mirrorPath) === normalizeHostPath(workspace!.path),
      )
      if (!activeBinding || activeBinding.nodeId !== activeNodeId || posix.normalize(activeBinding.remotePath) !== descriptor.remotePath) {
        activeBinding = {
          mirrorPath: workspace!.path,
          nodeId: activeNodeId,
          remotePath: descriptor.remotePath,
          workspaceId: workspace!.id,
        }
        this.bindings.add(activeBinding)
      }
      const localMappingChanged = !latest || latest.localWorkspaceId !== workspace!.id ||
        latest.localPath !== workspace!.path || latest.localNodeId !== activeNodeId
      if (!latest || latestComparison > 0 || localMappingChanged) {
        const mapping: SyncWorkspaceMapping = {
          ...descriptor,
          title: latestTitle,
          ...(latest && latestComparison < 0 ? { revision: latest.revision, contentDigest: latest.contentDigest } : {}),
          localWorkspaceId: workspace!.id,
          localPath: workspace!.path,
          localNodeId: activeNodeId,
        }
        this.state.update((state) => { state.workspaces[key] = mapping })
      }
      return workspace
    })
    if (!committedWorkspace) throw new SyncSessionError('workspace-unmapped', '目标实例没有对应的可用远程节点')
    return committedWorkspace
  }

  private async importObjects(
    objects: readonly SyncSessionObject[],
    sessionId: SessionId,
    attachmentImportCache?: Map<string, ImportedSessionObjectRef>,
    inboxConsumed?: Set<string>,
  ): Promise<Map<string, ImportedSessionObjectRef>> {
    const attachments = objects.some((object) => object.kind === 'image' || object.kind === 'file')
      ? this.getAttachments()
      : undefined
    const spills = objects.some((object) => object.kind === 'spill' && !object.unavailable) ? this.getSpills() : undefined
    if (objects.some((object) => object.kind === 'image' || object.kind === 'file') && !attachments) {
      throw new SyncSessionError('attachments-unavailable', '目标实例的附件存储服务不可用')
    }
    if (objects.some((object) => object.kind === 'spill' && !object.unavailable) && !spills) {
      throw new SyncSessionError('spill-transfer-unavailable', '目标实例没有 owner-scoped spill transfer API')
    }
    const output = new Map<string, ImportedSessionObjectRef>()
    for (const object of objects) {
      if (object.kind === 'spill' && object.unavailable) continue
      if (object.kind !== 'spill') {
        const cached = attachmentImportCache?.get(object.id)
        if (cached) { output.set(object.id, cached); continue }
      }
      if (object.deferred === true) {
        // 带外对象：从收件箱流式水合进本地存储（文件/spill 走流式写，
        // 图片体积有限走缓冲），全程不把整块载荷读进堆。
        inboxConsumed?.add(object.digest)
        if (object.kind === 'image') {
          const stream = await this.objectInbox.read(object.digest)
          const data = await collectBytes(stream, MAX_SESSION_OBJECT_INLINE_BYTES * 256)
          if (data.byteLength !== object.bytes || sha256(data) !== object.digest) {
            throw new SyncSessionError('object-integrity', 'session object failed digest validation')
          }
          const ref = await attachments!.saveImage({
            data,
            mediaType: object.ref.mediaType,
            ...(object.ref.name === undefined ? {} : { name: object.ref.name }),
          })
          output.set(object.id, ref)
          attachmentImportCache?.set(object.id, ref)
        } else if (object.kind === 'file') {
          const stream = await this.objectInbox.read(object.digest)
          const ref = await attachments!.saveFileStream({
            data: verifiedObjectStream(stream, object.bytes, object.digest),
            name: object.ref.name,
          })
          output.set(object.id, ref)
          attachmentImportCache?.set(object.id, ref)
        } else {
          if (spills!.saveTextStream) {
            const stream = await this.objectInbox.read(object.digest)
            const ref = await saveSpillTransfer(spills!, {
              owner: { sessionId },
              source: object.reference.source,
              suggestedName: object.reference.suggestedName,
              transferId: object.id,
              bytes: object.bytes,
              digest: object.digest,
              content: verifiedObjectStream(stream, object.bytes, object.digest),
            })
            output.set(object.id, ref)
          } else {
            const stream = await this.objectInbox.read(object.digest)
            const data = await collectBytes(stream, MAX_SESSION_OBJECT_INLINE_BYTES * 1024)
            if (data.byteLength !== object.bytes || sha256(data) !== object.digest) {
              throw new SyncSessionError('object-integrity', 'session object failed digest validation')
            }
            const ref = await saveSpillTransfer(spills!, {
              owner: { sessionId },
              source: object.reference.source,
              suggestedName: object.reference.suggestedName,
              transferId: object.id,
              bytes: object.bytes,
              digest: object.digest,
              data,
            })
            output.set(object.id, ref)
          }
        }
        continue
      }
      const data = arrayBuffer(object.data)
      if (data.byteLength !== object.bytes || sha256(data) !== object.digest) {
        throw new SyncSessionError('object-integrity', 'session object failed digest validation')
      }
      if (object.kind === 'image') {
        const ref = await attachments!.saveImage({
          data,
          mediaType: object.ref.mediaType,
          ...(object.ref.name === undefined ? {} : { name: object.ref.name }),
        })
        output.set(object.id, ref)
        attachmentImportCache?.set(object.id, ref)
      } else if (object.kind === 'file') {
        const ref = await attachments!.saveFileStream({
          data: oneChunk(data),
          name: object.ref.name,
        })
        output.set(object.id, ref)
        attachmentImportCache?.set(object.id, ref)
      } else {
        const ref = await saveSpillTransfer(spills!, {
          owner: { sessionId },
          source: object.reference.source,
          suggestedName: object.reference.suggestedName,
          transferId: object.id,
          bytes: object.bytes,
          digest: object.digest,
          data,
        })
        output.set(object.id, ref)
      }
    }
    return output
  }

  private rewriteEvents(
    events: readonly SessionEvent[],
    objects: readonly SyncSessionObject[],
    importedRefs: ReadonlyMap<string, ImportedSessionObjectRef>,
    sessionId: SessionId,
    sourceSessionId: string,
  ): SessionEvent[] {
    const spillReferencesByLocator = new Map<string, { source: SpillTransferReference; target?: SpillTransferReference['ref'] }>()
    for (const object of objects) {
      if (object.kind !== 'spill') continue
      if (object.unavailable) {
        spillReferencesByLocator.set(object.reference.ref.locator, { source: object.reference })
        continue
      }
      const target = importedRefs.get(object.id)
      if (!target || !('locator' in target)) throw new SyncSessionError('spill-reference-missing', '目标 spill reference 未创建')
      spillReferencesByLocator.set(object.reference.ref.locator, { source: object.reference, target })
    }

    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite)
      if (!isRecord(value)) return value
      if (value.type === 'image' && isImageRef(value.attachment)) {
        const target = importedRefs.get(attachmentKey('image', value.attachment))
        if (!target || !('mediaType' in target)) throw new SyncSessionError('attachment-reference-missing', '目标图片附件未创建')
        return { ...value, attachment: target }
      }
      if (value.type === 'file' && isFileRef(value.attachment)) {
        const target = importedRefs.get(attachmentKey('file', value.attachment))
        if (!target || !('name' in target)) throw new SyncSessionError('attachment-reference-missing', '目标文件附件未创建')
        return { ...value, attachment: target }
      }
      if (value.type === 'session-log-deepseek/delivery-accepted' && isRecord(value.data) && value.data.sessionId === sourceSessionId) {
        // Inherited markers keep their ancestor ID; current-session markers follow the imported header ID.
        return { ...value, data: { ...value.data, sessionId } }
      }
      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        if (key === SPILL_ARTIFACT_META_KEY && isRecord(child) && Array.isArray(child.references)) {
          const filteredReferences = child.references.filter((entry) => {
            if (!isRecord(entry) || !isRecord(entry.owner) || !isRecord(entry.ref)) return false
            const reference = entry as unknown as SpillTransferReference
            const mapped = spillReferencesByLocator.get(reference.ref.locator)
            return mapped?.target !== undefined
          })
          if (filteredReferences.length === 0) continue
          output[key] = {
            version: child.version,
            references: filteredReferences.map((entry) => {
              const reference = entry as unknown as SpillTransferReference
              const mapped = spillReferencesByLocator.get(reference.ref.locator)
              if (!mapped?.target) throw new SyncSessionError('spill-reference-missing', '目标 spill reference 未创建')
              return { ...reference, owner: { sessionId }, ref: mapped.target }
            }),
          }
        } else if (key === 'text' && typeof child === 'string') {
          let text = child
          for (const { source, target } of spillReferencesByLocator.values()) {
            if (!target) continue
            text = text.replaceAll(
              `Full formatted result stored at: ${source.ref.locator}. ${source.ref.retrievalHint}`,
              `Full formatted result stored at: ${target.locator}. ${target.retrievalHint}`,
            )
          }
          output[key] = text
        } else {
          output[key] = rewrite(child)
        }
      }
      return output
    }
    return events.map((event) => snapshotSessionEvent(rewrite(structuredClone(event)) as SessionEvent))
  }

  private validatePrepared(value: unknown): PreparedSyncSession {
    if (
      !isRecord(value) || !isRecord(value.metadata) || value.metadata.kind !== 'session' ||
      typeof value.localSessionId !== 'string' || !isRecord(value.header) || value.header.id !== value.localSessionId ||
      typeof value.workspaceId !== 'string' || typeof value.workspacePath !== 'string' ||
      !Array.isArray(value.events) || typeof value.workspacePosition !== 'number' ||
      typeof value.archived !== 'boolean' || typeof value.pinned !== 'boolean' || typeof value.sourceName !== 'string' ||
      (value.importedVia !== 'peer' && value.importedVia !== 'offline')
    ) throw new SyncSessionError('journal-invalid', 'prepared session record is invalid')
    const header = value.header as unknown as SessionHeader
    if (header.version !== SESSION_FORMAT_VERSION) throw new SyncSessionError('session-format', 'prepared session format is unsupported')
    const events = validateStoredEvents(header, structuredClone(value.events) as SessionEvent[])
    assertContiguous(header.id, events, 0)
    if (
      !Number.isSafeInteger(value.workspacePosition) || value.workspacePosition < 0 ||
      typeof value.inheritedEventCount !== 'number' || !Number.isSafeInteger(value.inheritedEventCount) || value.inheritedEventCount < 0 ||
      !isRecord(value.workspace)
    ) throw new SyncSessionError('journal-invalid', 'prepared session metadata is invalid')
    return {
      metadata: value.metadata as unknown as SyncRecordMetadata,
      ...(typeof value.branchId === 'string' ? { branchId: value.branchId } : {}),
      localSessionId: makeSessionId(value.localSessionId),
      header,
      inheritedEventCount: value.inheritedEventCount,
      events: [...events],
      workspaceId: value.workspaceId,
      workspacePath: value.workspacePath,
      workspace: value.workspace as unknown as SyncSessionWorkspace,
      workspacePosition: value.workspacePosition,
      archived: value.archived,
      pinned: value.pinned,
      sourceName: value.sourceName,
      importedVia: value.importedVia,
      ...(isRecord(value.instructionSnapshot) ? { instructionSnapshot: value.instructionSnapshot as unknown as SessionInstructionSnapshot } : {}),
    }
  }

  private async applyPrepared(prepared: PreparedSyncSession): Promise<boolean> {
    const sessionId = prepared.localSessionId
    const existed = await this.writeSession(prepared)

    if (prepared.instructionSnapshot) {
      this.instructions.restore(prepared.instructionSnapshot)
      // 工作区级指令采纳：快照携带的注入内容按对端修订恢复到映射后的本地工作区，
      // 使对端工作区新建的会话同样获得该注入（缺失或对端修订更新时采纳）。
      const snapshot = prepared.instructionSnapshot
      if (snapshot.workspaceId && snapshot.workspaceRevision !== undefined) {
        try {
          this.workspaceInstructions.restoreWorkspace({
            workspaceId: snapshot.workspaceId,
            text: snapshot.text,
            revision: snapshot.workspaceRevision,
            capturedAt: snapshot.capturedAt,
          })
        } catch (error) {
          if (!(error instanceof InstructionSizeError)) throw error
        }
      }
    }
    const registry = this.getWorkspaces()
    const workspace = registry?.get(prepared.workspaceId)
    if (!registry || !workspace || normalizeHostPath(workspace.path) !== normalizeHostPath(prepared.workspacePath)) {
      throw new SyncSessionError('workspace-unmapped', '导入 session 的目标工作区不可用')
    }
    await workspace.attachSession(sessionId)
    if (prepared.archived) await registry.archiveSession(sessionId, { stopActivity: true })
    else await registry.unarchiveSession(sessionId)
    if (prepared.pinned && !prepared.archived) await registry.pinSession?.(sessionId)
    else await registry.unpinSession?.(sessionId)

    this.state.observeRevision(prepared.metadata.revision, this.now())
    const binding = this.bindings.list().find((item) => normalizeHostPath(item.mirrorPath) === normalizeHostPath(prepared.workspacePath))
    if (!binding) throw new SyncSessionError('workspace-unmapped', '导入 session 的节点绑定不可用')
    const activeMetadata: SyncRecordMetadata = {
      ...prepared.metadata,
      localEntityId: String(sessionId),
      importedVia: prepared.importedVia,
      sourceName: prepared.sourceName,
      stateDigest: prepared.metadata.stateDigest ?? sessionStateDigest(prepared.workspace, prepared.workspacePosition, prepared.archived, prepared.pinned),
      workspaceOrigin: {
        originInstanceId: prepared.workspace.originInstanceId,
        originEntityId: prepared.workspace.originWorkspaceId,
      },
      deleted: false,
      pendingRemoval: false,
    }
    const key = sessionOriginKey(prepared.metadata)
    this.state.update((state) => {
      const mappingKey = syncWorkspaceKey(
        prepared.workspace.originInstanceId,
        prepared.workspace.originWorkspaceId,
        prepared.workspace.remotePath,
      )
      state.workspaces[mappingKey] = {
        ...prepared.workspace,
        localWorkspaceId: prepared.workspaceId,
        localPath: prepared.workspacePath,
        localNodeId: binding.nodeId,
      }
      if (prepared.branchId) {
        state.archives[prepared.branchId] = {
          branchId: prepared.branchId,
          originInstanceId: prepared.metadata.originInstanceId,
          originSessionId: prepared.metadata.originEntityId,
          localSessionId: String(sessionId),
          revision: prepared.metadata.revision,
          contentDigest: prepared.metadata.contentDigest,
          stateDigest: prepared.metadata.stateDigest ?? sessionStateDigest(prepared.workspace, prepared.workspacePosition, true, false),
          workspacePosition: prepared.workspacePosition,
          workspaceId: prepared.workspaceId,
          workspaceOrigin: {
            originInstanceId: prepared.workspace.originInstanceId,
            originEntityId: prepared.workspace.originWorkspaceId,
          },
          archivedAt: new Date(this.now()).toISOString(),
        }
      } else {
        state.records[key] = activeMetadata
      }
    })
    return existed
  }

  private async applyMembershipOnly(
    entry: SyncSessionEntry,
    current: SyncRecordMetadata,
    sourceName: string,
    workspace: WorkspaceLike,
    importedVia: SyncImportMethod,
  ): Promise<void> {
    const descriptor = entry.workspace
    const stateDigest = entry.metadata.stateDigest
    if (!descriptor || !stateDigest) throw new SyncSessionError('manifest-invalid', 'session state entry is incomplete')
    const registry = this.getWorkspaces()
    if (!registry) throw new SyncSessionError('workspace-unavailable', '工作区注册表不可用')
    const sessionId = makeSessionId(current.localEntityId)
    const snapshot = await this.requirePersistence().stat(sessionId)
    if (!snapshot || normalizeHostPath(snapshot.header.cwd ?? '') !== normalizeHostPath(workspace.path)) {
      throw new SyncSessionError('session-workspace-mismatch', '既有 session 的本地 cwd 与目标 workspace 不一致')
    }
    await workspace.attachSession(sessionId)
    if (entry.archived) await registry.archiveSession(sessionId, { stopActivity: true })
    else await registry.unarchiveSession(sessionId)
    if (entry.pinned && !entry.archived) await registry.pinSession?.(sessionId)
    else await registry.unpinSession?.(sessionId)
    if (entry.instructionSnapshot) {
      const inheritedFromSessionId = entry.parentOrigin ? this.localSessionIdForOrigin(entry.parentOrigin) : undefined
      const instructionWorkspaceId = entry.instructionSnapshot.workspaceOrigin
        ? this.localWorkspaceIdForOrigin(entry.instructionSnapshot.workspaceOrigin, entry.instructionSnapshot.workspaceRemotePath)
        : undefined
      const snapshot: SessionInstructionSnapshot = {
        sessionId,
        ...(instructionWorkspaceId ? { workspaceId: instructionWorkspaceId } : {}),
        ...(entry.instructionSnapshot.workspaceRevision === undefined ? {} : { workspaceRevision: entry.instructionSnapshot.workspaceRevision }),
        ...(entry.instructionSnapshot.digest === undefined ? {} : { digest: entry.instructionSnapshot.digest }),
        text: entry.instructionSnapshot.text,
        capturedAt: entry.instructionSnapshot.capturedAt,
        ...(inheritedFromSessionId ? { inheritedFromSessionId } : {}),
      }
      this.instructions.restore(snapshot)
    }
    this.state.observeRevision(entry.metadata.revision, this.now())
    const metadata: SyncRecordMetadata = {
      ...entry.metadata,
      localEntityId: current.localEntityId,
      importedVia,
      sourceName,
      stateDigest,
      deleted: false,
      pendingRemoval: false,
      workspaceOrigin: {
        originInstanceId: descriptor.originInstanceId,
        originEntityId: descriptor.originWorkspaceId,
      },
    }
    this.state.update((state) => { state.records[sessionOriginKey(metadata)] = metadata })
  }

  private async applyArchiveStateOnly(
    entry: SyncSessionEntry,
    current: SyncSessionArchive,
    workspace: WorkspaceLike,
  ): Promise<void> {
    const branchId = entry.branchId
    const descriptor = entry.workspace
    const stateDigest = entry.metadata.stateDigest
    if (!branchId || !descriptor || !stateDigest) {
      throw new SyncSessionError('manifest-invalid', 'archive state entry is incomplete')
    }
    const registry = this.getWorkspaces()
    if (!registry) throw new SyncSessionError('workspace-unavailable', '工作区注册表不可用')
    const sessionId = makeSessionId(current.localSessionId)
    const snapshot = await this.requirePersistence().stat(sessionId)
    if (!snapshot || normalizeHostPath(snapshot.header.cwd ?? '') !== normalizeHostPath(workspace.path)) {
      throw new SyncSessionError('session-workspace-mismatch', '归档 session 的本地 cwd 与目标 workspace 不一致')
    }
    await workspace.attachSession(sessionId)
    await registry.archiveSession(sessionId, { stopActivity: true })
    await registry.unpinSession?.(sessionId)
    this.state.observeRevision(entry.metadata.revision, this.now())
    this.state.update((state) => {
      state.archives[branchId] = {
        ...current,
        revision: entry.metadata.revision,
        stateDigest,
        workspacePosition: entry.workspacePosition ?? current.workspacePosition,
        workspaceId: workspace.id,
        workspaceOrigin: {
          originInstanceId: descriptor.originInstanceId,
          originEntityId: descriptor.originWorkspaceId,
        },
      }
    })
  }

  private async archiveCurrent(metadata: SyncRecordMetadata): Promise<string | undefined> {
    if (metadata.deleted || metadata.kind !== 'session') return undefined
    const branchId = branchIdFor(metadata)
    const state = this.state.read()
    if (state.archives[branchId]) return branchId
    const sessionId = makeSessionId(metadata.localEntityId)
    const persistence = this.requirePersistence()
    if (!(await persistence.stat(sessionId))) return undefined
    await persistence.flush()
    const registry = this.getWorkspaces()
    if (!registry) throw new SyncSessionError('workspace-unavailable', '工作区注册表不可用')
    const workspace = registry?.list().find((candidate) => candidate.sessionIds.some((id) => String(id) === String(sessionId)))
    const binding = workspace
      ? this.bindings.list().find((item) => normalizeHostPath(item.mirrorPath) === normalizeHostPath(workspace.path))
      : undefined
    const nodeOrigin = binding ? this.nodes.originForLocalNode(binding.nodeId) : undefined
    const descriptor = workspace && binding && nodeOrigin
      ? this.workspaceDescriptor(workspace, binding, nodeOrigin, metadata.workspaceOrigin)
      : undefined
    const workspacePosition = workspace?.sessionIds.findIndex((id) => String(id) === String(sessionId)) ?? 0
    await registry.archiveSession(sessionId, { stopActivity: true })
    await persistence.flush()
    this.state.update((draft) => {
      draft.archives[branchId] = {
        branchId,
        originInstanceId: metadata.originInstanceId,
        originSessionId: metadata.originEntityId,
        localSessionId: String(sessionId),
        revision: metadata.revision,
        contentDigest: metadata.contentDigest,
        stateDigest: descriptor ? sessionStateDigest(descriptor, Math.max(0, workspacePosition), true, false) : metadata.stateDigest ?? metadata.contentDigest,
        workspacePosition: Math.max(0, workspacePosition),
        ...(workspace ? { workspaceId: workspace.id } : {}),
        ...(descriptor ? { workspaceOrigin: { originInstanceId: descriptor.originInstanceId, originEntityId: descriptor.originWorkspaceId } } :
          metadata.workspaceOrigin ? { workspaceOrigin: metadata.workspaceOrigin } : {}),
        archivedAt: new Date(this.now()).toISOString(),
      }
    })
    return branchId
  }

  private async applyTombstone(metadata: SyncRecordMetadata): Promise<boolean> {
    const key = sessionOriginKey(metadata)
    const current = this.state.read().records[key]
    if (current) {
      const comparison = compareSyncRevision(metadata.revision, current.revision)
      if (comparison < 0) return false
      if (comparison === 0) {
        if (metadata.contentDigest !== current.contentDigest || !current.deleted) {
          throw new SyncSessionError('revision-conflict', 'Equal session revisions contain different tombstone state')
        }
        return false
      }
      if (!current.deleted) await this.archiveCurrent(current)
    }
    const localEntityId = current?.localEntityId ?? String(importedSessionId(metadata))
    const tombstone = { ...metadata, kind: 'session' as const, localEntityId, deleted: true }
    this.state.observeRevision(metadata.revision, this.now())
    this.state.update((state) => { state.records[key] = tombstone })
    return true
  }

  private async restoreArchiveNow(branchId: string): Promise<SessionId> {
    if (!/^b-[a-f0-9]{32}$/.test(branchId)) throw new SyncSessionError('archive-not-found', '会话归档不存在')
    const archive = this.state.read().archives[branchId]
    if (!archive) throw new SyncSessionError('archive-not-found', '会话归档不存在')
    const registry = this.getWorkspaces()
    const sessionId = makeSessionId(archive.localSessionId)
    const session = await this.requirePersistence().stat(sessionId)
    if (!registry || !session) throw new SyncSessionError('archive-not-found', '会话归档日志不存在')
    const key = syncRecordKey('session', { originInstanceId: archive.originInstanceId, originEntityId: archive.originSessionId })
    const current = this.state.read().records[key]
    if (current && !current.deleted && current.localEntityId !== archive.localSessionId) await this.archiveCurrent(current)
    await registry.unarchiveSession(sessionId)
    const revision = this.state.nextRevision(this.now())
    const restored: SyncRecordMetadata = {
      kind: 'session',
      originInstanceId: archive.originInstanceId,
      originEntityId: archive.originSessionId,
      localEntityId: archive.localSessionId,
      revision,
      contentDigest: archive.contentDigest,
      stateDigest: archive.stateDigest,
      importedVia: 'peer',
      ...(archive.workspaceOrigin ? { workspaceOrigin: archive.workspaceOrigin } : {}),
    }
    this.state.update((state) => {
      delete state.archives[branchId]
      state.records[key] = restored
    })
    return sessionId
  }

  private async orderWorkspaceSessions(orders: Map<string, Array<{ id: SessionId; position: number }>>): Promise<void> {
    const registry = this.getWorkspaces()
    if (!registry) return
    for (const [workspaceId, incoming] of orders) {
      const workspace = registry.get(workspaceId)
      if (!workspace) continue
      const current = [...workspace.sessionIds]
      const incomingIds = new Set(incoming.map((item) => String(item.id)))
      const desired = [...incoming]
        .sort((a, b) => a.position - b.position || String(a.id).localeCompare(String(b.id)))
        .map((item) => item.id)
        .filter((id, index, all) => current.some((existing) => String(existing) === String(id)) && all.findIndex((candidate) => String(candidate) === String(id)) === index)
      const target = [...desired, ...current.filter((id) => !incomingIds.has(String(id)))]
      if (target.length === current.length && target.every((id, index) => String(id) === String(current[index]))) continue
      let before: SessionId | undefined
      for (const id of target.reverse()) {
        await workspace.insertSessionBefore(id, before)
        before = id
      }
    }
  }

  private localSessionIdForOrigin(origin: SyncOrigin): SessionId | undefined {
    const state = this.state.read()
    const active = state.records[syncRecordKey('session', origin)]
    if (active && !active.deleted) return makeSessionId(active.localEntityId)
    const archive = Object.values(state.archives)
      .filter((entry) => entry.originInstanceId === origin.originInstanceId && entry.originSessionId === origin.originEntityId)
      .sort((a, b) => compareSyncRevision(b.revision, a.revision))[0]
    return archive ? makeSessionId(archive.localSessionId) : undefined
  }

  private localWorkspaceIdForOrigin(origin: SyncOrigin, remotePath?: string): string | undefined {
    const mappings = Object.values(this.state.read().workspaces).filter((mapping) =>
      mapping.originInstanceId === origin.originInstanceId && mapping.originWorkspaceId === origin.originEntityId &&
      (remotePath === undefined || mapping.remotePath === remotePath),
    )
    return mappings.length === 1 ? mappings[0]?.localWorkspaceId : undefined
  }

  private async writeSession(prepared: PreparedSyncSession): Promise<boolean> {
    const persistence = this.requirePersistence()
    const existed = await persistence.stat(prepared.localSessionId)
    const handle = existed
      ? await persistence.open(prepared.localSessionId, 'write')
      : await persistence.create(prepared.header, prepared.header.isSeeded ? { inheritedEventCount: prepared.inheritedEventCount } : undefined)
    try {
      if (canonicalJson(handle.header) !== canonicalJson(prepared.header) || handle.inheritedEventCount !== prepared.inheritedEventCount) {
        throw new SyncSessionError('session-id-conflict', '目标 session ID 已被其他 header 占用')
      }
      const existing: SessionEvent[] = []
      for (let offset = 0; ; ) {
        const page = await handle.read(offset, SESSION_READ_PAGE_SIZE)
        if (page.events.length === 0) break
        existing.push(...page.events)
        offset += page.events.length
        if (page.events.length < SESSION_READ_PAGE_SIZE) break
      }
      if (existing.length > prepared.events.length) throw new SyncSessionError('session-prefix-conflict', `目标 session ${prepared.localSessionId} 前缀比导入记录更长（本地 ${existing.length}，导入 ${prepared.events.length}）`)
      for (let index = 0; index < existing.length; index += 1) {
        if (canonicalJson(existing[index]) !== canonicalJson(prepared.events[index])) {
          throw new SyncSessionError('session-prefix-conflict', `目标 session ${prepared.localSessionId} 的已提交事件与导入前缀不同（首个差异位置 seq=${existing[index]?.seq}，本地 ${existing.length} 事件，导入 ${prepared.events.length} 事件）`)
        }
      }
      for (let offset = existing.length; offset < prepared.events.length; offset += SESSION_READ_PAGE_SIZE) {
        await handle.append(prepared.events.slice(offset, Math.min(offset + SESSION_READ_PAGE_SIZE, prepared.events.length)))
      }
      await handle.flush()
    } finally {
      await handle.close()
    }
    return existed !== undefined
  }

  private workspaceDescriptor(
    workspace: WorkspaceLike,
    binding: { mirrorPath: string; nodeId: string; remotePath: string; workspaceId?: string },
    nodeOrigin: SyncOrigin,
    preferredOrigin?: SyncOrigin,
    stateIndex = createSessionStateIndex(this.state.read()),
  ): SyncSessionWorkspace {
    const state = stateIndex.state
    const workspaceMappings = stateIndex.workspacesByLocalId.get(String(workspace.id)) ?? []
    const matchingMappings = workspaceMappings.filter((mapping) =>
      mapping.localNodeId === binding.nodeId &&
      posix.normalize(mapping.remotePath) === posix.normalize(binding.remotePath),
    )
    const preferredMapping = preferredOrigin
      ? workspaceMappings.find((mapping) =>
        mapping.originInstanceId === preferredOrigin.originInstanceId &&
        mapping.originWorkspaceId === preferredOrigin.originEntityId &&
        mapping.localNodeId === binding.nodeId,
      )
      : undefined
    const prior = preferredMapping ?? (matchingMappings.length === 1 ? matchingMappings[0] : undefined)
    const originInstanceId = preferredOrigin?.originInstanceId ?? prior?.originInstanceId ?? this.state.instanceId()
    const originWorkspaceId = preferredOrigin?.originEntityId ?? prior?.originWorkspaceId ?? workspace.id
    const base = { originInstanceId, originWorkspaceId, nodeOrigin, remotePath: posix.normalize(binding.remotePath), title: workspace.title }
    const digest = workspaceDigest(base)
    const key = syncWorkspaceKey(originInstanceId, originWorkspaceId, base.remotePath)
    const current = state.workspaces[key]
    const revision = current && current.contentDigest === digest ? current.revision : this.state.nextRevision(this.now())
    const mapping: SyncWorkspaceMapping = {
      originInstanceId,
      originWorkspaceId,
      localWorkspaceId: workspace.id,
      localPath: workspace.path,
      localNodeId: binding.nodeId,
      remotePath: base.remotePath,
      title: workspace.title,
      revision,
      contentDigest: digest,
    }
    if (!current || canonicalJson(current) !== canonicalJson(mapping)) {
      this.state.update((draft) => {
        draft.workspaces[key] = mapping
      })
      indexWorkspaceMapping(stateIndex, key, mapping)
    }
    return { ...base, revision, contentDigest: digest }
  }

  private async exportSessionEntry(
    persistence: SessionPersistenceLike,
    workspace: WorkspaceLike,
    descriptor: SyncSessionWorkspace,
    workspacePosition: number,
    sessionId: SessionId,
    firstSnapshot: SessionSnapshotLike,
    archived: boolean,
    pinned: boolean,
    archive?: SyncSessionArchive,
    stateIndex?: SessionStateIndex,
    objectCache?: ExportObjectCache,
    deferredObjects = false,
  ): Promise<SessionExportResult | undefined> {
    const { header, inheritedEventCount, events, revision: sourceRevision } = await this.readStableSession(persistence, sessionId, firstSnapshot)
    const localSessionId = String(sessionId)
    const cacheKey = sessionExportCacheKey(localSessionId)
    if (!header.cwd || posix.normalize(header.cwd) !== posix.normalize(workspace.path)) {
      this.exportCache.delete(cacheKey)
      this.exportCacheStore.delete(cacheKey)
      return undefined
    }
    const index = stateIndex ?? createSessionStateIndex(this.state.read())
    const state = index.state
    const parentMetadata = header.parentSession ? index.recordsByLocalId.get(String(header.parentSession)) : undefined
    const parentOrigin = parentMetadata
      ? { originInstanceId: parentMetadata.originInstanceId, originEntityId: parentMetadata.originEntityId }
      : undefined
    const syncInstructions = instructionsForSession(
      this.instructions,
      String(sessionId),
      index,
      { originInstanceId: descriptor.originInstanceId, originEntityId: descriptor.originWorkspaceId },
    )
    const eventDigest = sessionEventListDigest(events)
    const objects = await this.exportObjects(events, localSessionId, objectCache, deferredObjects)
    const digest = sessionEventDigest(
      header,
      inheritedEventCount,
      events,
      descriptor,
      syncInstructions,
      objects,
      parentOrigin,
    )
    const current = archive
      ? undefined
      : index.recordsByLocalId.get(localSessionId) ?? state.records[syncRecordKey('session', {
          originInstanceId: this.state.instanceId(),
          originEntityId: localSessionId,
        })]
    const originInstanceId = archive?.originInstanceId ?? current?.originInstanceId ?? this.state.instanceId()
    const originEntityId = archive?.originSessionId ?? current?.originEntityId ?? localSessionId
    const workspaceOrigin = { originInstanceId: descriptor.originInstanceId, originEntityId: descriptor.originWorkspaceId }
    const workspaceOriginChanged = Boolean(current?.workspaceOrigin &&
      (current.workspaceOrigin.originInstanceId !== workspaceOrigin.originInstanceId || current.workspaceOrigin.originEntityId !== workspaceOrigin.originEntityId))
    const stateDigest = sessionStateDigest(descriptor, workspacePosition, archived, pinned)
    const sessionStateChanged = Boolean(current && current.stateDigest !== stateDigest)
    let revision = archive?.revision ?? current?.revision
    let contentDigest = digest
    let outputBranchId = archive?.branchId
    if (archive) {
      if (archive.contentDigest !== digest || archive.stateDigest !== stateDigest) {
        const nextRevision = this.state.nextRevision(this.now())
        revision = nextRevision
        const contentChanged = archive.contentDigest !== digest
        const branchId = contentChanged
          ? branchIdFor({ originInstanceId, originEntityId, revision: nextRevision, contentDigest: digest } as SyncRecordMetadata)
          : archive.branchId
        const updatedArchive = {
          ...archive,
          branchId,
          revision: nextRevision,
          contentDigest: digest,
          stateDigest,
          workspacePosition,
          workspaceOrigin,
        }
        this.state.update((draft) => {
          delete draft.archives[archive.branchId]
          draft.archives[branchId] = updatedArchive
        })
        indexArchive(index, archive.branchId, updatedArchive)
        outputBranchId = branchId
      } else contentDigest = archive.contentDigest
    } else if (!current || current.contentDigest !== digest || current.deleted || workspaceOriginChanged || !current.workspaceOrigin || sessionStateChanged) {
      revision = this.state.nextRevision(this.now())
    }
    const metadata: SyncRecordMetadata = {
      kind: 'session',
      originInstanceId,
      originEntityId,
      localEntityId: localSessionId,
      revision: revision ?? this.state.nextRevision(this.now()),
      contentDigest,
      stateDigest,
      workspaceOrigin,
      ...(archive ? {} : current?.importedVia ? { importedVia: current.importedVia } : {}),
      ...(archive ? {} : current?.sourceName ? { sourceName: current.sourceName } : {}),
    }
    if (!archive && (!current || current.contentDigest !== digest || current.deleted || workspaceOriginChanged || !current.workspaceOrigin || sessionStateChanged)) {
      this.state.update((draft) => {
        draft.records[sessionOriginKey(metadata)] = metadata
      })
      indexSessionRecord(index, metadata)
    }
    const wireEntry: SyncSessionEntry = {
      metadata,
      ...(outputBranchId ? { branchId: outputBranchId } : {}),
      sourceLocalSessionId: localSessionId,
      header,
      inheritedEventCount,
      ...(parentOrigin ? { parentOrigin } : {}),
      workspace: descriptor,
      workspacePosition,
      archived,
      pinned,
      ...(syncInstructions ? { instructionSnapshot: syncInstructions } : {}),
      events: [...events],
      objects,
      eventCount: events.length,
      eventDigest,
    }
    // 单会话序列化体积硬闸：超过单条上限的会话无法装进任何一次分批传输
    // （接收端整包 JSON.parse 的对象图约为文本 5 倍，128MB 传输上限下单条
    // 留出信封余量）。抛 session-too-large，由导出循环记为 skipped——该会话
    // 不参与同步，其余会话照常，避免一个巨型会话让整次同步反复失败。
    // 必须在写导出缓存之前判定：缓存复用会绕过本函数的重新导出，若把超限
    // 会话写进缓存，manifest 会包含它而 entries 路径又产出 skipped，两端
    // 不一致会让整次同步以 session-manifest-stale 失败。
    if (Buffer.byteLength(JSON.stringify(wireEntry), 'utf8') > MAX_SESSION_EXPORT_ENTRY_BYTES) {
      this.exportCache.delete(cacheKey)
      this.exportCacheStore.delete(cacheKey)
      throw new SyncSessionError('session-too-large', '会话内容超过单会话传输上限')
    }
    // Spill payloads can change outside the session log revision.
    if (!archive && !objects.some((object) => object.kind === 'spill')) {
      const fingerprint = sessionExportFingerprint({
        revision: sourceRevision,
        header,
        inheritedEventCount,
        workspace: descriptor,
        instructionSnapshot: syncInstructions,
        parentOrigin,
      })
      if (fingerprint) {
        const entry: SessionExportCacheEntry = {
          fingerprint,
          metadata,
          eventCount: events.length,
          eventDigest,
          inheritedEventCount,
        }
        this.exportCache.set(cacheKey, entry)
        this.exportCacheStore.set(cacheKey, entry)
      } else {
        this.exportCache.delete(cacheKey)
        this.exportCacheStore.delete(cacheKey)
      }
    } else {
      this.exportCache.delete(cacheKey)
      this.exportCacheStore.delete(cacheKey)
    }
    return {
      entry: wireEntry,
      eventCount: events.length,
      eventDigest,
      inheritedEventCount,
    }
  }

  private async readStableSession(
    persistence: SessionPersistenceLike,
    sessionId: SessionId,
    firstSnapshot: SessionSnapshotLike,
  ): Promise<{ header: SessionHeader; inheritedEventCount: number; events: SessionEvent[]; revision: unknown }> {
    let snapshot = firstSnapshot
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (snapshot.formatStatus === 'migration-required') throw new SyncSessionError('session-format', '会话格式需要由当前 DSH 版本迁移')
      const handle = await persistence.open(sessionId, 'read')
      try {
        const events: SessionEvent[] = []
        let offset = 0
        for (;;) {
          const page = await handle.read(offset, SESSION_READ_PAGE_SIZE)
          if (page.events.length === 0) break
          events.push(...structuredClone(page.events))
          offset += page.events.length
          if (events.length > MAX_SYNC_SESSIONS * 100) throw new SyncSessionError('session-too-large', '会话事件数超过限制')
          if (page.events.length < SESSION_READ_PAGE_SIZE) break
        }
        const validated = validateStoredEvents(handle.header, events)
        assertContiguous(sessionId, validated, 0)
        const after = await persistence.stat(sessionId)
        if (!after) throw new SyncSessionError('session-missing', '会话在导出期间消失')
        if (
          canonicalJson(snapshot.revision) === canonicalJson(after.revision) &&
          canonicalJson(snapshot.header) === canonicalJson(after.header) &&
          canonicalJson(handle.header) === canonicalJson(after.header)
        ) {
          return {
            header: handle.header,
            inheritedEventCount: Number(handle.inheritedEventCount),
            events: [...validated],
            revision: after.revision,
          }
        }
        snapshot = after
      } finally {
        await handle.close()
      }
    }
    throw new SyncSessionError('session-changing', '会话在导出期间持续变化，请稍后重试')
  }

  private async exportObjects(
    events: readonly SessionEvent[],
    sessionId: string,
    objectCache?: ExportObjectCache,
    deferredObjects = false,
  ): Promise<SyncSessionObject[]> {
    const attachments = attachmentReferences(events)
    const spills = spillReferences(events)
    const structuredSpills = new Set(spills.map(spillKey))
    for (const reference of legacySpillReferences(events, sessionId)) {
      if (!structuredSpills.has(spillKey(reference))) spills.push(reference)
    }
    const payloads = new Map<string, SyncSessionObject>()
    const attachmentStore = (attachments.images.length + attachments.files.length) > 0 ? this.getAttachments() : undefined
    if ((attachments.images.length + attachments.files.length) > 0 && !attachmentStore) {
      throw new SyncSessionError('attachments-unavailable', '附件存储服务不可用')
    }
    const deferredDescriptor = (object: SyncSessionObject): SyncSessionObject =>
      ({ ...object, data: '', deferred: true }) as SyncSessionObject
    for (const ref of attachments.images) {
      const key = attachmentKey('image', ref)
      const cached = objectCache?.get(key)?.object
      if (cached?.kind === 'image' && canonicalJson(cached.ref) === canonicalJson(ref)) {
        payloads.set(key, cached)
        continue
      }
      const stored = await attachmentStore!.readImage(ref)
      const digest = sha256(stored.data)
      let object: SyncSessionObject = {
        id: key,
        kind: 'image',
        ref: stored.ref,
        bytes: stored.data.byteLength,
        digest,
        data: Buffer.from(stored.data).toString('base64'),
      }
      if (deferredObjects && object.bytes > MAX_SESSION_OBJECT_INLINE_BYTES) object = deferredDescriptor(object)
      payloads.set(key, object)
      objectCache?.set(key, { object })
    }
    for (const ref of attachments.files) {
      const key = attachmentKey('file', ref)
      const cached = objectCache?.get(key)?.object
      if (cached?.kind === 'file' && canonicalJson(cached.ref) === canonicalJson(ref)) {
        payloads.set(key, cached)
        continue
      }
      let data: Buffer | undefined
      // 收集上限按模式区分：deferred 模式超过内联阈值即转带外；旧路径保持
      // 128MB 上限（与 0.1.31 语义一致，超限走 session-too-large）。
      const inlineCap = deferredObjects ? MAX_SESSION_OBJECT_INLINE_BYTES : MAX_SYNC_TRANSFER_BYTES
      try {
        data = await collectBytes(attachmentStore!.readFileStream(ref), inlineCap)
      } catch (error) {
        if (!(error instanceof SyncSessionError && error.code === 'bundle-too-large')) throw error
        data = undefined
      }
      if (data === undefined) {
        // 超过内联阈值：对端声明带外流能力时记为 deferred 描述符（载荷走磁盘
        // 流式 RPC，内存 O(帧)，体积无实质上限）；旧对端回退原行为——抛
        // session-too-large 由导出循环把该会话记为 skipped。
        if (!deferredObjects) {
          throw new SyncSessionError('session-too-large', '会话文件附件超过传输大小限制')
        }
        const measured = await hashStream(attachmentStore!.readFileStream(ref), MAX_SESSION_OBJECT_STREAM_BYTES)
        const object: SyncSessionObject = {
          id: key,
          kind: 'file',
          ref,
          bytes: measured.bytes,
          digest: measured.digest,
          data: '',
          deferred: true,
        }
        payloads.set(key, object)
        objectCache?.set(key, { object })
        continue
      }
      const object: SyncSessionObject = {
        id: key,
        kind: 'file',
        ref,
        bytes: data.byteLength,
        digest: sha256(data),
        data: data.toString('base64'),
      }
      payloads.set(key, object)
      objectCache?.set(key, { object })
    }
    if (spills.length > 0) {
      const store = this.getSpills()
      const untransferred: SpillTransferReference[] = []
      for (const reference of spills) {
        if (!store) { untransferred.push(reference); continue }
        const key = spillKey(reference)
        const cached = objectCache?.get(key)?.object
        if (cached?.kind === 'spill' && canonicalJson(cached.reference) === canonicalJson(reference) &&
          (reference.ref.bytes === undefined || cached.bytes === reference.ref.bytes)) {
          payloads.set(key, cached)
          continue
        }
        try {
          let data: Buffer | undefined
          const inlineCap = deferredObjects ? MAX_SESSION_OBJECT_INLINE_BYTES : MAX_SYNC_TRANSFER_BYTES
          try {
            data = await collectBytes(readSpillStream(store, reference), inlineCap)
          } catch (error) {
            if (!(error instanceof SyncSessionError && error.code === 'bundle-too-large')) throw error
            data = undefined
          }
          if (data === undefined) {
            if (!deferredObjects) {
              untransferred.push(reference)
              continue
            }
            const measured = await hashStream(readSpillStream(store, reference), MAX_SESSION_OBJECT_STREAM_BYTES)
            if (reference.ref.bytes !== undefined && measured.bytes !== reference.ref.bytes) {
              untransferred.push(reference)
              continue
            }
            const object: SyncSessionObject = {
              id: key,
              kind: 'spill',
              reference,
              bytes: measured.bytes,
              digest: measured.digest,
              data: '',
              deferred: true,
            }
            payloads.set(key, object)
            objectCache?.set(key, { object })
            continue
          }
          if (reference.ref.bytes !== undefined && data.byteLength !== reference.ref.bytes) {
            untransferred.push(reference); continue
          }
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(data)
          } catch {
            untransferred.push(reference); continue
          }
          const object: SyncSessionObject = {
            id: key,
            kind: 'spill',
            reference,
            bytes: data.byteLength,
            digest: sha256(data),
            data: data.toString('base64'),
          }
          payloads.set(key, object)
          objectCache?.set(key, { object })
        } catch {
          untransferred.push(reference)
        }
      }
      for (const reference of untransferred) {
        const key = spillKey(reference)
        payloads.set(key, {
          id: key,
          kind: 'spill',
          reference,
          bytes: 0,
          digest: sha256(Buffer.alloc(0)),
          data: '',
          unavailable: true,
        })
      }
    }
    return [...payloads.values()]
  }

  private requirePersistence(): SessionPersistenceLike {
    const persistence = this.getPersistence()
    if (!persistence) throw new SyncSessionError('session-persistence-unavailable', '会话持久化服务不可用')
    return persistence
  }

  /**
   * 把 deferred 对象编码为带外帧流：每对象一行 JSON 头 + 原始字节。
   * 内容从本地存储流式读取（spill/文件流式；图片体积有限走缓冲），
   * 逐块校验字节数与摘要，内存 O(单块)。
   */
  async *streamObjects(objects: readonly SyncSessionObject[]): AsyncGenerator<Uint8Array> {
    for (const object of objects) {
      const header = Buffer.from(`${JSON.stringify({ id: object.id, bytes: object.bytes, digest: object.digest })}\n`, 'utf8')
      yield header
      if (object.deferred !== true) {
        const data = arrayBuffer(object.data)
        if (data.byteLength !== object.bytes || sha256(data) !== object.digest) {
          throw new SyncSessionError('object-integrity', 'session object failed digest validation')
        }
        yield data
        continue
      }
      const hash = createHash('sha256')
      let verified = 0
      const source = await this.openObjectContent(object)
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) throw new SyncSessionError('object-invalid', 'session object stream contains a non-byte chunk')
        verified += chunk.byteLength
        if (verified > object.bytes) throw new SyncSessionError('object-integrity', 'session object content exceeds declared bytes')
        hash.update(chunk)
        yield chunk
      }
      if (verified !== object.bytes || `sha256:${hash.digest('hex')}` !== object.digest) {
        throw new SyncSessionError('object-integrity', 'session object content failed digest validation')
      }
    }
  }

  private async openObjectContent(object: SyncSessionObject): Promise<AsyncIterable<Uint8Array>> {
    if (object.kind === 'spill') {
      const store = this.getSpills()
      if (!store) throw new SyncSessionError('spill-transfer-unavailable', '目标实例没有 owner-scoped spill transfer API')
      return readSpillStream(store, object.reference)
    }
    const attachments = this.getAttachments()
    if (!attachments) throw new SyncSessionError('attachments-unavailable', '附件存储服务不可用')
    if (object.kind === 'file') return attachments.readFileStream(object.ref)
    const stored = await attachments.readImage(object.ref)
    return oneChunk(stored.data)
  }

  /** 单帧写入上限：超过即认为流失控。 */
  private static readonly OBJECT_STREAM_HEADER_MAX_BYTES = 64 * 1024

  /**
   * 解析并落盘对端推送的对象帧流：逐帧写收件箱，边写边校验摘要，
   * 内存 O(单帧)。返回接收的对象数。
   */
  async ingestObjectStream(source: AsyncIterable<Uint8Array>): Promise<number> {
    let buffer = Buffer.alloc(0)
    const reader = source[Symbol.asyncIterator]()
    const nextChunk = async (): Promise<Buffer | undefined> => {
      const { value, done } = await reader.next()
      return done ? undefined : Buffer.from(value)
    }
    let count = 0
    for (;;) {
      let newline = buffer.indexOf(0x0a)
      while (newline < 0) {
        const chunk = await nextChunk()
        if (chunk === undefined) {
          if (buffer.length === 0) return count
          throw new SyncSessionError('object-invalid', 'object stream ended inside a header')
        }
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > SyncSessionService.OBJECT_STREAM_HEADER_MAX_BYTES) {
          throw new SyncSessionError('object-invalid', 'object stream header exceeds size limit')
        }
        newline = buffer.indexOf(0x0a)
      }
      const header = parseObjectStreamHeader(buffer.subarray(0, newline))
      buffer = buffer.subarray(newline + 1)
      const writer = await this.objectInbox.writerFor(header.digest, header.bytes)
      try {
        const writePart = async (part: Buffer): Promise<void> => {
          if (part.byteLength > 0) await writer.write(part)
        }
        let remaining = header.bytes
        for (;;) {
          if (buffer.length > 0) {
            const take = Math.min(buffer.length, remaining)
            await writePart(buffer.subarray(0, take))
            remaining -= take
            buffer = buffer.subarray(take)
            if (remaining === 0) break
            continue
          }
          const chunk = await nextChunk()
          if (chunk === undefined) throw new SyncSessionError('object-invalid', 'object stream ended inside a payload')
          const take = Math.min(chunk.length, remaining)
          await writePart(chunk.subarray(0, take))
          remaining -= take
          if (take < chunk.length) buffer = Buffer.concat([buffer, chunk.subarray(take)])
          if (remaining === 0) break
        }
        await writer.commit()
      } catch (error) {
        await writer.abort()
        throw error
      }
      count += 1
    }
  }

  /** apply 成功后删除已水合对象的收件箱文件；失败保留供 journal 回放。 */
  async deleteInboxedObjects(digests: Iterable<string>): Promise<void> {
    for (const digest of digests) {
      await this.objectInbox.delete(digest)
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}
