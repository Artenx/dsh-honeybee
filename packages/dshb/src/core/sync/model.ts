import { posix } from 'node:path'
import type { SyncRevision } from './revision.js'

export type SyncDirection = 'pull' | 'bidirectional'
export type SyncSchedule = 'manual' | 'every-5m'
export type SyncEntityKind = 'node' | 'session'
export type SyncImportMethod = 'peer' | 'offline'

export interface SyncPeer {
  id: string
  name: string
  host: string
  port: number
  username: string
  authKind: 'password' | 'key'
  remoteDshHome?: string
  remoteProfile?: string
  remoteWebPort?: number
  direction: SyncDirection
  schedule: SyncSchedule
  syncSessions: boolean
  enabled: boolean
  hostKeyFingerprint?: string
}

export type SyncPeerDraft = Omit<SyncPeer, 'id' | 'hostKeyFingerprint'>

export interface SyncOrigin {
  originInstanceId: string
  originEntityId: string
}

export interface SyncProvenance extends SyncOrigin {
  localEntityId: string
  importedVia?: SyncImportMethod
  sourceName?: string
}

export interface SyncRecordMetadata extends SyncProvenance {
  kind: SyncEntityKind
  revision: SyncRevision
  contentDigest: string
  stateDigest?: string
  workspaceOrigin?: SyncOrigin
  deleted?: boolean
  pendingRemoval?: boolean
  credentialsRequired?: boolean
}

export interface SyncPeerProgress {
  lastRunAt?: string
  lastRunStatus?: 'running' | 'succeeded' | 'failed'
  lastSuccessAt?: string
  lastManifestDigest?: string
  watermark?: string
  lastErrorCode?: string
  lastErrorMessage?: string
  lastResult?: {
    imported: number
    exported: number
    skipped: number
    pendingRemoval: number
    importedSessions: number
    exportedSessions: number
    skippedSessions: number
  }
}

export interface SyncWorkspaceMapping {
  originInstanceId: string
  originWorkspaceId: string
  localWorkspaceId: string
  localPath: string
  localNodeId: string
  remotePath: string
  title: string
  revision: SyncRevision
  contentDigest: string
}

export interface SyncSessionArchive {
  branchId: string
  originInstanceId: string
  originSessionId: string
  localSessionId: string
  revision: SyncRevision
  contentDigest: string
  stateDigest: string
  workspacePosition: number
  workspaceId?: string
  workspaceOrigin?: SyncOrigin
  archivedAt: string
}

export interface SyncState {
  version: 1
  clock: { physicalTimeMs: number; logicalCounter: number }
  peers: Record<string, SyncPeerProgress>
  records: Record<string, SyncRecordMetadata>
  workspaces: Record<string, SyncWorkspaceMapping>
  archives: Record<string, SyncSessionArchive>
}

const PEER_FIELDS = new Set([
  'id',
  'name',
  'host',
  'port',
  'username',
  'authKind',
  'remoteDshHome',
  'remoteProfile',
  'remoteWebPort',
  'direction',
  'schedule',
  'syncSessions',
  'enabled',
  'hostKeyFingerprint',
])

const PEER_DRAFT_FIELDS = new Set([...PEER_FIELDS].filter((field) => field !== 'id' && field !== 'hostKeyFingerprint'))

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const result = value.trim()
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${label} is invalid`)
  }
  return result
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : text(value, label, maxLength)
}

function port(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return value as number
}

export function parseSyncPeer(value: unknown): SyncPeer {
  const input = record(value, 'sync peer')
  for (const key of Object.keys(input)) {
    if (!PEER_FIELDS.has(key)) throw new Error(`sync peer contains unsupported field: ${key}`)
  }

  const id = text(input.id, 'id', 128)
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('id is invalid')

  const name = text(input.name, 'name', 128)
  const host = text(input.host, 'host', 255)
  if (/\s/.test(host)) throw new Error('host is invalid')

  const username = text(input.username, 'username', 128)
  if (/\s/.test(username)) throw new Error('username is invalid')

  if (input.authKind !== 'password' && input.authKind !== 'key') {
    throw new Error('authKind must be password or key')
  }
  if (input.direction !== 'pull' && input.direction !== 'bidirectional') {
    throw new Error('direction must be pull or bidirectional')
  }
  if (input.schedule !== 'manual' && input.schedule !== 'every-5m') {
    throw new Error('schedule must be manual or every-5m')
  }
  if (typeof input.syncSessions !== 'boolean' || typeof input.enabled !== 'boolean') {
    throw new Error('syncSessions and enabled must be booleans')
  }

  const remoteDshHome = optionalText(input.remoteDshHome, 'remoteDshHome', 4096)
  if (remoteDshHome !== undefined) {
    if (!posix.isAbsolute(remoteDshHome) || remoteDshHome.split('/').includes('..') || remoteDshHome.includes('\\')) {
      throw new Error('remoteDshHome must be a normalized absolute path')
    }
  }

  const remoteProfile = optionalText(input.remoteProfile, 'remoteProfile', 256)
  const hostKeyFingerprint = optionalText(input.hostKeyFingerprint, 'hostKeyFingerprint', 512)

  return {
    id,
    name,
    host,
    port: port(input.port, 'port'),
    username,
    authKind: input.authKind,
    ...(remoteDshHome === undefined ? {} : { remoteDshHome: posix.normalize(remoteDshHome) }),
    ...(remoteProfile === undefined ? {} : { remoteProfile }),
    ...(input.remoteWebPort === undefined ? {} : { remoteWebPort: port(input.remoteWebPort, 'remoteWebPort') }),
    direction: input.direction,
    schedule: input.schedule,
    syncSessions: input.syncSessions,
    enabled: input.enabled,
    ...(hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint }),
  }
}

export function parseSyncPeerDraft(value: unknown): SyncPeerDraft {
  const input = record(value, 'sync peer draft')
  for (const key of Object.keys(input)) {
    if (!PEER_DRAFT_FIELDS.has(key)) throw new Error(`sync peer draft contains unsupported field: ${key}`)
  }
  const { id, ...draft } = parseSyncPeer({ ...input, id: `p-${'0'.repeat(24)}` })
  void id
  return draft
}

export function syncRecordKey(kind: SyncEntityKind, origin: SyncOrigin): string {
  return JSON.stringify([kind, origin.originInstanceId, origin.originEntityId])
}

export function syncWorkspaceKey(originInstanceId: string, originWorkspaceId: string, remotePath: string): string {
  return JSON.stringify([originInstanceId, originWorkspaceId, remotePath])
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
