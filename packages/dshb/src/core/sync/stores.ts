import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix } from 'node:path'
import { HybridLogicalClock, type HlcSnapshot, type SyncRevision } from './revision.js'
import {
  isNonNegativeSafeInteger,
  isRecord,
  parseSyncPeer,
  syncRecordKey,
  syncWorkspaceKey,
  type SyncPeer,
  type SyncPeerDraft,
  type SyncPeerProgress,
  type SyncRecordMetadata,
  type SyncSessionArchive,
  type SyncState,
  type SyncWorkspaceMapping,
} from './model.js'

function dshHome(home?: string): string {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function readJson<T>(file: string, validate: (value: unknown) => T): T | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error(`Invalid JSON in ${basename(file)}`)
  }
  return validate(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function instanceIdFile(home: string): string {
  return join(home, 'dshb', 'instance-id')
}

function parseInstanceId(value: string): string {
  const id = value.trim()
  if (!/^i-[a-f0-9]{32}$/.test(id)) throw new Error('Invalid DSHB sync instance ID')
  return id
}

export function getOrCreateSyncInstanceId(home?: string): string {
  const root = dshHome(home)
  const file = instanceIdFile(root)
  try {
    return parseInstanceId(readFileSync(file, 'utf8'))
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
  }

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const candidate = `i-${randomBytes(16).toString('hex')}`
  let fd: number | undefined
  try {
    fd = openSync(file, 'wx', 0o600)
    writeFileSync(fd, `${candidate}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    chmodSync(file, 0o600)
    return candidate
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (isNodeError(error) && error.code === 'EEXIST') {
      return parseInstanceId(readFileSync(file, 'utf8'))
    }
    throw error
  }
}

function newPeerId(): string {
  return `p-${randomBytes(12).toString('hex')}`
}

function validatePeers(value: unknown): SyncPeer[] {
  if (!Array.isArray(value)) throw new Error('Invalid sync peer store')
  const peers = value.map(parseSyncPeer)
  if (new Set(peers.map((peer) => peer.id)).size !== peers.length) {
    throw new Error('Sync peer store contains duplicate IDs')
  }
  return peers
}

export class SyncPeerStore {
  private peers: SyncPeer[] | undefined
  private readonly filePath: string

  constructor(home?: string) {
    this.filePath = join(dshHome(home), 'dshb', 'sync-peers.json')
  }

  list(): SyncPeer[] {
    return clone(this.load())
  }

  get(id: string): SyncPeer | undefined {
    const peer = this.load().find((item) => item.id === id)
    return peer ? clone(peer) : undefined
  }

  create(draft: SyncPeerDraft): SyncPeer {
    const peer = parseSyncPeer({ ...draft, id: newPeerId() })
    const next = [...this.load(), peer]
    this.save(next)
    return clone(peer)
  }

  update(id: string, patch: Partial<Omit<SyncPeer, 'id'>>): SyncPeer {
    const current = this.load()
    const index = current.findIndex((peer) => peer.id === id)
    if (index < 0) throw new Error(`sync peer ${id} not found`)
    const updated = parseSyncPeer({ ...current[index], ...patch, id })
    const next = [...current]
    next[index] = updated
    this.save(next)
    return clone(updated)
  }

  remove(id: string): boolean {
    const current = this.load()
    const next = current.filter((peer) => peer.id !== id)
    if (next.length === current.length) return false
    this.save(next)
    return true
  }

  private load(): SyncPeer[] {
    if (this.peers) return this.peers
    const stored = readJson(this.filePath, validatePeers)
    this.peers = stored ?? []
    return this.peers
  }

  private save(peers: SyncPeer[]): void {
    atomicWrite(this.filePath, `${JSON.stringify(peers, null, 2)}\n`)
    this.peers = peers
  }
}

function validateProgress(value: unknown): SyncPeerProgress {
  if (!isRecord(value)) throw new Error('Invalid peer sync progress')
  const progress: SyncPeerProgress = {}
  for (const field of ['lastRunAt', 'lastSuccessAt', 'lastManifestDigest', 'watermark', 'lastErrorCode', 'lastErrorMessage'] as const) {
    const entry = value[field]
    if (entry !== undefined) {
      if (
        typeof entry !== 'string' || !entry ||
        entry.length > (field === 'lastErrorMessage' ? 256 : 512) ||
        /[\u0000-\u001f\u007f]/.test(entry)
      ) {
        throw new Error(`Invalid peer sync progress field: ${field}`)
      }
      progress[field] = entry
    }
  }
  if (value.lastRunStatus !== undefined) {
    if (value.lastRunStatus !== 'running' && value.lastRunStatus !== 'succeeded' && value.lastRunStatus !== 'failed') {
      throw new Error('Invalid peer sync run status')
    }
    progress.lastRunStatus = value.lastRunStatus
  }
  if (value.lastResult !== undefined) {
    if (!isRecord(value.lastResult)) throw new Error('Invalid peer sync run result')
    const counts = ['imported', 'exported', 'skipped', 'pendingRemoval'] as const
    for (const field of counts) {
      if (!isNonNegativeSafeInteger(value.lastResult[field])) throw new Error(`Invalid peer sync result field: ${field}`)
    }
    const sessionCounts = ['importedSessions', 'exportedSessions', 'skippedSessions'] as const
    for (const field of sessionCounts) {
      if (value.lastResult[field] !== undefined && !isNonNegativeSafeInteger(value.lastResult[field])) {
        throw new Error(`Invalid peer sync result field: ${field}`)
      }
    }
    progress.lastResult = {
      imported: value.lastResult.imported as number,
      exported: value.lastResult.exported as number,
      skipped: value.lastResult.skipped as number,
      pendingRemoval: value.lastResult.pendingRemoval as number,
      importedSessions: (value.lastResult.importedSessions as number | undefined) ?? 0,
      exportedSessions: (value.lastResult.exportedSessions as number | undefined) ?? 0,
      skippedSessions: (value.lastResult.skippedSessions as number | undefined) ?? 0,
    }
  }
  return progress
}

function validateRevision(value: unknown, label: string): SyncRevision {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.physicalTimeMs) ||
    !isNonNegativeSafeInteger(value.logicalCounter) ||
    typeof value.writerInstanceId !== 'string' ||
    !value.writerInstanceId ||
    /[\u0000-\u001f\u007f]/.test(value.writerInstanceId)
  ) {
    throw new Error(`Invalid ${label} revision`)
  }
  return {
    physicalTimeMs: value.physicalTimeMs,
    logicalCounter: value.logicalCounter,
    writerInstanceId: value.writerInstanceId,
  }
}

function validateRecord(value: unknown): SyncRecordMetadata {
  if (!isRecord(value)) throw new Error('Invalid sync record metadata')
  if (value.kind !== 'node' && value.kind !== 'session') throw new Error('Invalid sync entity kind')
  const requiredText = ['originInstanceId', 'originEntityId', 'localEntityId', 'contentDigest'] as const
  for (const key of requiredText) {
    if (
      typeof value[key] !== 'string' ||
      !(value[key] as string).trim() ||
      (value[key] as string).length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value[key] as string)
    ) {
      throw new Error(`Invalid sync record field: ${key}`)
    }
  }
  if (value.stateDigest !== undefined && (typeof value.stateDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.stateDigest))) {
    throw new Error('Invalid sync record state digest')
  }
  validateRevision(value.revision, 'sync record')
  if (value.deleted !== undefined && typeof value.deleted !== 'boolean') throw new Error('Invalid sync tombstone')
  if (value.pendingRemoval !== undefined && typeof value.pendingRemoval !== 'boolean') {
    throw new Error('Invalid pending removal state')
  }
  if (value.credentialsRequired !== undefined && typeof value.credentialsRequired !== 'boolean') {
    throw new Error('Invalid sync credential requirement state')
  }
  if (value.workspaceOrigin !== undefined) {
    if (!isRecord(value.workspaceOrigin)) throw new Error('Invalid sync workspace origin')
    validateOrigin(value.workspaceOrigin)
  }
  if (value.importedVia !== undefined && value.importedVia !== 'peer' && value.importedVia !== 'offline') {
    throw new Error('Invalid sync import method')
  }
  if (
    value.sourceName !== undefined &&
    (typeof value.sourceName !== 'string' || value.sourceName.length > 256 || /[\u0000-\u001f\u007f]/.test(value.sourceName))
  ) {
    throw new Error('Invalid sync source name')
  }
  return clone(value) as unknown as SyncRecordMetadata
}

function validateWorkspaceMapping(value: unknown): SyncWorkspaceMapping {
  if (!isRecord(value)) throw new Error('Invalid sync workspace mapping')
  const originInstanceId = requiredString(value.originInstanceId, 'workspace origin instance ID', 128)
  const originWorkspaceId = requiredString(value.originWorkspaceId, 'workspace origin ID', 256)
  const localWorkspaceId = requiredString(value.localWorkspaceId, 'local workspace ID', 256)
  const localPath = requiredString(value.localPath, 'local workspace path', 4096)
  const localNodeId = requiredString(value.localNodeId, 'local workspace node ID', 128)
  const remotePath = requiredString(value.remotePath, 'workspace remote path', 4096)
  const title = requiredString(value.title, 'workspace title', 256)
  if (!posix.isAbsolute(remotePath) || posix.normalize(remotePath) !== remotePath || remotePath.split('/').includes('..')) {
    throw new Error('Invalid workspace remote path')
  }
  const contentDigest = requiredString(value.contentDigest, 'workspace content digest', 256)
  if (!/^sha256:[a-f0-9]{64}$/.test(contentDigest)) throw new Error('Invalid workspace content digest')
  return {
    originInstanceId,
    originWorkspaceId,
    localWorkspaceId,
    localPath,
    localNodeId,
    remotePath,
    title,
    revision: validateRevision(value.revision, 'workspace'),
    contentDigest,
  }
}

function validateArchive(value: unknown, branchId: string): SyncSessionArchive {
  if (!isRecord(value) || value.branchId !== branchId || !/^b-[a-f0-9]{32}$/.test(branchId)) {
    throw new Error('Invalid sync session archive')
  }
  const contentDigest = requiredString(value.contentDigest, 'archive content digest', 256)
  const stateDigest = value.stateDigest === undefined
    ? contentDigest
    : requiredString(value.stateDigest, 'archive state digest', 256)
  const workspacePosition = value.workspacePosition === undefined ? 0 : value.workspacePosition
  if (!/^sha256:[a-f0-9]{64}$/.test(contentDigest) || !/^sha256:[a-f0-9]{64}$/.test(stateDigest) ||
    !isNonNegativeSafeInteger(workspacePosition)) throw new Error('Invalid sync session archive digest or order')
  return {
    branchId,
    originInstanceId: requiredString(value.originInstanceId, 'archive origin instance ID', 128),
    originSessionId: requiredString(value.originSessionId, 'archive origin session ID', 256),
    localSessionId: requiredString(value.localSessionId, 'archive local session ID', 256),
    revision: validateRevision(value.revision, 'archive'),
    contentDigest,
    stateDigest,
    workspacePosition,
    ...(value.workspaceId === undefined ? {} : { workspaceId: requiredString(value.workspaceId, 'archive workspace ID', 256) }),
    ...(value.workspaceOrigin === undefined ? {} : { workspaceOrigin: validateOrigin(value.workspaceOrigin) }),
    archivedAt: requiredString(value.archivedAt, 'archive timestamp', 64),
  }
}

function validateOrigin(value: unknown): { originInstanceId: string; originEntityId: string } {
  if (
    !isRecord(value) || typeof value.originInstanceId !== 'string' || !value.originInstanceId ||
    typeof value.originEntityId !== 'string' || !value.originEntityId ||
    value.originInstanceId.length > 512 || value.originEntityId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value.originInstanceId) || /[\u0000-\u001f\u007f]/.test(value.originEntityId)
  ) throw new Error('Invalid sync origin reference')
  return { originInstanceId: value.originInstanceId, originEntityId: value.originEntityId }
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function validateSyncState(value: unknown): SyncState {
  if (!isRecord(value) || value.version !== 1) throw new Error('Unsupported sync state version')
  if (
    !isRecord(value.clock) ||
    !isNonNegativeSafeInteger(value.clock.physicalTimeMs) ||
    !isNonNegativeSafeInteger(value.clock.logicalCounter)
  ) {
    throw new Error('Invalid sync clock state')
  }
  if (!isRecord(value.peers) || !isRecord(value.records)) throw new Error('Invalid sync state maps')
  const workspaceValues = value.workspaces === undefined ? {} : value.workspaces
  const archiveValues = value.archives === undefined ? {} : value.archives
  if (!isRecord(workspaceValues) || !isRecord(archiveValues)) throw new Error('Invalid sync session state maps')

  const peers = Object.create(null) as Record<string, SyncPeerProgress>
  for (const [id, progress] of Object.entries(value.peers)) {
    if (!/^p-[a-f0-9]{24}$/.test(id)) throw new Error('Invalid sync peer ID in state')
    peers[id] = validateProgress(progress)
  }

  const records = Object.create(null) as Record<string, SyncRecordMetadata>
  for (const [key, metadata] of Object.entries(value.records)) {
    const validated = validateRecord(metadata)
    if (key !== syncRecordKey(validated.kind, validated)) throw new Error('Sync record key does not match its origin')
    records[key] = validated
  }

  const workspaces = Object.create(null) as Record<string, SyncWorkspaceMapping>
  for (const [key, mapping] of Object.entries(workspaceValues)) {
    const validated = validateWorkspaceMapping(mapping)
    if (key !== syncWorkspaceKey(validated.originInstanceId, validated.originWorkspaceId, validated.remotePath)) {
      throw new Error('Sync workspace mapping key does not match its origin')
    }
    workspaces[key] = validated
  }

  const archives = Object.create(null) as Record<string, SyncSessionArchive>
  for (const [branchId, archive] of Object.entries(archiveValues)) archives[branchId] = validateArchive(archive, branchId)

  return {
    version: 1,
    clock: { physicalTimeMs: value.clock.physicalTimeMs, logicalCounter: value.clock.logicalCounter },
    peers,
    records,
    workspaces,
    archives,
  }
}

function emptySyncState(): SyncState {
  return { version: 1, clock: { physicalTimeMs: 0, logicalCounter: 0 }, peers: {}, records: {}, workspaces: {}, archives: {} }
}

export class SyncStateStore {
  private state: SyncState | undefined
  private readonly home: string
  private readonly filePath: string

  constructor(home?: string) {
    this.home = dshHome(home)
    this.filePath = join(this.home, 'dshb', 'sync-state.json')
  }

  instanceId(): string {
    return getOrCreateSyncInstanceId(this.home)
  }

  read(): SyncState {
    return clone(this.load())
  }

  update(mutate: (draft: SyncState) => void): SyncState {
    const next = clone(this.load())
    mutate(next)
    const validated = validateSyncState(next)
    atomicWrite(this.filePath, `${JSON.stringify(validated, null, 2)}\n`)
    this.state = validated
    return clone(validated)
  }

  nextRevision(now = Date.now()): SyncRevision {
    const clock = new HybridLogicalClock(this.instanceId(), this.load().clock)
    const revision = clock.tick(now)
    this.update((state) => {
      state.clock = clock.snapshot()
    })
    return revision
  }

  observeRevision(remote: SyncRevision, now = Date.now()): SyncRevision {
    const clock = new HybridLogicalClock(this.instanceId(), this.load().clock)
    const revision = clock.observe(remote, now)
    this.update((state) => {
      state.clock = clock.snapshot()
    })
    return revision
  }

  private load(): SyncState {
    if (this.state) return this.state
    const state = readJson(this.filePath, validateSyncState)
    this.state = state ?? emptySyncState()
    return this.state
  }
}

export type { HlcSnapshot }
