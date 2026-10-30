import { createHash } from 'node:crypto'
import { constants as fsConstants, mkdirSync } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize as normalizeHostPath, posix, resolve } from 'node:path'
import {
  SESSION_FORMAT_VERSION,
  SessionId as makeSessionId,
  snapshotSessionEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { assertContiguous, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { INSTRUCTION_MAX_BYTES, type SessionInstructionSnapshot } from '../workspace-instructions.js'
import { SessionInstructionSnapshotStore } from '../workspace-instructions.js'
import type { NodeRegistry, NodeType } from '../node-registry.js'
import type { WorkspaceBindingsStore } from '../workspace-bindings.js'
import { SyncNodeService } from './node-sync.js'
import { compareSyncRevision, HybridLogicalClock } from './revision.js'
import type { SyncRevision } from './revision.js'
import { isNonNegativeSafeInteger, isRecord, syncRecordKey, syncWorkspaceKey } from './model.js'
import type {
  SyncImportMethod,
  SyncOrigin,
  SyncRecordMetadata,
  SyncSessionArchive,
  SyncState,
  SyncWorkspaceMapping,
} from './model.js'
import { SyncStateStore } from './stores.js'
import { SyncSessionJournalStore } from './session-journal.js'
import { MAX_SYNC_TRANSFER_BYTES } from './protocol.js'

const SESSION_READ_PAGE_SIZE = 256
const MAX_SYNC_SESSIONS = 10_000
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

export type SyncSessionObject =
  | { id: string; kind: 'image'; ref: ImageAttachmentRef; bytes: number; digest: string; data: string }
  | { id: string; kind: 'file'; ref: FileAttachmentRef; bytes: number; digest: string; data: string }
  | {
      id: string
      kind: 'spill'
      reference: SpillTransferReference
      bytes: number
      digest: string
      data: string
      unavailable?: boolean
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
}

export interface SyncSessionBundle {
  protocolVersion: 1
  instanceId: string
  entries: SyncSessionEntry[]
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
    data: Buffer
  },
): Promise<SpillTransferReference['ref']> {
  if (store.saveTextStream) {
    return store.saveTextStream({
      owner: input.owner,
      source: input.source,
      suggestedName: input.suggestedName,
      transferId: input.transferId,
      bytes: input.bytes,
      digest: input.digest,
      content: oneChunk(input.data),
    })
  }
  if (typeof store.root === 'string') return writeLocalSpillTransfer(store.root, input)
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
  return sha256(canonicalJson({
    header: stableHeader,
    inheritedEventCount,
    events: events.map(normalize),
    workspace: {
      originInstanceId: workspace.originInstanceId,
      originWorkspaceId: workspace.originWorkspaceId,
      nodeOrigin: workspace.nodeOrigin,
      remotePath: workspace.remotePath,
    },
    parentOrigin,
    instructionSnapshot: instructionSnapshot ? {
      text: instructionSnapshot.text,
      capturedAt: instructionSnapshot.capturedAt,
      workspaceOrigin: instructionSnapshot.workspaceOrigin,
      workspaceRemotePath: instructionSnapshot.workspaceRemotePath,
      workspaceRevision: instructionSnapshot.workspaceRevision,
      digest: instructionSnapshot.digest,
      inheritedFromOrigin: instructionSnapshot.inheritedFromOrigin,
    } : undefined,
  }))
}

function sessionStateDigest(
  workspace: SyncSessionWorkspace,
  workspacePosition: number,
  archived: boolean,
  pinned: boolean,
): string {
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
    workspacePosition,
    archived,
    pinned,
  }))
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

async function* oneChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data
}

