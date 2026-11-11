import { posix } from 'node:path'
import type { SyncCatalog, SyncCatalogNode, SyncCatalogSession, SyncCatalogWorkspace, SyncOrigin } from './model.js'
import { isNonNegativeSafeInteger, isRecord } from './model.js'
import type { SyncNodeService } from './node-sync.js'
import type { SyncSessionService } from './session-sync.js'
import { MAX_SYNC_TRANSFER_BYTES } from './protocol.js'

const MAX_CATALOG_ITEMS = 10_000

function parseOrigin(value: unknown): SyncOrigin {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'originInstanceId' && key !== 'originEntityId') ||
    typeof value.originInstanceId !== 'string' || value.originInstanceId.length === 0 || value.originInstanceId.length > 512 ||
    typeof value.originEntityId !== 'string' || value.originEntityId.length === 0 || value.originEntityId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value.originInstanceId) || /[\u0000-\u001f\u007f]/.test(value.originEntityId)) {
    throw new Error('sync catalog origin is invalid')
  }
  return { originInstanceId: value.originInstanceId, originEntityId: value.originEntityId }
}

function validateCatalogNode(value: unknown): SyncCatalogNode {
  if (!isRecord(value) || Object.keys(value).some((key) => !['origin', 'name', 'type'].includes(key)) ||
    typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128 ||
    (value.type !== 'remote-ssh' && value.type !== 'remote-docker')) {
    throw new Error('sync catalog node is invalid')
  }
  return { origin: parseOrigin(value.origin), name: value.name, type: value.type }
}

function validateCatalogWorkspace(value: unknown): SyncCatalogWorkspace {
  if (!isRecord(value) || Object.keys(value).some((key) => !['origin', 'nodeOrigin', 'remotePath', 'title'].includes(key)) ||
    typeof value.remotePath !== 'string' || value.remotePath.length > 4096 || !posix.isAbsolute(value.remotePath) || posix.normalize(value.remotePath) !== value.remotePath ||
    typeof value.title !== 'string' || value.title.length > 512) {
    throw new Error('sync catalog workspace is invalid')
  }
  return {
    origin: parseOrigin(value.origin),
    nodeOrigin: parseOrigin(value.nodeOrigin),
    remotePath: value.remotePath,
    title: value.title,
  }
}

function validateCatalogSession(value: unknown): SyncCatalogSession {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    'origin', 'workspaceOrigin', 'workspaceRemotePath', 'nodeOrigin', 'sessionId', 'title', 'sizeBytes', 'branchId', 'deleted', 'archived', 'blank',
  ].includes(key)) || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 512 ||
    (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 512 || /[\u0000-\u001f\u007f]/.test(value.title))) ||
    (value.workspaceRemotePath !== undefined && (typeof value.workspaceRemotePath !== 'string' || value.workspaceRemotePath.length > 4096 ||
      !posix.isAbsolute(value.workspaceRemotePath) || posix.normalize(value.workspaceRemotePath) !== value.workspaceRemotePath)) ||
    (value.sizeBytes !== undefined && !isNonNegativeSafeInteger(value.sizeBytes)) ||
    (value.branchId !== undefined && (typeof value.branchId !== 'string' || !/^b-[a-f0-9]{32}$/.test(value.branchId))) ||
    (value.deleted !== undefined && typeof value.deleted !== 'boolean') ||
    (value.archived !== undefined && typeof value.archived !== 'boolean') ||
    (value.blank !== undefined && typeof value.blank !== 'boolean')) {
    throw new Error('sync catalog session is invalid')
  }
  return {
    origin: parseOrigin(value.origin),
    ...(value.workspaceOrigin === undefined ? {} : { workspaceOrigin: parseOrigin(value.workspaceOrigin) }),
    ...(value.workspaceRemotePath === undefined ? {} : { workspaceRemotePath: value.workspaceRemotePath as string }),
    ...(value.nodeOrigin === undefined ? {} : { nodeOrigin: parseOrigin(value.nodeOrigin) }),
    sessionId: value.sessionId,
    ...(value.title === undefined ? {} : { title: value.title as string }),
    ...(value.sizeBytes === undefined ? {} : { sizeBytes: value.sizeBytes as number }),
    ...(value.branchId === undefined ? {} : { branchId: value.branchId }),
    ...(value.deleted === undefined ? {} : { deleted: value.deleted }),
    ...(value.archived === undefined ? {} : { archived: value.archived }),
    ...(value.blank === undefined ? {} : { blank: value.blank }),
  }
}

export function validateSyncCatalog(value: unknown): SyncCatalog {
  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.instanceId !== 'string' ||
    !/^i-[a-f0-9]{32}$/.test(value.instanceId) || !Array.isArray(value.nodes) ||
    !Array.isArray(value.workspaces) || !Array.isArray(value.sessions) ||
    value.nodes.length > MAX_CATALOG_ITEMS || value.workspaces.length > MAX_CATALOG_ITEMS ||
    value.sessions.length > MAX_CATALOG_ITEMS || Object.keys(value).some((key) =>
      !['protocolVersion', 'instanceId', 'nodes', 'workspaces', 'sessions'].includes(key))) {
    throw new Error('sync catalog is invalid')
  }
  const catalog: SyncCatalog = {
    protocolVersion: 1,
    instanceId: value.instanceId,
    nodes: value.nodes.map(validateCatalogNode),
    workspaces: value.workspaces.map(validateCatalogWorkspace),
    sessions: value.sessions.map(validateCatalogSession),
  }
  const keys = [
    ...catalog.nodes.map((item) => JSON.stringify(['node', item.origin.originInstanceId, item.origin.originEntityId])),
    ...catalog.workspaces.map((item) => JSON.stringify(['workspace', item.origin.originInstanceId, item.origin.originEntityId, item.remotePath])),
    ...catalog.sessions.map((item) => JSON.stringify(['session', item.branchId ?? item.origin.originEntityId, item.origin.originInstanceId])),
  ]
  if (new Set(keys).size !== keys.length) throw new Error('sync catalog contains duplicate records')
  if (Buffer.byteLength(JSON.stringify(catalog), 'utf8') > MAX_SYNC_TRANSFER_BYTES) throw new Error('sync catalog exceeds the transfer limit')
  return catalog
}

export async function exportSyncCatalog(nodes: SyncNodeService, sessions: SyncSessionService): Promise<SyncCatalog> {
  const manifest = await nodes.exportManifest()
  const sessionCatalog = await sessions.exportCatalog()
  return validateSyncCatalog({
    protocolVersion: 1,
    instanceId: manifest.instanceId,
    nodes: manifest.records.flatMap((entry) => entry.profile && !entry.metadata.deleted
      ? [{
          origin: { originInstanceId: entry.metadata.originInstanceId, originEntityId: entry.metadata.originEntityId },
          name: entry.profile.name,
          type: entry.profile.type,
        }]
      : []),
    workspaces: sessionCatalog.workspaces,
    sessions: sessionCatalog.sessions,
  })
}
