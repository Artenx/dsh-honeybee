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
      {open ? <RemoteSessionOverlay peerId={origin.peerId} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

const OVERLAY_STYLE = `
[data-dshb-remote-overlay] { position: fixed; inset: 0; z-index: 2147483000; background: var(--dsh-bg, #0b0d10); display: flex; flex-direction: column; }
[data-dshb-remote-overlay] > header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); font-size: 12px; opacity: .85; }
[data-dshb-remote-overlay] > header button { cursor: pointer; }
[data-dshb-remote-overlay] > iframe { flex: 1; width: 100%; border: 0; background: transparent; }
`

function RemoteSessionOverlay({ peerId, onClose }: { peerId: string; onClose: () => void }): ReactElement {
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
      </header>
      <iframe src={`/api/dshb/sync/relay/${encodeURIComponent(peerId)}/app/`} title="远端会话" />
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
