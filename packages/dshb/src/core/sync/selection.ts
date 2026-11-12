import { syncWorkspaceKey, type SyncCatalog, type SyncOrigin, type SyncRecordMetadata, type SyncSelection } from './model.js'

export interface ResolvedSyncSelection {
  all: boolean
  nodes: Set<string>
  workspaces: Set<string>
  sessions: Set<string>
}

export function syncOriginKey(origin: SyncOrigin): string {
  return JSON.stringify([origin.originInstanceId, origin.originEntityId])
}

export function resolveSyncSelection(selection: SyncSelection | undefined, catalog: SyncCatalog): ResolvedSyncSelection {
  if (!selection || selection.mode === 'all') {
    return { all: true, nodes: new Set(), workspaces: new Set(), sessions: new Set() }
  }

  const nodes = new Set(selection.nodes.map((origin) => syncOriginKey(origin)))
  const workspaces = new Set(selection.workspaces.map((workspace) =>
    syncWorkspaceKey(workspace.originInstanceId, workspace.originEntityId, workspace.remotePath)))
  const sessions = new Set(selection.sessions.map((origin) => syncOriginKey(origin)))

  for (const workspace of catalog.workspaces) {
    const workspaceKey = syncWorkspaceKey(workspace.origin.originInstanceId, workspace.origin.originEntityId, workspace.remotePath)
    if (workspaces.has(workspaceKey)) nodes.add(syncOriginKey(workspace.nodeOrigin))
  }
  for (const session of catalog.sessions) {
    const sessionKey = syncOriginKey(session.origin)
    const matchesWorkspace = session.workspaceOrigin && selection.workspaces.some((workspace) =>
      syncOriginKey(workspace) === syncOriginKey(session.workspaceOrigin!) &&
      (session.workspaceRemotePath === undefined || workspace.remotePath === session.workspaceRemotePath))
    if (matchesWorkspace) sessions.add(sessionKey)
    if (sessions.has(sessionKey)) {
      if (session.workspaceOrigin && session.workspaceRemotePath) {
        workspaces.add(syncWorkspaceKey(
          session.workspaceOrigin.originInstanceId,
          session.workspaceOrigin.originEntityId,
          session.workspaceRemotePath,
        ))
      }
      if (session.nodeOrigin) nodes.add(syncOriginKey(session.nodeOrigin))
    }
  }

  for (const workspace of catalog.workspaces) {
    const key = syncWorkspaceKey(workspace.origin.originInstanceId, workspace.origin.originEntityId, workspace.remotePath)
    if (workspaces.has(key)) nodes.add(syncOriginKey(workspace.nodeOrigin))
  }

  return { all: false, nodes, workspaces, sessions }
}

export function selectionIncludesNode(metadata: SyncRecordMetadata, selection: ResolvedSyncSelection): boolean {
  return selection.all || selection.nodes.has(syncOriginKey(metadata))
}

export function selectionIncludesSession(metadata: SyncRecordMetadata, selection: ResolvedSyncSelection): boolean {
  return selection.all || selection.sessions.has(syncOriginKey(metadata))
}
