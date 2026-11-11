// 纯 DOM 实现：客户端模块加载器只共享 react，无 react-dom，故不依赖 React 渲染。

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * 侧边栏远端工作区内联展示：把各同步 peer 的远端工作区/会话直接渲染进
 * 上游工作区列表（role=tree 容器），与本机工作区同级，名称前用云图标标识。
 * 点击会话时经 POST /api/dshb/sync/open-session 按需导入该会话（与全量同步
 * 相同的 manifest→entries→applyBundle 链路，只拉这一个），随后调用
 * uiWorkspace.openSession 以原生方式打开——不再嵌套远端 DSH 主页 iframe。
 *
 * 上游 sidebar.workspaces 是 single slot（整体 WorkspaceBrowser），无追加
 * section 的扩展点；且客户端模块加载器只共享 react（无 react-dom），
 * 故采用纯 DOM 构建 + MutationObserver 挂载（与 workspace-instruction-menu 同模式）。
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
  deleted?: boolean
  archived?: boolean
  branchId?: string
  blank?: boolean
}

interface Catalog {
  instanceId: string
  workspaces: CatalogWorkspace[]
  sessions: CatalogSession[]
}

interface PeerView {
  id: string
  name: string
  enabled: boolean
  mode?: 'full' | 'metadata'
  syncSessions?: boolean
}

interface PeerCatalog {
  peer: PeerView
  catalog?: Catalog
  error?: string
}

const SECTION_ATTR = 'data-dshb-remote-workspaces'
const REFRESH_INTERVAL_MS = 60_000

function wsKey(origin?: SyncOriginRef): string {
  return origin ? `${origin.originInstanceId}/${origin.originEntityId}` : ''
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init })
  const body = (await res.json().catch(() => undefined)) as (T & { error?: string; code?: string }) | undefined
  if (!res.ok || body === undefined) throw new Error(body?.error ?? body?.code ?? `HTTP ${res.status}`)
  return body
}

