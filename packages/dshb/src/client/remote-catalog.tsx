import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { RemoteSessionOverlay, REMOTE_CATALOG_PANEL_STYLE } from './remote-session.js'

/**
 * 侧栏「远端」入口：目录浮层展示各同步 peer 的远端工作区/会话清单
 * （元数据同步模式下的远端目录浏览），点击会话经 SSH relay 实时打开
 * 远端 DSH。目录实时拉取（GET /api/dshb/sync/peers/<id>/catalog），
 * 不落盘——打开浮层才有一次 SSH 开销。
 */

interface SyncOriginRef {
  originInstanceId: string
  originEntityId: string
}

interface CatalogWorkspace {
  origin: SyncOriginRef
  remotePath: string
  title: string
}

interface CatalogSession {
  origin: SyncOriginRef
  workspaceOrigin?: SyncOriginRef
  workspaceRemotePath?: string
  sessionId: string
  title?: string
  sizeBytes?: number
  deleted?: boolean
}

interface Catalog {
  instanceId: string
  nodes: unknown[]
  workspaces: CatalogWorkspace[]
  sessions: CatalogSession[]
}

interface PeerView {
  id: string
  name: string
  enabled: boolean
  mode?: string
  syncSessions?: boolean
}

interface CatalogEntry {
  peer: PeerView
  catalog?: Catalog
  error?: string
}

interface PeersResponse {
  peers?: PeerView[]
}

function formatSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
  return `${(bytes / 1024 / 1024).toFixed(1)}M`
}

function wsKey(origin?: SyncOriginRef): string {
  return origin ? `${origin.originInstanceId}/${origin.originEntityId}` : ''
}

async function fetchPeerCatalog(peerId: string): Promise<Catalog> {
  const res = await fetch(`/api/dshb/sync/peers/${encodeURIComponent(peerId)}/catalog`, { cache: 'no-store' })
  const body = (await res.json().catch(() => undefined)) as { catalog?: Catalog; code?: string; error?: string } | undefined
  if (!res.ok || !body?.catalog) {
    throw new Error(body?.code ? `${body.code}${body.error ? `：${body.error}` : ''}` : `HTTP ${res.status}`)
  }
  return body.catalog
}

