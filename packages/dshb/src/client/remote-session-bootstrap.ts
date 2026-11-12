import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * 远端会话定位引导：本地端经 relay 打开远端 DSH 时通过
 * 「#dshb-session=<远端会话ID>」传递目标会话；本模块在对端
 * （同样安装了 dshb）的客户端里读取该 hash，等会话列表就绪且
 * 包含目标会话后调用 uiWorkspace.openSession 直接落到该会话。
 *
 * 关键时序：openSession → sessions.retain → resolveTarget 要求会话
 * 已在 sessions 列表/摘要中，否则抛「unknown session」。会话列表由
 * WebSocket 连接建立后的 refreshList 全量拉取（relay 首次 SSH 建链
 * 可能较慢），因此事件驱动：订阅 sessions.list 的 ready 边沿并主动
 * refresh，而不是固定次数盲重试。
 *
 * 服务访问：cordis 客户端经 Proxy 属性访问服务（ctx.sessions /
 * ctx.uiWorkspace），二者都必须在插件 inject 列表中声明，否则抛
 * 「cannot get property without inject」。
 *
 * hash 而非 query：避免进入子资源请求 URL 与缓存键；打开成功后
 * replaceState 清理，刷新不会重复触发。对端未装/旧版本 dshb 时
 * 本模块不存在，行为退化为打开首页，与既有版本一致。
 */

const SESSION_HASH_PATTERN = /^#dshb-session=([A-Za-z0-9-]{1,128})$/
const READY_WAIT_TIMEOUT_MS = 60_000

interface SessionListSnapshotLike {
  phase?: string
  byId?: Record<string, unknown>
  items?: readonly { sessionId?: string }[]
}

interface SessionsLike {
  list: {
    getSnapshot(): SessionListSnapshotLike
    subscribe(listener: () => void): () => void
  }
  refresh?(): Promise<unknown> | void
}

interface UiWorkspaceLike {
  openSession(sessionId: string): void
}

function readTargetSessionId(): string | undefined {
  const match = SESSION_HASH_PATTERN.exec(window.location.hash)
  if (!match) return undefined
  return decodeURIComponent(match[1])
}

function clearHash(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
}

function snapshotHasSession(snapshot: SessionListSnapshotLike, sessionId: string): boolean {
  if (snapshot.byId && sessionId in snapshot.byId) return true
  return (snapshot.items ?? []).some((item) => item.sessionId === sessionId)
}

export function openRemoteSessionFromHash(ctx: ClientContext): void {
  const sessionId = readTargetSessionId()
  if (!sessionId) return

  const service = (name: string): unknown => (ctx as unknown as Record<string, unknown>)[name]

  let settled = false
  let unsubscribe: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  const finish = (opened: boolean): void => {
    if (settled) return
    settled = true
    unsubscribe?.()
    if (timeout !== undefined) clearTimeout(timeout)
    if (opened) clearHash()
  }

  const tryOpen = (): boolean => {
    try {
      const sessions = service('sessions') as SessionsLike | undefined
      const ui = service('uiWorkspace') as UiWorkspaceLike | undefined
      if (!sessions?.list || !ui || typeof ui.openSession !== 'function') return false
      const snapshot = sessions.list.getSnapshot()
      if (snapshot.phase !== 'ready') return false
      if (!snapshotHasSession(snapshot, sessionId)) {
        // 列表已就绪但无此会话（已删除/归档/非本实例原生）：放弃，保留 hash 供排查
        finish(false)
        return true
      }
      ui.openSession(sessionId)
      finish(true)
      return true
    } catch {
      return false
    }
  }

  const arm = (): void => {
    if (settled) return
    if (tryOpen()) return
    try {
      const sessions = service('sessions') as SessionsLike | undefined
      if (sessions?.list?.subscribe && !unsubscribe) {
        unsubscribe = sessions.list.subscribe(() => { void tryOpen() })
      }
      // 主动触发一次全量拉取，加速 ready（连接尚未建立时 refresh 会排队/失败，订阅兜底）
      if (typeof sessions?.refresh === 'function') {
        try { void sessions.refresh() } catch {}
      }
    } catch {}
  }

  // inject 保证服务激活后才 apply，但会话列表 ready 是异步的：先尝试，未就绪则订阅 + 短轮询兜底
  let attempts = 0
  const poll = (): void => {
    if (settled) return
    attempts += 1
    arm()
    if (!settled && !unsubscribe && attempts < 120) window.setTimeout(poll, 500)
  }
  timeout = setTimeout(() => finish(false), READY_WAIT_TIMEOUT_MS)
  window.setTimeout(poll, 300)
}