function el(tag: string, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElement {
  const node = document.createElement(tag)
  Object.assign(node.style, style)
  if (text !== undefined) node.textContent = text
  return node
}

interface UiWorkspaceLike {
  openSession(sessionId: string): void
}

interface SessionsLike {
  refresh?(): Promise<unknown> | void
}

export function installRemoteWorkspacesSection(ctx: ClientContext): () => void {
  let host: HTMLElement | undefined
  let observer: MutationObserver | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let raf = 0
  let disposed = false
  let entries: PeerCatalog[] | undefined
  const collapsed = new Set<string>()

  const render = (): void => {
    if (!host) return
    host.textContent = ''
    host.style.paddingTop = '2px'
    if (entries === undefined || entries.length === 0) return

    for (const entry of entries) {
      if (entry.error || !entry.catalog) continue
      // 只按远端 catalog 自身声明的状态过滤：已删除、已归档、空壳（blank）、
      // 分支归档（branchId）。不再用 session-sync-* 前缀做启发式排除——
      // 那是「本机导入副本」的命名，而目录描述的是远端实例自己的会话，
      // 远端 UI 完全可能把它的导入副本作为活跃会话展示（实例间级联同步）。
      const sessions = (entry.catalog.sessions ?? []).filter((s) =>
        !s.deleted && !s.archived && !s.branchId && !s.blank && Boolean(s.workspaceOrigin))
      const grouped = new Map<string, { title: string; remotePath: string; sessions: CatalogSession[] }>()
      for (const ws of entry.catalog.workspaces ?? []) {
        grouped.set(wsKey(ws.origin), { title: ws.title || ws.remotePath, remotePath: ws.remotePath, sessions: [] })
      }
      for (const s of sessions) {
        const key = wsKey(s.workspaceOrigin)
        const bucket = grouped.get(key)
        // 无法关联到明确远端工作区的会话不创建「未分组」伪工作区。
        if (bucket) bucket.sessions.push(s)
      }

      // 与本机工作区同级渲染：每个远端工作区一个可折叠行，名称前用云图标标识来源，
      // 不再有单独的「远端工作区」分区标题或 peer 分组层。
      // 只渲染有会话的工作区组；无活跃会话的空工作区不显示，避免标题占位造成困惑。
      const visibleGroups = [...grouped].filter(([, group]) => group.sessions.length > 0)
      for (const [key, group] of visibleGroups) {
        const groupKey = `${entry.peer.id}:${key}`
        const isCollapsed = collapsed.has(groupKey)
        const wsBox = el('div', { margin: '2px 0' })
        const row = el('button', { display: 'flex', alignItems: 'center', gap: '6px', width: '100%', height: '34px', padding: '0 8px', background: 'none', border: 'none', borderRadius: '6px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '14px', textAlign: 'left', boxSizing: 'border-box' })
        row.title = `${group.remotePath} · 来自同步节点 ${entry.peer.name}`
        const chev = el('span', { fontSize: '10px', opacity: '0.6', flexShrink: '0', width: '10px' }, isCollapsed ? '▸' : '▾')
        const icon = document.createElement('span')
        icon.style.cssText = 'flex-shrink:0;display:inline-flex;color:var(--dsw-alias-label-tertiary)'
        icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4.5 12.5h7a2.5 2.5 0 0 0 .4-4.97A4 4 0 0 0 4.2 6.6 3 3 0 0 0 4.5 12.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
        const name = el('span', { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, group.title)
        row.append(chev, icon, name)
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--dsw-alias-interactive-bg-hover)' })
        row.addEventListener('mouseleave', () => { row.style.background = 'none' })
        row.addEventListener('click', () => {
          if (isCollapsed) collapsed.delete(groupKey)
          else collapsed.add(groupKey)
          render()
        })
        wsBox.appendChild(row)

        if (!isCollapsed) {
          for (const session of group.sessions) {
            // 远端未命名会话（catalog 无 title）在远端 UI 显示默认名「新会话」；
            // 这里与之对齐并附短 ID，避免把原始 UUID 误读成"远端不存在的会话"。
            const shortId = session.sessionId.replace(/^session-/, '').slice(0, 8)
            const label = session.title || `新会话（${shortId}）`
            const btn = el('button', { display: 'block', width: 'calc(100% - 16px)', margin: '1px 0 1px 16px', padding: '5px 8px', background: 'none', border: 'none', borderRadius: '6px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '13px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, label)
            btn.title = `打开远端会话（实时操作 ${entry.peer.name}）\nID: ${session.sessionId}`
            btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--dsw-alias-interactive-bg-hover)' })
            btn.addEventListener('mouseleave', () => { btn.style.background = 'none' })
            btn.addEventListener('click', () => importAndOpenSession(entry.peer.id, session.sessionId))
            wsBox.appendChild(btn)
          }
        }
        host.appendChild(wsBox)
      }
    }
  }

  // 按需导入并原生打开：导入期间用轻量 toast 提示，成功后 uiWorkspace.openSession
  // 与本机会话完全一致地渲染；失败时 toast 展示服务端错误，不再退回 iframe 主页。
  let opening = false
  const showToast = (text: string, isError = false): (() => void) => {
    const toast = el('div', {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483000', padding: '8px 16px', borderRadius: '8px', fontSize: '13px',
      background: 'var(--dsw-alias-bg-layer-1, #1c1e22)', color: isError ? 'var(--dsw-alias-state-error-primary, #f87171)' : 'var(--dsw-alias-label-primary, #e8eaed)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
      maxWidth: '80vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }, text)
    document.body.appendChild(toast)
    return () => toast.remove()
  }

  const importAndOpenSession = (peerId: string, sessionId: string): void => {
    if (opening) return
    opening = true
    const dismiss = showToast('正在导入远端会话…')
    void (async () => {
      try {
        const result = await fetchJson<{ sessionId?: string }>('/api/dshb/sync/open-session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ peerId, sessionId }),
        })
        if (!result.sessionId) throw new Error('服务端未返回本地会话 ID')
        const service = (name: string): unknown => (ctx as unknown as Record<string, unknown>)[name]
        // 导入产生的新会话经 api-session/added 事件进入客户端列表；主动 refresh 加速，
        // 短暂等待后 openSession（resolveTarget 需要会话已在列表/摘要中）。
        const sessions = service('sessions') as SessionsLike | undefined
        try { void sessions?.refresh?.() } catch {}
        const ui = service('uiWorkspace') as UiWorkspaceLike | undefined
        if (!ui || typeof ui.openSession !== 'function') throw new Error('uiWorkspace 服务不可用')
        let lastError: unknown
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            ui.openSession(result.sessionId)
            lastError = undefined
            break
          } catch (error) {
            lastError = error
            await new Promise((resolve) => setTimeout(resolve, 300))
          }
        }
        if (lastError !== undefined) throw lastError instanceof Error ? lastError : new Error(String(lastError))
      } catch (error) {
        const dismissError = showToast(error instanceof Error ? error.message : '远端会话打开失败', true)
        setTimeout(dismissError, 6000)
      } finally {
        dismiss()
        opening = false
      }
    })()
  }

  const load = async (): Promise<void> => {
    try {
      const { peers } = await fetchJson<{ peers?: PeerView[] }>('/api/dshb/sync/peers')
      // 全量同步的会话已经进入本地工作区树并使用 DSH 原生归档/打开操作；
      // 避免再以远端副本重复显示。metadata 和仅同步节点的 peer 仍显示目录入口。
      const targets = (peers ?? []).filter((p) => p.enabled && !(p.mode === 'full' && p.syncSessions))
      const result = await Promise.all(targets.map(async (peer): Promise<PeerCatalog> => {
        try {
          const { catalog } = await fetchJson<{ catalog?: Catalog }>(`/api/dshb/sync/peers/${encodeURIComponent(peer.id)}/catalog`)
          return { peer, catalog }
        } catch (error) {
          return { peer, error: error instanceof Error ? error.message : String(error) }
        }
      }))
      if (!disposed) { entries = result; render() }
    } catch {
      if (!disposed) { entries = []; render() }
    }
  }

  const findTree = (): HTMLElement | undefined => {
    for (const tree of Array.from(document.querySelectorAll('[role="tree"]'))) {
      if (tree instanceof HTMLElement && !tree.closest(`[${SECTION_ATTR}]`)) {
        const label = tree.getAttribute('aria-label') ?? ''
        if (!/search|搜索/i.test(label)) return tree
      }
    }
    return undefined
  }

  const mount = (): void => {
    if (disposed) return
    const tree = findTree()
    if (!tree) return
    if (host && host.parentElement === tree) return
    host?.remove()
    host = document.createElement('div')
    host.setAttribute(SECTION_ATTR, '')
    tree.appendChild(host)
    render()
  }

  const schedule = (): void => {
    if (raf !== 0) return
    raf = requestAnimationFrame(() => { raf = 0; mount() })
  }

  const onPeersChanged = (): void => { void load() }
  observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('dshb:sync-peers-changed', onPeersChanged)
  schedule()
  void load()
  timer = setInterval(() => void load(), REFRESH_INTERVAL_MS)

  return () => {
    disposed = true
    observer?.disconnect()
    if (raf !== 0) cancelAnimationFrame(raf)
    if (timer !== undefined) clearInterval(timer)
    window.removeEventListener('dshb:sync-peers-changed', onPeersChanged)
    host?.remove()
    host = undefined
  }
}
