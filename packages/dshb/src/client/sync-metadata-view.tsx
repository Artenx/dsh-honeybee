import { useState, type ReactElement } from 'react'
import type { SyncCatalog, SyncCatalogSession } from '../core/sync/model.js'

function formatSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return '未知大小'
  if (sizeBytes < 1024) return `${sizeBytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = sizeBytes
  let unit = -1
  do {
    size /= 1024
    unit += 1
  } while (size >= 1024 && unit < units.length - 1)
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
}

interface RemoteEventPreview {
  type: string
  seq: number
  time: number
  text: string
}

interface RemoteSessionPreview {
  sessionId: string
  updatedAt: number
  running: boolean
  records: RemoteEventPreview[]
  hasMore: boolean
  error?: string
}

interface PageValue {
  records?: Array<{ type: string; event?: { type: string; seq: number; time: number; data: unknown } }>
  hasMore?: boolean
}

type RemotePageResult = { ok: true; value: PageValue } | { ok: false; error?: { code?: string; message?: string } }

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  try {
    const data = await response.json() as T & { error?: string }
    if (!response.ok) throw new Error(data.error ?? fallback)
    return data
  } catch (error) {
    throw error instanceof Error && error.message ? error : new Error(fallback)
  }
}

function eventText(data: unknown): string {
  if (data === null || typeof data !== 'object') return typeof data === 'string' ? data : ''
  const record = data as Record<string, unknown>
  for (const key of ['text', 'title', 'name', 'summary', 'reason']) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  const json = JSON.stringify(data)
  return json.length > 120 ? `${json.slice(0, 120)}…` : json
}

/**
 * 元数据同步的目录展示：远端节点/工作区/会话清单（含持久化文件大小）。
 * 点击「在远端打开」经本地 DSHB 的远端通道实时读取远端会话内容预览，
 * 指令全程走 DSH Remote 协议，不在本机落盘。
 */
export function SyncMetadataCatalogView(props: { peerId: string; catalog: SyncCatalog; fetchedAt?: string }): ReactElement {
  const [preview, setPreview] = useState<RemoteSessionPreview | undefined>(undefined)
  const [loadingSession, setLoadingSession] = useState<string | undefined>(undefined)

  const sessionsByWorkspace = new Map<string, SyncCatalogSession[]>()
  for (const session of props.catalog.sessions) {
    if (session.deleted) continue
    const key = session.workspaceOrigin
      ? JSON.stringify([session.workspaceOrigin.originInstanceId, session.workspaceOrigin.originEntityId, session.workspaceRemotePath ?? ''])
      : ''
    const list = sessionsByWorkspace.get(key) ?? []
    list.push(session)
    sessionsByWorkspace.set(key, list)
  }

  const openRemoteSession = async (session: SyncCatalogSession): Promise<void> => {
    setLoadingSession(session.sessionId)
    setPreview(undefined)
    try {
      // page 的 throughSeq 需要精确游标：先探测（超大值触发 bad-request 并回报 cursor），再按游标拉取。
      const callPage = async (throughSeq: number): Promise<{ ok: true; value: PageValue } | { ok: false; message: string; cursor?: number }> => {
        const response = await fetch(`/api/dshb/sync/relay/${props.peerId}/call/session/page`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            args: { request: { address: { kind: 'session', sessionId: session.sessionId }, throughSeq, maxMessages: 20 } },
          }),
        })
        const data = await readJsonResponse<{ result?: RemotePageResult }>(response, '读取远端会话失败')
        const result = data.result
        if (!result) throw new Error('远端响应缺少结果信封')
        if (result.ok) return { ok: true, value: result.value }
        const message = result.error?.message ?? '远端会话读取被拒绝'
        const cursor = /past cursor (\d+)/.exec(message)?.[1]
        return { ok: false, message, ...(cursor !== undefined ? { cursor: Number(cursor) } : {}) }
      }
      let attempt = await callPage(Number.MAX_SAFE_INTEGER)
      if (!attempt.ok && attempt.cursor !== undefined) attempt = await callPage(attempt.cursor)
      if (!attempt.ok) throw new Error(attempt.message)
      const value = attempt.value
      setPreview({
        sessionId: session.sessionId,
        updatedAt: Date.now(),
        running: false,
        hasMore: value.hasMore === true,
        records: (value.records ?? []).map((entry) => ({
          type: entry.event?.type ?? entry.type,
          seq: entry.event?.seq ?? 0,
          time: entry.event?.time ?? 0,
          text: eventText(entry.event?.data),
        })),
      })
    } catch (error) {
      setPreview({
        sessionId: session.sessionId,
        updatedAt: Date.now(),
        running: false,
        records: [],
        hasMore: false,
        error: error instanceof Error ? error.message : '读取远端会话失败',
      })
    } finally {
      setLoadingSession(undefined)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 10, fontSize: 12 }}>
      {props.fetchedAt && (
        <div style={{ opacity: 0.5 }}>目录同步于 {new Date(props.fetchedAt).toLocaleString()}</div>
      )}
      <section style={{ display: 'grid', gap: 4 }}>
        <strong style={{ opacity: 0.72 }}>远端工作节点（{props.catalog.nodes.length}）</strong>
        {props.catalog.nodes.length === 0 && <span style={{ opacity: 0.5 }}>目录中没有工作节点</span>}
        {props.catalog.nodes.map((node) => (
          <div key={`${node.origin.originInstanceId}/${node.origin.originEntityId}`} style={{ opacity: 0.82 }}>
            {node.name} <span style={{ opacity: 0.5 }}>({node.type})</span>
          </div>
        ))}
      </section>
      <section style={{ display: 'grid', gap: 6 }}>
        <strong style={{ opacity: 0.72 }}>远端工作区与会话（{props.catalog.workspaces.length} / {props.catalog.sessions.filter((session) => !session.deleted).length}）</strong>
        {props.catalog.workspaces.length === 0 && <span style={{ opacity: 0.5 }}>目录中没有工作区</span>}
        {props.catalog.workspaces.map((workspace) => {
          const key = JSON.stringify([workspace.origin.originInstanceId, workspace.origin.originEntityId, workspace.remotePath])
          const sessions = sessionsByWorkspace.get(key) ?? []
          return (
            <div key={key} style={{ display: 'grid', gap: 5, padding: '4px 0' }}>
              <div style={{ fontWeight: 600, opacity: 0.85 }}>
                {workspace.title || workspace.remotePath}
                <span style={{ fontWeight: 400, opacity: 0.5, marginLeft: 6, overflowWrap: 'anywhere' }}>{workspace.remotePath}</span>
              </div>
              {sessions.length === 0 && <div style={{ opacity: 0.45, marginLeft: 12 }}>暂无可同步会话</div>}
              {sessions.map((session) => (
                <div key={`${session.origin.originInstanceId}/${session.origin.originEntityId}`} style={{ marginLeft: 12, display: 'grid', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <code style={{ fontSize: 11, opacity: 0.7 }} title={session.sessionId}>{session.sessionId.slice(0, 18)}</code>
                    <span style={{ opacity: 0.55 }}>{formatSize(session.sizeBytes)}</span>
                    <button
                      type="button"
                      onClick={() => void openRemoteSession(session)}
                      disabled={loadingSession !== undefined}
                      style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: loadingSession !== undefined ? 'default' : 'pointer' }}
                    >
                      {loadingSession === session.sessionId ? '读取中…' : '在远端打开'}
                    </button>
                  </div>
                  {preview && preview.sessionId === session.sessionId && (
                    <div style={{
                      margin: '2px 0 6px', padding: '8px 10px', borderRadius: 8,
                      border: '1px solid var(--dsw-alias-border-l2)',
                      background: 'var(--dsw-alias-bg-layer-1)', maxHeight: 260, overflowY: 'auto',
                    }}>
                      {preview.error && <div style={{ color: 'var(--dsw-alias-state-error-primary, #f87171)' }}>{preview.error}</div>}
                      {preview.records.length === 0 && !preview.error && (
                        <div style={{ opacity: 0.6 }}>远端未返回事件；实时流式查看需要后续版本的 wss 通道支持。</div>
                      )}
                      {preview.records.map((record) => (
                        <div key={record.seq} style={{ display: 'flex', gap: 8, padding: '2px 0', alignItems: 'baseline' }}>
                          <span style={{ opacity: 0.45, fontSize: 10, whiteSpace: 'nowrap' }}>
                            {new Date(record.time).toLocaleTimeString()} · {record.type}
                          </span>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.text}</span>
                        </div>
                      ))}
                      {preview.hasMore && <div style={{ opacity: 0.45, marginTop: 4 }}>仅显示最近 20 条</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </section>
      <div style={{ opacity: 0.55, lineHeight: 1.5 }}>
        点击「在远端打开」时，本机通过加密通道向远端 DSH 下达只读指令，内容实时显示、不在本机保存。发送消息与实时事件流将在后续版本接入。
      </div>
    </div>
  )
}