function CatalogPanel({ peers, onClose }: { peers: PeerView[]; onClose: () => void }): ReactElement {
  const [entries, setEntries] = useState<CatalogEntry[] | undefined>(undefined)
  const [openSession, setOpenSession] = useState<{ peerId: string; title: string } | undefined>(undefined)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setEntries(undefined)
    const targets = peers.filter((peer) => peer.enabled)
    void Promise.all(
      targets.map(async (peer): Promise<CatalogEntry> => {
        try {
          return { peer, catalog: await fetchPeerCatalog(peer.id) }
        } catch (error) {
          return { peer, error: error instanceof Error ? error.message : String(error) }
        }
      }),
    ).then((result) => {
      if (!cancelled) setEntries(result)
    })
    return () => {
      cancelled = true
    }
  }, [peers, reloadKey])

  if (openSession) {
    return <RemoteSessionOverlay peerId={openSession.peerId} onClose={() => setOpenSession(undefined)} />
  }

  return (
    <>
      <style>{REMOTE_CATALOG_PANEL_STYLE}</style>
      <div data-dshb-remote-catalog-backdrop onClick={onClose} />
      <div data-dshb-remote-catalog-panel role="dialog" aria-label="远端目录">
        <header>
          <span className="title">远端目录</span>
          <button type="button" aria-label="刷新" title="重新拉取目录" onClick={() => setReloadKey((k) => k + 1)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V6h-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div data-dshb-remote-catalog-body>
          {entries === undefined ? <div className="empty">正在拉取远端目录…</div> : null}
          {entries?.map((entry) => {
            const sessions = (entry.catalog?.sessions ?? []).filter((session) => !session.deleted)
            const workspaces = entry.catalog?.workspaces ?? []
            const grouped = new Map<string, { title: string; remotePath: string; sessions: CatalogSession[] }>()
            for (const workspace of workspaces) {
              grouped.set(wsKey(workspace.origin), { title: workspace.title || workspace.remotePath, remotePath: workspace.remotePath, sessions: [] })
            }
            for (const session of sessions) {
              const key = wsKey(session.workspaceOrigin)
              const bucket = grouped.get(key)
              if (bucket) bucket.sessions.push(session)
              else grouped.set(key, { title: session.workspaceRemotePath || '未分组', remotePath: session.workspaceRemotePath ?? '', sessions: [session] })
            }
            const orphanKey = wsKey(undefined)
            const orphan = grouped.get(orphanKey)
            if (orphan && orphan.sessions.length === 0) grouped.delete(orphanKey)
            return (
              <div className="peer" key={entry.peer.id}>
                <div className="peer-name">
                  {entry.peer.name || entry.peer.id}
                  <span className="peer-meta">
                    {entry.catalog ? `${workspaces.length} 工作区 · ${sessions.length} 会话` : ''}
                  </span>
                </div>
                {entry.error ? <div className="err">{entry.error}</div> : null}
                {entry.catalog && grouped.size === 0 ? <div className="empty">远端暂无工作区或会话</div> : null}
                {[...grouped.entries()].map(([key, group]) => (
                  <div className="ws" key={key}>
                    <div className="ws-title">
                      <span>{group.title}</span>
                      <span className="ws-path">{group.remotePath}</span>
                    </div>
                    {group.sessions.map((session) => (
                      <button
                        type="button"
                        className="sess"
                        key={session.origin.originEntityId || session.sessionId}
                        title={`打开远端会话（实时操作 ${entry.peer.name}）`}
                        onClick={() => setOpenSession({ peerId: entry.peer.id, title: session.title ?? session.sessionId })}
                      >
                        <span className="s-title">{session.title || session.sessionId}</span>
                        <span className="s-size">{formatSize(session.sizeBytes)}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )
          })}
          {entries !== undefined && entries.length === 0 ? <div className="empty">尚无已启用的同步节点</div> : null}
        </div>
      </div>
    </>
  )
}

interface SlotsLike {
  inject(name: string, factory: () => unknown): unknown
  register(spec: Record<string, unknown>, component: unknown): unknown
}

/** 侧栏 footer 的「远端」按钮：打开远端目录浮层。 */
function RemoteCatalogButton(): ReactElement {
  const [open, setOpen] = useState(false)
  const [peers, setPeers] = useState<PeerView[]>([])
  const loadPeers = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/dshb/sync/peers', { cache: 'no-store' })
      const body = (await res.json().catch(() => undefined)) as PeersResponse | undefined
      if (body?.peers) setPeers(body.peers)
    } catch {}
  }, [])
  useEffect(() => {
    if (open) void loadPeers()
  }, [open, loadPeers])
  return (
    <>
      <style>{REMOTE_CATALOG_PANEL_STYLE}</style>
      <button
        type="button"
        data-dshb-remote-catalog="open"
        aria-label="远端目录"
        title="远端目录（浏览同步节点的远端工作区与会话）"
        onClick={() => setOpen(true)}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
          <path d="M2 6.5h12M2 9.5h12M8 1.9c-1.8 1.7-2.8 3.8-2.8 6.1s1 4.4 2.8 6.1c1.8-1.7 2.8-3.8 2.8-6.1s-1-4.4-2.8-6.1Z" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      {open ? <CatalogPanel peers={peers} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/** 注册侧栏远端目录入口（footer 操作区）。 */
export function installRemoteCatalogEntry(ctx: unknown): void {
  const slots = (ctx as { slots?: SlotsLike }).slots
  if (!slots) return
  slots.inject('sidebar.footer.action', () =>
    slots.register({ name: 'sidebar.footer.action', id: 'dshb-remote-catalog', order: 40 }, RemoteCatalogButton),
  )
}
