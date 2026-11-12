import type { ReactElement } from 'react'
import type { SyncCatalog, SyncCatalogSession, SyncCatalogWorkspace, SyncOrigin, SyncSelection } from '../core/sync/model.js'

function originKey(origin: SyncOrigin): string {
  return JSON.stringify([origin.originInstanceId, origin.originEntityId])
}

function workspaceKey(workspace: SyncCatalogWorkspace): string {
  return JSON.stringify([workspace.origin.originInstanceId, workspace.origin.originEntityId, workspace.remotePath])
}

function hasOrigin(origins: readonly SyncOrigin[], target: SyncOrigin): boolean {
  return origins.some((origin) => originKey(origin) === originKey(target))
}

function toggleOrigin(origins: readonly SyncOrigin[], target: SyncOrigin): SyncOrigin[] {
  return hasOrigin(origins, target)
    ? origins.filter((origin) => originKey(origin) !== originKey(target))
    : [...origins, target]
}

function sessionWorkspaceMatches(session: SyncCatalogSession, workspace: SyncCatalogWorkspace): boolean {
  return session.workspaceOrigin !== undefined && originKey(session.workspaceOrigin) === originKey(workspace.origin) &&
    (session.workspaceRemotePath === undefined || session.workspaceRemotePath === workspace.remotePath)
}

export function SyncSelectionPicker(props: {
  catalog: SyncCatalog
  selection: SyncSelection
  name: string
  onChange(selection: SyncSelection): void
  includeSessions: boolean
  disabled?: boolean
}): ReactElement {
  const { catalog, selection, includeSessions, disabled = false } = props
  const selectedWorkspaceKeys = new Set(selection.workspaces.map((workspace) =>
    JSON.stringify([workspace.originInstanceId, workspace.originEntityId, workspace.remotePath])))
  const selectedSessions = new Set(selection.sessions.map(originKey))
  const requiredNodes = new Set<string>()
  for (const workspace of catalog.workspaces) {
    if (selectedWorkspaceKeys.has(workspaceKey(workspace))) requiredNodes.add(originKey(workspace.nodeOrigin))
  }
  for (const session of catalog.sessions) {
    if (selectedSessions.has(originKey(session.origin)) && session.nodeOrigin) requiredNodes.add(originKey(session.nodeOrigin))
  }

  const setSelection = (patch: Partial<SyncSelection>): void => {
    props.onChange({ ...selection, ...patch })
  }

  const toggleWorkspace = (workspace: SyncCatalogWorkspace): void => {
    const key = workspaceKey(workspace)
    const selected = selectedWorkspaceKeys.has(key)
    const nextWorkspaces = selected
      ? selection.workspaces.filter((item) => JSON.stringify([item.originInstanceId, item.originEntityId, item.remotePath]) !== key)
      : [...selection.workspaces, { ...workspace.origin, remotePath: workspace.remotePath }]
    const nextSessions = selected ? selection.sessions : selection.sessions.filter((origin) =>
      !catalog.sessions.some((session) => originKey(session.origin) === originKey(origin) && sessionWorkspaceMatches(session, workspace)))
    setSelection({ workspaces: nextWorkspaces, sessions: nextSessions })
  }

  const toggleSession = (session: SyncCatalogSession): void => {
    setSelection({ sessions: toggleOrigin(selection.sessions, session.origin) })
  }

  const sessionsFor = (workspace: SyncCatalogWorkspace): SyncCatalogSession[] => catalog.sessions
    .filter((session) => !session.branchId && sessionWorkspaceMatches(session, workspace))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))

  return (
    <div style={{ display: 'grid', gap: 10, fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: disabled ? 'default' : 'pointer' }}>
          <input type="radio" name={props.name} checked={selection.mode === 'all'} disabled={disabled}
            onChange={() => props.onChange({ mode: 'all', nodes: [], workspaces: [], sessions: [] })} />
          全部可同步内容
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: disabled ? 'default' : 'pointer' }}>
          <input type="radio" name={props.name} checked={selection.mode === 'selected'} disabled={disabled}
            onChange={() => props.onChange({ ...selection, mode: 'selected' })} />
          自选范围
        </label>
      </div>
      {selection.mode === 'selected' && (
        <div style={{ display: 'grid', gap: 10, maxHeight: 320, overflowY: 'auto', padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 }}>
          <section style={{ display: 'grid', gap: 6 }}>
            <strong style={{ opacity: 0.72 }}>工作节点</strong>
            {catalog.nodes.length === 0 && <span style={{ opacity: 0.55 }}>目录中没有可同步工作节点</span>}
            {catalog.nodes.map((node) => {
              const key = originKey(node.origin)
              const explicitlySelected = hasOrigin(selection.nodes, node.origin)
              const required = requiredNodes.has(key) && !explicitlySelected
              return (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: disabled ? 'default' : 'pointer' }}>
                  <input type="checkbox" checked={explicitlySelected || required} disabled={disabled || required}
                    onChange={() => setSelection({ nodes: toggleOrigin(selection.nodes, node.origin) })} />
                  <span>{node.name} <span style={{ opacity: 0.55 }}>({node.type}){required ? ' · 依赖自动包含' : ''}</span></span>
                </label>
              )
            })}
          </section>
          {includeSessions && (
            <section style={{ display: 'grid', gap: 6 }}>
              <strong style={{ opacity: 0.72 }}>工作区与会话</strong>
              {catalog.workspaces.length === 0 && <span style={{ opacity: 0.55 }}>目录中没有可同步工作区</span>}
              {catalog.workspaces.map((workspace) => {
                const key = workspaceKey(workspace)
                const workspaceSelected = selectedWorkspaceKeys.has(key)
                const children = sessionsFor(workspace)
                return (
                  <div key={key} style={{ display: 'grid', gap: 5, padding: '4px 0 4px 2px' }}>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, cursor: disabled ? 'default' : 'pointer' }}>
                      <input type="checkbox" checked={workspaceSelected} disabled={disabled} style={{ marginTop: 1 }} onChange={() => toggleWorkspace(workspace)} />
                      <span style={{ minWidth: 0 }}>
                        <span>{workspace.title || workspace.remotePath}</span>
                        <span style={{ display: 'block', opacity: 0.5, overflowWrap: 'anywhere' }}>{workspace.remotePath} · 选择工作区将包含其会话</span>
                      </span>
                    </label>
                    {children.map((session) => {
                      const sessionSelected = selectedSessions.has(originKey(session.origin))
                      const sessionName = session.title?.trim() || '未命名会话'
                      return (
                        <label key={`${originKey(session.origin)}:${session.branchId ?? ''}`} style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 20, cursor: disabled || workspaceSelected ? 'default' : 'pointer', opacity: workspaceSelected ? 0.55 : 0.82 }}>
                          <input type="checkbox" checked={workspaceSelected || sessionSelected} disabled={disabled || workspaceSelected}
                            onChange={() => toggleSession(session)} />
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${sessionName} · ${session.sessionId}`}>
                            {sessionName.slice(0, 48)}
                            <span style={{ opacity: 0.55, marginLeft: 6 }}>{session.sizeBytes === undefined ? '未知大小' : `${session.sizeBytes.toLocaleString()} B`}{session.deleted ? ' · 已删除' : ''}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )
              })}
            </section>
          )}
          {includeSessions && catalog.sessions.length === 0 && <span style={{ opacity: 0.55 }}>目录中没有可同步会话</span>}
        </div>
      )}
    </div>
  )
}
