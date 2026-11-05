import { posix } from 'node:path'
import type { SyncRevision } from './revision.js'

export type SyncDirection = 'pull' | 'bidirectional'
export type SyncSchedule = 'manual' | 'every-5m'
export type SyncEntityKind = 'node' | 'session'
export type SyncImportMethod = 'peer' | 'offline'
/** 全量同步传输会话内容；元数据同步只同步目录，点击会话时经 wss 实时操作远端。 */
export type SyncMode = 'full' | 'metadata'

export interface SyncOrigin {
  originInstanceId: string
  originEntityId: string
}

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
  /** 已取消的方向逻辑；读取旧数据时恒为 'bidirectional'。 */
  direction: SyncDirection
  /** 已取消的时机逻辑；读取旧数据时恒为 'manual'（同步仅由「立即同步」触发）。 */
  schedule: SyncSchedule
  mode: SyncMode
  /** 已废弃：工作节点配置恒同步；字段仅为兼容旧持久化数据保留。 */
  syncNodes?: boolean
  syncSessions: boolean
  selection?: SyncSelection
  enabled: boolean
  hostKeyFingerprint?: string
}

export interface SyncWorkspaceOrigin extends SyncOrigin {
  remotePath: string
}

export interface SyncSelection {
  mode: 'all' | 'selected'
  nodes: SyncOrigin[]
  workspaces: SyncWorkspaceOrigin[]
  sessions: SyncOrigin[]
}

export interface SyncCatalogNode {
  origin: SyncOrigin
  name: string
  type: 'remote-ssh' | 'remote-docker'
}

export interface SyncCatalogWorkspace {
  origin: SyncOrigin
  nodeOrigin: SyncOrigin
  remotePath: string
  title: string
}

export interface SyncCatalogSession {
  origin: SyncOrigin
  workspaceOrigin?: SyncOrigin
  workspaceRemotePath?: string
  nodeOrigin?: SyncOrigin
  sessionId: string
  title?: string
  sizeBytes?: number
  branchId?: string
  deleted?: boolean
}

export interface SyncCatalog {
  protocolVersion: 1
  instanceId: string
  nodes: SyncCatalogNode[]
  workspaces: SyncCatalogWorkspace[]
  sessions: SyncCatalogSession[]
}

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
  selection?: SyncSelection
  enabled: boolean
  hostKeyFingerprint?: string
}

export type SyncPeerDraft = Omit<SyncPeer, 'id' | 'hostKeyFingerprint'>

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
  lastRunStatus?: 'running' | 'succeeded' | 'failed' | 'stopped'
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
    /** 元数据同步最近一次目录计数（可选，旧状态缺省）。 */
    catalogNodes?: number
    catalogWorkspaces?: number
    catalogSessions?: number
    /** 内容快照落后于 manifest 而跳过的活跃会话数（可选，旧状态缺省）。 */
    staleSkippedSessions?: number
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
  'mode',
  'syncNodes',
  'syncSessions',
  'selection',
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

function parseOrigin(value: unknown, label: string): SyncOrigin {
  const input = record(value, label)
  if (Object.keys(input).some((key) => key !== 'originInstanceId' && key !== 'originEntityId')) {
    throw new Error(`${label} contains unsupported fields`)
  }
  return {
    originInstanceId: text(input.originInstanceId, `${label}.originInstanceId`, 512),
    originEntityId: text(input.originEntityId, `${label}.originEntityId`, 512),
  }
}

export function parseSyncSelection(value: unknown): SyncSelection {
  const input = record(value, 'selection')
  if (Object.keys(input).some((key) => !['mode', 'nodes', 'workspaces', 'sessions'].includes(key))) {
    throw new Error('selection contains unsupported fields')
  }
  if (input.mode !== 'all' && input.mode !== 'selected') throw new Error('selection mode is invalid')
  const parseOrigins = (value: unknown, label: string): SyncOrigin[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 10_000) throw new Error(`${label} must be an array of at most 10000 items`)
    const origins = value.map((item, index) => parseOrigin(item, `${label}[${index}]`))
    const keys = origins.map((origin) => JSON.stringify([origin.originInstanceId, origin.originEntityId]))
    if (new Set(keys).size !== keys.length) throw new Error(`${label} contains duplicate origins`)
    return origins
  }
  const nodes = parseOrigins(input.nodes, 'selection.nodes')
  const rawWorkspaces = input.workspaces
  if (rawWorkspaces !== undefined && (!Array.isArray(rawWorkspaces) || rawWorkspaces.length > 10_000)) {
    throw new Error('selection.workspaces must be an array of at most 10000 items')
  }
  const workspaces = (rawWorkspaces ?? []).map((value, index) => {
    const workspace = record(value, `selection.workspaces[${index}]`)
    if (Object.keys(workspace).some((key) => !['originInstanceId', 'originEntityId', 'remotePath'].includes(key)) ||
      typeof workspace.remotePath !== 'string' || workspace.remotePath.length > 4096 || !posix.isAbsolute(workspace.remotePath) ||
      posix.normalize(workspace.remotePath) !== workspace.remotePath) {
      throw new Error(`selection.workspaces[${index}] is invalid`)
    }
    const { remotePath, ...origin } = workspace
    return { ...parseOrigin(origin, `selection.workspaces[${index}]`), remotePath: remotePath as string }
  })
  const workspaceKeys = workspaces.map((workspace) => JSON.stringify([
    workspace.originInstanceId, workspace.originEntityId, workspace.remotePath,
  ]))
  if (new Set(workspaceKeys).size !== workspaceKeys.length) throw new Error('selection.workspaces contains duplicate origins')
  const sessions = parseOrigins(input.sessions, 'selection.sessions')
  if (input.mode === 'all' && (nodes.length > 0 || workspaces.length > 0 || sessions.length > 0)) {
    throw new Error('all selection cannot contain explicit origins')
  }
  return { mode: input.mode, nodes, workspaces, sessions }
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
  // direction/schedule/syncNodes 旧字段仅用于读取旧数据不报错；值一律忽略——
  // 方向与时机逻辑已取消（同步恒为手动触发 + 双向交换），工作节点配置恒同步。
  if (input.direction !== undefined && input.direction !== 'pull' && input.direction !== 'bidirectional') {
    throw new Error('direction must be pull or bidirectional')
  }
  if (input.schedule !== undefined && input.schedule !== 'manual' && input.schedule !== 'every-5m') {
    throw new Error('schedule must be manual or every-5m')
  }
  if (input.mode !== undefined && input.mode !== 'full' && input.mode !== 'metadata') {
    throw new Error('mode must be full or metadata')
  }
  if (input.syncNodes !== undefined && typeof input.syncNodes !== 'boolean') {
    throw new Error('syncNodes must be a boolean')
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
    // 方向与时机逻辑已取消：读取旧数据时一律归一为双向交换 + 手动触发。
    direction: 'bidirectional',
    schedule: 'manual',
    // 旧 peer 数据没有 mode 字段：缺省按全量同步处理，保持既有行为不变。
    mode: input.mode === undefined ? 'full' : input.mode,
    syncSessions: input.syncSessions,
    ...(input.selection === undefined ? {} : { selection: parseSyncSelection(input.selection) }),
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