function findSessionRecordByLocalId(state: SyncState, localSessionId: string): SyncRecordMetadata | undefined {
  return Object.values(state.records)
    .filter((metadata) => metadata.kind === 'session' && metadata.localEntityId === localSessionId)
    .sort((a, b) => compareSyncRevision(b.revision, a.revision))[0]
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

function validateObjectPayload(object: unknown): SyncSessionObject {
  if (!isRecord(object) || typeof object.id !== 'string' || !object.id || typeof object.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(object.digest) || !isNonNegativeSafeInteger(object.bytes) || typeof object.data !== 'string') {
    throw new SyncSessionError('object-invalid', 'session object metadata is invalid')
  }
  const isUnavailableSpill = object.kind === 'spill' && object.unavailable === true && object.bytes === 0 && object.data === ''
  if (!isUnavailableSpill) {
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
  if (entry.branchId !== undefined && (typeof entry.branchId !== 'string' || !/^b-[a-f0-9]{32}$/.test(entry.branchId))) {
    throw new SyncSessionError('manifest-invalid', 'session branch ID is invalid')
  }
  if (metadata.workspaceOrigin !== undefined) validateOrigin(metadata.workspaceOrigin)
  if (metadata.deleted) {
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
  if (entry.events.length > MAX_SYNC_SESSIONS * 100) throw new SyncSessionError('manifest-invalid', 'session event count exceeds limit')
  const header = entry.header as unknown as SessionHeader
  if (header.version !== SESSION_FORMAT_VERSION || header.id !== entry.sourceLocalSessionId) {
    throw new SyncSessionError('session-format', 'session header format or id is invalid')
  }
  const events = validateStoredEvents(header, structuredClone(entry.events) as SessionEvent[])
  assertContiguous(header.id, events, 0)
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
  if ([...referencedObjects].some((id) => !objectIds.has(id)) || [...objectIds].some((id) => !referencedObjects.has(id))) {
    throw new SyncSessionError('manifest-invalid', 'session object references and payloads do not match')
  }
  const parentOrigin = entry.parentOrigin === undefined ? undefined : validateOrigin(entry.parentOrigin)
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
  }
}

function bundleDigest(bundle: Pick<SyncSessionBundle, 'instanceId' | 'entries' | 'skipped'>): string {
  const manifest = bundle.entries.map((entry) => ({
    key: entry.branchId ?? sessionOriginKey(entry.metadata),
    revision: entry.metadata.revision,
    contentDigest: entry.metadata.contentDigest,
    stateDigest: entry.metadata.stateDigest,
    deleted: Boolean(entry.metadata.deleted),
    objects: (entry.objects ?? []).map((object) => ({ id: object.id, digest: object.digest, bytes: object.bytes }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const skipped = bundle.skipped.map((entry) => ({ sessionId: entry.sessionId, reason: entry.reason }))
    .sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
  return sha256(canonicalJson({ instanceId: bundle.instanceId, entries: manifest, skipped }))
}

export function validateSyncSessionBundle(value: unknown): SyncSessionBundle {
  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.instanceId !== 'string' ||
    !/^i-[a-f0-9]{32}$/.test(value.instanceId) || !Array.isArray(value.entries) || typeof value.digest !== 'string') {
    throw new SyncSessionError('manifest-invalid', 'session bundle header is invalid')
  }
  const skipped = value.skipped === undefined ? [] : value.skipped
  if (!Array.isArray(skipped) || skipped.some((item) =>
    !isRecord(item) || typeof item.sessionId !== 'string' || typeof item.reason !== 'string'
  )) throw new SyncSessionError('manifest-invalid', 'session bundle skip report is invalid')
  if (value.entries.length > MAX_SYNC_SESSIONS) throw new SyncSessionError('manifest-invalid', 'session bundle contains too many records')
  const entries = value.entries.map(validateEntry)
  const keys = entries.map((entry) => entry.branchId ?? sessionOriginKey(entry.metadata))
  if (new Set(keys).size !== keys.length) throw new SyncSessionError('manifest-invalid', 'session bundle contains duplicate records')
  const bundle: SyncSessionBundle = { protocolVersion: 1, instanceId: value.instanceId, entries, skipped: skipped as Array<{ sessionId: string; reason: string }>, digest: value.digest }
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
): SyncSessionBundle {
  const bundle: SyncSessionBundle = { protocolVersion: 1, instanceId, entries, skipped, digest: '' }
  bundle.digest = bundleDigest(bundle)
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_SYNC_TRANSFER_BYTES) {
    throw new SyncSessionError('bundle-too-large', 'session bundle exceeds the transfer limit')
  }
  return bundle
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
  state: SyncState,
  preferredWorkspaceOrigin?: SyncOrigin,
): SyncSessionInstructionSnapshot | undefined {
  const snapshot = store.get(sessionId)
  if (!snapshot) return undefined
  const workspaceMappings = snapshot.workspaceId
    ? Object.values(state.workspaces).filter((mapping) => mapping.localWorkspaceId === snapshot.workspaceId)
    : []
  const workspaceMapping = preferredWorkspaceOrigin
    ? workspaceMappings.find((mapping) => mapping.originInstanceId === preferredWorkspaceOrigin.originInstanceId &&
      mapping.originWorkspaceId === preferredWorkspaceOrigin.originEntityId) ??
      (workspaceMappings.length === 1 ? workspaceMappings[0] : undefined)
    : workspaceMappings.length === 1 ? workspaceMappings[0] : undefined
  const inheritedFromOrigin = snapshot.inheritedFromSessionId
    ? findSessionOriginByLocalId(state, snapshot.inheritedFromSessionId)
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
  ) {}

  exportBundle(): Promise<SyncSessionBundle> {
    return this.serializeMutation(() => this.exportBundleNow())
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

  restoreArchive(branchId: string): Promise<SessionId> {
    return this.serializeMutation(() => this.restoreArchiveNow(branchId))
  }

  private async exportBundleNow(): Promise<SyncSessionBundle> {
    const persistence = this.requirePersistence()
    const workspaceRegistry = this.getWorkspaces()
    if (!workspaceRegistry) throw new SyncSessionError('workspace-unavailable', '工作区注册表不可用')
    await persistence.flush()

    const instanceId = this.state.instanceId()
    const bindings = this.bindings.list()
    const workspaces = workspaceRegistry.list()
    const archivedIds = new Set(workspaceRegistry.archivedSessionIds.map(String))
    const pinnedIds = new Set((workspaceRegistry.pinnedSessionIds ?? []).map(String))
    const entries: SyncSessionEntry[] = []
    const skipped: Array<{ sessionId: string; reason: string }> = []
    const eligibleLocalIds = new Set<string>()
    const workspaceById = new Map<string, WorkspaceLike>()
    const archivedBranchSessionIds = new Set(Object.values(this.state.read().archives).map((archive) => archive.localSessionId))

    for (const workspace of workspaces) {
      workspaceById.set(String(workspace.id), workspace)
      const binding = bindings.find((candidate) => normalizeHostPath(candidate.mirrorPath) === workspaceCandidateKey(workspace))
      if (!binding) continue
      const node = this.registry.get(binding.nodeId)
      if (!node || !isNodeRemoteType(node.type)) continue
      const nodeOrigin = this.nodes.originForLocalNode(node.id)
      if (!nodeOrigin) continue

      for (let position = 0; position < workspace.sessionIds.length; position += 1) {
        const sessionId = String(workspace.sessionIds[position])
        if (archivedBranchSessionIds.has(sessionId)) continue
        const currentSession = findSessionRecordByLocalId(this.state.read(), sessionId)
        if (currentSession?.deleted) continue
        const descriptor = this.workspaceDescriptor(workspace, binding, nodeOrigin, currentSession?.workspaceOrigin)
        const snapshot = await persistence.stat(makeSessionId(sessionId))
        if (!snapshot) continue
        if (snapshot.formatStatus === 'migration-required') {
          throw new SyncSessionError('session-format', '会话格式需要由当前 DSH 版本迁移')
        }
        const entry = await this.exportSessionEntry(
          persistence,
          workspace,
          descriptor,
          position,
          makeSessionId(sessionId),
          snapshot,
          archivedIds.has(sessionId),
          pinnedIds.has(sessionId),
        )
        if (entry) {
          entries.push(entry)
          eligibleLocalIds.add(sessionId)
        } else skipped.push({ sessionId, reason: 'workspace-cwd-mismatch' })
      }
    }

    const initial = this.state.read()
    for (const metadata of Object.values(initial.records)) {
      if (
        metadata.kind !== 'session' || archivedBranchSessionIds.has(metadata.localEntityId)
      ) continue
      if (metadata.deleted) {
        entries.push({ metadata })
        continue
      }
      if (eligibleLocalIds.has(metadata.localEntityId)) continue
      const tombstone: SyncRecordMetadata = {
        ...metadata,
        revision: this.state.nextRevision(this.now()),
        contentDigest: tombstoneDigest(metadata),
        deleted: true,
      }
      this.state.update((state) => {
        state.records[sessionOriginKey(metadata)] = tombstone
      })
      entries.push({ metadata: tombstone })
    }

    for (const archive of this.listArchives()) {
      const workspace = archive.workspaceId ? workspaceById.get(archive.workspaceId) : undefined
      if (!workspace) continue
      const binding = bindings.find((candidate) => normalizeHostPath(candidate.mirrorPath) === workspaceCandidateKey(workspace))
      const node = binding ? this.registry.get(binding.nodeId) : undefined
      if (!binding || !node || !isNodeRemoteType(node.type)) continue
      const nodeOrigin = this.nodes.originForLocalNode(node.id)
      if (!nodeOrigin) continue
      const archivedMetadata = Object.values(this.state.read().archives).find((item) => item.localSessionId === archive.localSessionId)
      const descriptor = this.workspaceDescriptor(workspace, binding, nodeOrigin, archivedMetadata?.workspaceOrigin)
      const snapshot = await persistence.stat(makeSessionId(archive.localSessionId))
      if (!snapshot) continue
      const entry = await this.exportSessionEntry(
        persistence,
        workspace,
        descriptor,
        archive.workspacePosition,
        makeSessionId(archive.localSessionId),
        snapshot,
        true,
        false,
        archive,
      )
      if (entry) entries.push(entry)
      else skipped.push({ sessionId: archive.localSessionId, reason: 'archive-workspace-cwd-mismatch' })
    }

    return makeSyncSessionBundle(instanceId, entries, skipped)
  }

  private async applyBundleNow(
    value: unknown,
    sourceName: string,
    peerId: string,
    options: SyncSessionApplyOptions,
    recoveryBatch?: SyncSessionJournalBatch,
  ): Promise<SyncSessionApplyResult> {
    const bundle = validateSyncSessionBundle(value)
    const pendingBatch = recoveryBatch ?? this.journal.findBatch(peerId, bundle.digest)
    if (pendingBatch && (pendingBatch.bundleDigest !== bundle.digest || pendingBatch.peerId !== peerId)) {
      throw new SyncSessionError('journal-bundle-mismatch', '会话 journal batch 与 bundle 不匹配')
    }
    const importedVia = pendingBatch?.importedVia ?? options.importedVia ?? 'peer'
    const allowSameInstance = pendingBatch?.allowSameInstance ?? options.allowSameInstance ?? false
    const localInstanceId = this.state.instanceId()
    if (bundle.instanceId === localInstanceId && !allowSameInstance) {
      throw new SyncSessionError('same-instance', 'cannot import sessions from this instance')
    }
    if (!pendingBatch) await this.exportBundleNow()
    this.preflightBundle(bundle, { importedVia, allowSameInstance })
    const safeSourceName = (pendingBatch?.sourceName ?? sourceName).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128) || 'sync peer'
    const recordKeys = bundle.entries.map((entry) => entry.branchId ?? sessionOriginKey(entry.metadata))
    const batchId = pendingBatch?.batchId ?? this.journal.beginWithBundle(
      peerId,
      safeSourceName,
      bundle.digest,
      recordKeys,
      bundle,
      new Date(this.now()).toISOString(),
      importedVia,
      allowSameInstance,
    )
    const result = emptyApplyResult()
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
            await this.applyMembershipOnly(entry, current, safeSourceName, entryWorkspace, importedVia)
            result.updated += 1
            queueWorkspaceOrder(entryWorkspace.id, makeSessionId(current.localEntityId), entry.workspacePosition ?? 0)
            continue
          }
        }

        let preparedValue = this.journal.readPrepared(batchId, key)
        let prepared: PreparedSyncSession
        if (preparedValue === undefined) {
          try {
            prepared = await this.prepareEntry(entry, safeSourceName, plannedSessionIds, entryWorkspace, importedVia)
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
      return result
    } catch (error) {
      if (error instanceof SyncSessionError) throw error
      throw new SyncSessionError('session-apply-failed', '会话同步应用失败', error)
    }
  }

  private async prepareEntry(
    entry: SyncSessionEntry,
    sourceName: string,
    plannedSessionIds: ReadonlyMap<string, SessionId>,
    workspace: WorkspaceLike,
    importedVia: SyncImportMethod,
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
    const objectMap = await this.importObjects(entry.objects, sessionId)
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

  private async importObjects(objects: readonly SyncSessionObject[], sessionId: SessionId): Promise<Map<string, ImportedSessionObjectRef>> {
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
      } else if (object.kind === 'file') {
        const ref = await attachments!.saveFileStream({
          data: oneChunk(data),
          name: object.ref.name,
        })
        output.set(object.id, ref)
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

    if (prepared.instructionSnapshot) this.instructions.restore(prepared.instructionSnapshot)
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
  ): SyncSessionWorkspace {
    const state = this.state.read()
    const matchingMappings = Object.values(state.workspaces).filter((mapping) =>
      mapping.localWorkspaceId === workspace.id && mapping.localNodeId === binding.nodeId &&
      posix.normalize(mapping.remotePath) === posix.normalize(binding.remotePath),
    )
    const preferredMapping = preferredOrigin
      ? Object.values(state.workspaces).find((mapping) =>
        mapping.originInstanceId === preferredOrigin.originInstanceId &&
        mapping.originWorkspaceId === preferredOrigin.originEntityId &&
        mapping.localWorkspaceId === workspace.id && mapping.localNodeId === binding.nodeId,
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
      ...base,
      localWorkspaceId: workspace.id,
      localPath: workspace.path,
      localNodeId: binding.nodeId,
      revision,
      contentDigest: digest,
    }
    this.state.update((draft) => {
      draft.workspaces[key] = mapping
    })
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
  ): Promise<SyncSessionEntry | undefined> {
    const { header, inheritedEventCount, events } = await this.readStableSession(persistence, sessionId, firstSnapshot)
    if (!header.cwd || posix.normalize(header.cwd) !== posix.normalize(workspace.path)) return undefined
    const localSessionId = String(sessionId)
    const state = this.state.read()
    const parentOrigin = header.parentSession ? findSessionOriginByLocalId(state, String(header.parentSession)) : undefined
    const syncInstructions = instructionsForSession(
      this.instructions,
      String(sessionId),
      state,
      { originInstanceId: descriptor.originInstanceId, originEntityId: descriptor.originWorkspaceId },
    )
    const objects = await this.exportObjects(events, localSessionId)
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
      : findSessionRecordByLocalId(state, localSessionId) ?? state.records[syncRecordKey('session', {
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
      if (archive.contentDigest !== digest || archive.stateDigest !== stateDigest || archive.workspacePosition !== workspacePosition) {
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
    }
    return {
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
    }
  }

  private async readStableSession(
    persistence: SessionPersistenceLike,
    sessionId: SessionId,
    firstSnapshot: SessionSnapshotLike,
  ): Promise<{ header: SessionHeader; inheritedEventCount: number; events: SessionEvent[] }> {
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
        if (JSON.stringify(snapshot.revision) === JSON.stringify(after.revision)) {
          return {
            header: handle.header,
            inheritedEventCount: Number(handle.inheritedEventCount),
            events: [...validated],
          }
        }
        snapshot = after
      } finally {
        await handle.close()
      }
    }
    throw new SyncSessionError('session-changing', '会话在导出期间持续变化，请稍后重试')
  }

  private async exportObjects(events: readonly SessionEvent[], sessionId: string): Promise<SyncSessionObject[]> {
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
    for (const ref of attachments.images) {
      const stored = await attachmentStore!.readImage(ref)
      const digest = sha256(stored.data)
      payloads.set(attachmentKey('image', ref), {
        id: attachmentKey('image', ref),
        kind: 'image',
        ref: stored.ref,
        bytes: stored.data.byteLength,
        digest,
        data: Buffer.from(stored.data).toString('base64'),
      })
    }
    for (const ref of attachments.files) {
      const data = await collectBytes(attachmentStore!.readFileStream(ref))
      payloads.set(attachmentKey('file', ref), {
        id: attachmentKey('file', ref),
        kind: 'file',
        ref,
        bytes: data.byteLength,
        digest: sha256(data),
        data: data.toString('base64'),
      })
    }
    if (spills.length > 0) {
      const store = this.getSpills()
      const untransferred: SpillTransferReference[] = []
      for (const reference of spills) {
        if (!store) { untransferred.push(reference); continue }
        try {
          const data = await collectBytes(readSpillStream(store, reference))
          if (reference.ref.bytes !== undefined && data.byteLength !== reference.ref.bytes) {
            untransferred.push(reference); continue
          }
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(data)
          } catch {
            untransferred.push(reference); continue
          }
          const key = spillKey(reference)
          payloads.set(key, {
            id: key,
            kind: 'spill',
            reference,
            bytes: data.byteLength,
            digest: sha256(data),
            data: data.toString('base64'),
          })
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

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}
