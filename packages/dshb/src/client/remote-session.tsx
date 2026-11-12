import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

type RowActionProps = PropsRuntime<'sidebar.workspaces.session.row.action'>

interface SessionOrigin {
  peerId: string
  remoteSessionId: string
}

interface OriginResponse {
  peerId?: string
  remoteSessionId?: string
}

interface SlotsLike {
  inject(name: string, factory: () => unknown): unknown
  register(spec: Record<string, unknown>, component: unknown): unknown
}

/** 会话行悬停按钮：该会话来自某个同步 peer 时显示「打开远端会话」。 */
function RemoteSessionRowAction({ sessionId }: RowActionProps): ReactElement | null {
  const [origin, setOrigin] = useState<SessionOrigin | undefined>(undefined)
  const [checked, setChecked] = useState(false)
  const [open, setOpen] = useState(false)
  const id = String(sessionId ?? '')

  useEffect(() => {
    let cancelled = false
    setChecked(false)
    setOrigin(undefined)
    if (!id) {
      setChecked(true)
      return undefined
    }
    void fetch(`/api/dshb/sync/session-origin?sessionId=${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as OriginResponse) : undefined))
      .then((body) => {
        if (cancelled) return
        if (body?.peerId && body.remoteSessionId) setOrigin({ peerId: body.peerId, remoteSessionId: body.remoteSessionId })
        setChecked(true)
      })
      .catch(() => {
        if (!cancelled) setChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (!checked || !origin) return null
  return (
    <>
      <button
        type="button"
        data-dshb-remote-session="open"
        aria-label="打开远端会话"
        title="打开远端会话（实时操作远端 DSH）"
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5" />
          <path d="M8 3.5a4.5 4.5 0 0 1 4.5 4.5M8 3.5A4.5 4.5 0 0 0 3.5 8M8 12.5a4.5 4.5 0 0 0 3.2-1.3M8 12.5a4.5 4.5 0 0 1-3.2-1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
      {open ? <RemoteSessionOverlay peerId={origin.peerId} sessionId={origin.remoteSessionId} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

const OVERLAY_STYLE = `
[data-dshb-remote-overlay] { position: fixed; inset: 0; z-index: 2147483000; background: var(--dsh-bg, #0b0d10); display: flex; flex-direction: column; }
[data-dshb-remote-overlay] > header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); font-size: 12px; opacity: .85; }
[data-dshb-remote-overlay] > header button { cursor: pointer; }
[data-dshb-remote-overlay] > iframe { flex: 1; width: 100%; border: 0; background: transparent; }
`

export const REMOTE_CATALOG_PANEL_STYLE = `
[data-dshb-remote-catalog="open"] {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border: none; border-radius: 8px; background: none;
  color: inherit; cursor: pointer; opacity: .7; padding: 0;
}
[data-dshb-remote-catalog="open"]:hover { opacity: 1; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18)); }
[data-dshb-remote-catalog-panel] {
  position: fixed; left: 0; top: 0; bottom: 0; width: min(340px, 92vw); z-index: 2147482900;
  background: var(--dsw-alias-bg-layer-1, #15171b); color: var(--dsw-alias-label-primary, #e8eaed);
  border-right: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08));
  box-shadow: 8px 0 28px rgba(0,0,0,.35); display: flex; flex-direction: column;
  font-size: 13px; overflow: hidden;
}
[data-dshb-remote-catalog-panel] > header {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08)); flex: none;
}
[data-dshb-remote-catalog-panel] > header .title { font-weight: 600; flex: 1; }
[data-dshb-remote-catalog-panel] > header button { cursor: pointer; background: none; border: none; color: inherit; padding: 4px; }
[data-dshb-remote-catalog-body] { flex: 1; overflow-y: auto; padding: 8px 6px 16px; }
[data-dshb-remote-catalog-body] .peer { margin: 6px 4px 12px; }
[data-dshb-remote-catalog-body] .peer-name { font-weight: 600; padding: 4px 8px; display: flex; align-items: center; gap: 6px; }
[data-dshb-remote-catalog-body] .peer-meta { opacity: .55; font-size: 11px; font-weight: 400; }
[data-dshb-remote-catalog-body] .ws { margin: 2px 0 2px 10px; }
[data-dshb-remote-catalog-body] .ws-title { padding: 4px 8px; opacity: .8; display: flex; gap: 6px; align-items: baseline; }
[data-dshb-remote-catalog-body] .ws-path { font-size: 11px; opacity: .5; font-family: ui-monospace, Menlo, Consolas, monospace; }
[data-dshb-remote-catalog-body] .sess {
  display: flex; align-items: center; gap: 8px; width: calc(100% - 18px); margin: 1px 0 1px 18px;
  padding: 5px 8px; border: none; border-radius: 8px; background: none; color: inherit;
  text-align: left; cursor: pointer; font-size: 13px;
}
[data-dshb-remote-catalog-body] .sess:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
[data-dshb-remote-catalog-body] .sess .s-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dshb-remote-catalog-body] .sess .s-size { font-size: 11px; opacity: .45; flex: none; }
[data-dshb-remote-catalog-body] .empty { padding: 8px 12px; opacity: .55; }
[data-dshb-remote-catalog-body] .err { padding: 6px 10px; margin: 4px 8px; border-radius: 8px; background: var(--dsw-alias-state-error-tertiary, rgba(220,60,60,.15)); font-size: 12px; }
[data-dshb-remote-catalog-backdrop] { position: fixed; inset: 0; z-index: 2147482800; background: rgba(0,0,0,.32); }
`

export function RemoteSessionOverlay({ peerId, sessionId, onClose }: { peerId: string; sessionId?: string; onClose: () => void }): ReactElement {
  // sessionId 为远端实例的原始会话 ID：经 hash 传给对端 dshb 的定位引导
  // （remote-session-bootstrap），iframe 落地后自动打开该会话；未传时
  // 打开远端首页（对端旧版/无目标会话场景）。
  const hash = sessionId ? `#dshb-session=${encodeURIComponent(sessionId)}` : ''
  return (
    <div data-dshb-remote-overlay role="dialog" aria-label="远端会话">
      <style>{OVERLAY_STYLE}</style>
      <header>
        <button type="button" aria-label="返回本地会话" title="返回本地会话" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <span>远端会话视图 · 实时操作远端 DSH</span>
        {!sessionId ? <span style={{ opacity: 0.55 }}>若未自动定位，请在页面中选择工作区与会话</span> : null}
      </header>
      <iframe src={`/api/dshb/sync/relay/${encodeURIComponent(peerId)}/app/${hash}`} title="远端会话" />
    </div>
  )
}

/** 注册远端会话入口（侧栏会话行悬停按钮带，位于 pin 之后）。 */
export function installRemoteSessionEntry(ctx: ClientContext): void {
  const slots = (ctx as unknown as { slots?: SlotsLike }).slots
  if (!slots) return
  slots.inject('sidebar.workspaces.session.row.action', () =>
    slots.register({ name: 'sidebar.workspaces.session.row.action', id: 'dshb-remote-session', order: 300 }, RemoteSessionRowAction),
  )
}
