import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useState } from 'react'
import {
  buildSyncPeerFormRequest,
  EMPTY_SYNC_PEER_FORM,
  syncPeerFormError,
  toSyncPeerForm,
  type SyncPeerForm,
  type SyncPeerFormView,
} from './sync-peer-form.js'

interface SyncPeerView extends SyncPeerFormView {
  id: string
  hostKeyFingerprint?: string
  progress?: {
    lastRunAt?: string
    lastSuccessAt?: string
    lastRunStatus?: 'running' | 'succeeded' | 'failed'
    lastErrorMessage?: string
    lastResult?: {
      imported: number
      exported: number
      skipped: number
      pendingRemoval: number
      importedSessions: number
      exportedSessions: number
      skippedSessions: number
    }
  }
}

interface SyncSessionArchiveView {
  branchId: string
  originInstanceId: string
  originSessionId: string
  localSessionId: string
  archivedAt: string
}

function shortenSessionId(id: string): string {
  const suffix = id.replace(/^session-sync-/, '')
  return `${suffix.slice(0, 8)}…${suffix.slice(-4)}`
}

function copyText(value: string): void {
  void navigator.clipboard?.writeText(value)
}

function resultSummary(peer: SyncPeerView): string | undefined {
  const result = peer.progress?.lastResult
  if (!result) return undefined
  return `节点导入 ${result.imported}、导出 ${result.exported}；会话导入 ${result.importedSessions}、导出 ${result.exportedSessions}；跳过 ${result.skipped}`
}

interface HostKeyChallenge {
  code: 'host-key-untrusted' | 'host-key-changed'
  fingerprint: string
  expected?: string
}

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    const message = response.status === 404
      ? '同步 API 尚未加载，请重启 DSH 服务后重试'
      : `${fallback}：服务器返回了无效响应（HTTP ${response.status}）`
    throw new Error(message)
  }
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0 10px',
  minHeight: 34,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: 'inherit',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
}

const btn: CSSProperties = {
  boxSizing: 'border-box',
  height: 32,
  padding: '0 12px',
  borderRadius: 8,
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const primaryBtn: CSSProperties = {
  ...btn,
  border: 'none',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}

const secondaryBtn: CSSProperties = {
  ...btn,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
}

const dangerBtn: CSSProperties = {
  ...btn,
  border: '1px solid var(--dsw-alias-state-error-primary, #f87171)',
  background: 'transparent',
  color: 'var(--dsw-alias-state-error-primary, #f87171)',
}

const label: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  opacity: 0.75,
  color: 'var(--dsw-alias-label-primary)',
  marginBottom: 4,
  display: 'block',
}

const field: CSSProperties = {
  marginBottom: 14,
}

const hint: CSSProperties = {
  fontSize: 11,
  opacity: 0.5,
  color: 'var(--dsw-alias-label-primary)',
  marginTop: 3,
}

const groupTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  opacity: 0.45,
  marginBottom: 12,
  paddingBottom: 6,
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

const required: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary, #f87171)',
}

export function SyncPeersSection(): ReactElement {
  const [reloadKey, setReloadKey] = useState(0)
  const [peers, setPeers] = useState<SyncPeerView[]>([])
  const [archives, setArchives] = useState<SyncSessionArchiveView[]>([])
  const [selectedId, setSelectedId] = useState<string | 'new'>('new')
  const [form, setForm] = useState<SyncPeerForm>(EMPTY_SYNC_PEER_FORM)
  const [busy, setBusy] = useState(false)
  const [probing, setProbing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState<Notice>(undefined)
  const [hostKeyChallenge, setHostKeyChallenge] = useState<HostKeyChallenge | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/dshb/sync/peers')
        const data = await readJsonResponse<{ peers?: SyncPeerView[]; error?: string }>(response, '读取同步节点失败')
        if (!response.ok) throw new Error(data.error ?? '读取同步节点失败')
        if (!cancelled) setPeers(data.peers ?? [])
        const archiveResponse = await fetch('/api/dshb/sync/archives')
        const archiveData = await readJsonResponse<{ archives?: SyncSessionArchiveView[]; error?: string }>(archiveResponse, '读取会话归档失败')
        if (!archiveResponse.ok) throw new Error(archiveData.error ?? '读取会话归档失败')
        if (!cancelled) setArchives(archiveData.archives ?? [])
      } catch (error) {
        if (!cancelled) setNotice({ kind: 'error', text: error instanceof Error ? error.message : '读取同步节点失败' })
      }
    })()
    return () => { cancelled = true }
  }, [reloadKey])

  useEffect(() => {
    const interval = syncing || peers.some((peer) => peer.progress?.lastRunStatus === 'running') ? 3_000 : 15_000
    const timer = setInterval(() => setReloadKey((key) => key + 1), interval)
    return () => clearInterval(timer)
  }, [peers, syncing])

  const reload = (): void => setReloadKey((key) => key + 1)
  const selectedPeer = selectedId === 'new' ? undefined : peers.find((peer) => peer.id === selectedId)
  const runningCount = peers.filter((peer) => peer.progress?.lastRunStatus === 'running').length

  const statusLabel = (peer: SyncPeerView): string => {
    const status = peer.progress?.lastRunStatus
    if (!peer.enabled) return '已停用'
    if (status === 'running') return '同步中'
    if (status === 'failed') return '上次失败'
    if (status === 'succeeded') return '上次成功'
    return '尚未同步'
  }

  const select = (id: string | 'new'): void => {
    setSelectedId(id)
    setNotice(undefined)
    setHostKeyChallenge(undefined)
    const peer = id === 'new' ? undefined : peers.find((item) => item.id === id)
    setForm(peer ? toSyncPeerForm(peer) : EMPTY_SYNC_PEER_FORM)
  }

  const save = async (): Promise<void> => {
    const formError = syncPeerFormError(form, selectedPeer?.hasSecret)
    if (formError) {
      setNotice({ kind: 'error', text: formError })
      return
    }
    const request = buildSyncPeerFormRequest(form)
    const payload = { ...request.fields, secrets: request.secrets }
    setBusy(true)
    try {
      const response = await fetch(selectedId === 'new' ? '/api/dshb/sync/peers' : `/api/dshb/sync/peers/${selectedId}`, {
        method: selectedId === 'new' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await readJsonResponse<{ ok?: boolean; peer?: SyncPeerView; error?: string }>(response, '保存同步节点失败')
      if (!response.ok || !data.ok || !data.peer) throw new Error(data.error ?? '保存同步节点失败')
      setNotice({ kind: 'ok', text: selectedId === 'new' ? '同步节点已创建' : '同步节点已保存' })
      setHostKeyChallenge(undefined)
      setSelectedId(data.peer.id)
      setForm(toSyncPeerForm(data.peer))
      reload()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '保存同步节点失败' })
    } finally {
      setBusy(false)
    }
  }

  const probe = async (): Promise<void> => {
    if (selectedId === 'new') return
    setProbing(true)
    setHostKeyChallenge(undefined)
    try {
      const response = await fetch(`/api/dshb/sync/peers/${selectedId}/probe`, { method: 'POST' })
      const data = await readJsonResponse<{
        ok?: boolean
        code?: string
        fingerprint?: string
        expected?: string
        handshake?: { instanceId?: string }
        error?: string
      }>(response, 'SSH 测试失败')
      if (data.code === 'host-key-untrusted' || data.code === 'host-key-changed') {
        setHostKeyChallenge({
          code: data.code,
          fingerprint: data.fingerprint ?? '',
          ...(data.expected ? { expected: data.expected } : {}),
        })
        return
      }
      if (!response.ok || !data.ok) throw new Error(data.error ?? 'SSH 测试失败')
      setNotice({ kind: 'ok', text: `SSH 和 DSHB 握手成功（${data.handshake?.instanceId ?? '远端实例'}）` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'SSH 测试失败' })
    } finally {
      setProbing(false)
    }
  }

  const trustObservedHostKey = async (): Promise<void> => {
    if (selectedId === 'new' || !hostKeyChallenge) return
    const confirmation = hostKeyChallenge.code === 'host-key-changed'
      ? `远端 SSH 主机指纹已变化。\n当前保存：${hostKeyChallenge.expected}\n本次观察：${hostKeyChallenge.fingerprint}\n确认信任新指纹？`
      : `首次连接观察到 SSH 主机指纹：\n${hostKeyChallenge.fingerprint}\n请核对后确认信任。`
    if (!window.confirm(confirmation)) return
    setProbing(true)
    try {
      const response = await fetch(`/api/dshb/sync/peers/${selectedId}/trust-host-key`, { method: 'POST' })
      const data = await readJsonResponse<{ ok?: boolean; error?: string; peer?: SyncPeerView }>(response, '保存 SSH 主机信任失败')
      if (!response.ok || !data.ok || !data.peer) throw new Error(data.error ?? '保存 SSH 主机信任失败')
      setHostKeyChallenge(undefined)
      setForm(toSyncPeerForm(data.peer))
      reload()
      setNotice({ kind: 'ok', text: '主机指纹已保存，正在重新验证连接' })
      await probe()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '保存 SSH 主机信任失败' })
    } finally {
      setProbing(false)
    }
  }

  const runSync = async (): Promise<void> => {
    if (selectedId === 'new' || !selectedPeer?.enabled) return
    setSyncing(true)
    try {
      const response = await fetch(`/api/dshb/sync/peers/${selectedId}/run`, { method: 'POST' })
      const data = await readJsonResponse<{
        ok?: boolean
        accepted?: boolean
        error?: string
      }>(response, '同步失败')
      if (!response.ok || !data.ok || !data.accepted) throw new Error(data.error ?? '同步失败')
      const startedAt = new Date().toISOString()
      setPeers((current) => current.map((peer) => peer.id === selectedId ? {
        ...peer,
        progress: { ...peer.progress, lastRunAt: startedAt, lastRunStatus: 'running' },
      } : peer))
      setNotice({ kind: 'ok', text: '同步作业已启动，状态会自动更新' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '同步失败' })
    } finally {
      setSyncing(false)
    }
  }

  const restoreArchive = async (branchId: string): Promise<void> => {
    const archive = archives.find((entry) => entry.branchId === branchId)
    if (!archive || !window.confirm(`恢复会话 ${archive.originSessionId} 的归档版本？当前版本将保留在归档中。`)) return
    setBusy(true)
    try {
      const response = await fetch(`/api/dshb/sync/archives/${branchId}/restore`, { method: 'POST' })
      const data = await readJsonResponse<{ ok?: boolean; error?: string }>(response, '恢复会话归档失败')
      if (!response.ok || !data.ok) throw new Error(data.error ?? '恢复会话归档失败')
      setNotice({ kind: 'ok', text: '会话归档已恢复为当前版本' })
      reload()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '恢复会话归档失败' })
    } finally {
      setBusy(false)
    }
  }

  const progressLabel = (peer: SyncPeerView): string => {
    if (peer.progress?.lastRunStatus === 'running') return '同步中'
    if (peer.progress?.lastRunStatus === 'failed') return `上次失败：${peer.progress.lastErrorMessage ?? '同步失败'}`
    if (peer.progress?.lastSuccessAt) return `上次成功：${new Date(peer.progress.lastSuccessAt).toLocaleString()}`
    return '尚未同步'
  }

  const remove = async (): Promise<void> => {
    if (selectedId === 'new' || !window.confirm('删除此同步节点及其连接凭据？')) return
    setBusy(true)
    try {
      const response = await fetch(`/api/dshb/sync/peers/${selectedId}`, { method: 'DELETE' })
      const data = await readJsonResponse<{ ok?: boolean; error?: string }>(response, '删除同步节点失败')
      if (!response.ok || !data.ok) throw new Error(data.error ?? '删除同步节点失败')
      setNotice({ kind: 'ok', text: '同步节点已删除' })
      setSelectedId('new')
      setForm(EMPTY_SYNC_PEER_FORM)
      reload()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '删除同步节点失败' })
    } finally {
      setBusy(false)
    }
  }

  const isNew = selectedId === 'new'
  const syncInProgress = syncing || selectedPeer?.progress?.lastRunStatus === 'running'
  const selectedSummary = selectedPeer ? resultSummary(selectedPeer) : undefined

  return (
    <>
      <style>{`
        .dshb-sync-peer-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l2)}
        .dshb-sync-peer-tab{padding:5px 12px;border-radius:16px;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);white-space:nowrap;flex-shrink:0}
        .dshb-sync-peer-tab.active{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
        .dshb-sync-peer-tab:hover:not(.active){background:var(--dsw-alias-interactive-bg-hover)}
        .dshb-sync-peer-add{width:28px;height:28px;padding:0;border-radius:50%;font-size:16px;line-height:1;opacity:.65}
        .dshb-sync-peer-add:hover{opacity:1}
        .dshb-sync-peer-status{font-size:11px;opacity:.6;margin-top:2px;display:block}
        .dshb-sync-peer-tab{max-width:220px;overflow:hidden;text-overflow:ellipsis}
        .dshb-sync-peer-tab.running{border-color:var(--dsw-alias-button-primary-fill)}
        .dshb-sync-peer-tab.failed{border-color:var(--dsw-alias-state-error-primary, #f87171)}
        .dshb-sync-peer-add{width:28px;height:28px;padding:0;border-radius:50%;font-size:16px;line-height:1;opacity:.65}
        .dshb-sync-peer-add:hover{opacity:1}
        .dshb-sync-peer-status{font-size:11px;opacity:.6;margin-top:2px;display:block}
        .dshb-sync-two-col{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
        @media(max-width:600px){.dshb-sync-two-col{grid-template-columns:1fr}}

      `}</style>

      {/* 节点切换标签页 */}
      <div className="dshb-sync-peer-tabs">
        <button
          type="button"
          className="dshb-sync-peer-tab dshb-sync-peer-add"
          aria-label="新增同步节点"
          title="新增同步节点"
          onClick={() => select('new')}
        >
          +
        </button>
        {peers.map((peer) => (
          <button
            key={peer.id}
            type="button"
            className={`dshb-sync-peer-tab${selectedId === peer.id ? ' active' : ''}${peer.progress?.lastRunStatus === 'running' ? ' running' : ''}${peer.progress?.lastRunStatus === 'failed' ? ' failed' : ''}`}
            onClick={() => select(peer.id)}
            title={`${peer.name} · ${statusLabel(peer)}`}
            aria-label={`同步节点 ${peer.name}，${statusLabel(peer)}`}
          >
            {peer.name}
            <span className="dshb-sync-peer-status">{statusLabel(peer)}</span>
          </button>
        ))}
        {runningCount > 0 && <span style={{ fontSize: 11, alignSelf: 'center', opacity: 0.65 }}>{runningCount} 个同步作业进行中</span>}
        {peers.length === 0 && (
          <span style={{ fontSize: 12, opacity: 0.5, alignSelf: 'center' }}>点击“+”添加第一个同步节点</span>
        )}
      </div>

        {/* 表单 */}
        {selectedPeer && (
          <div role="status" style={{
            maxWidth: 560, marginBottom: 16, padding: '12px 14px',
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
            background: 'var(--dsw-alias-bg-layer-1)', fontSize: 12,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <strong>{progressLabel(selectedPeer)}</strong>
              <button type="button" onClick={reload} style={{ ...secondaryBtn, height: 26, fontSize: 11 }}>刷新</button>
            </div>
            {selectedSummary && <div style={{ marginTop: 6, opacity: 0.72, lineHeight: 1.55 }}>{selectedSummary}</div>}
            {selectedPeer.progress?.lastErrorMessage && <div style={{ marginTop: 6, color: 'var(--dsw-alias-state-error-primary, #f87171)', lineHeight: 1.55 }}>{selectedPeer.progress.lastErrorMessage}</div>}
            {syncInProgress && <div style={{ marginTop: 6, opacity: 0.6 }}>大工作区或大量会话可能需要数分钟，页面每 3 秒更新进度。</div>}
          </div>
        )}
        <div style={{ maxWidth: 560 }}>

        {/* 连接信息 */}
        <div style={groupTitle}>连接信息</div>

        <div style={field}>
          <span style={label}>节点名称 <span style={required}>*</span></span>
          <input style={inputStyle} value={form.name} placeholder="例如：生产服务器"
            onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} />
        </div>

        <div className="dshb-sync-two-col">
          <div style={field}>
            <span style={label}>SSH 主机 <span style={required}>*</span></span>
            <input style={inputStyle} value={form.host} placeholder="sync.example.com"
              onChange={(e) => setForm((c) => ({ ...c, host: e.target.value }))} />
          </div>
          <div style={field}>
            <span style={label}>SSH 端口 <span style={required}>*</span></span>
            <input style={inputStyle} inputMode="numeric" value={form.port} placeholder="22"
              onChange={(e) => setForm((c) => ({ ...c, port: e.target.value }))} />
          </div>
        </div>

        <div style={field}>
          <span style={label}>SSH 系统账号 <span style={required}>*</span></span>
          <input style={inputStyle} value={form.username} placeholder="root"
            onChange={(e) => setForm((c) => ({ ...c, username: e.target.value }))} />
        </div>

        {/* 认证方式 */}
        <div style={{ ...groupTitle, marginTop: 20 }}>认证方式</div>

        <div style={field}>
          <span style={label}>认证类型</span>
          <select style={inputStyle} value={form.authKind}
            onChange={(e) => setForm((c) => ({ ...c, authKind: e.target.value as SyncPeerForm['authKind'] }))}>
            <option value="password">密码</option>
            <option value="key">私钥</option>
          </select>
        </div>

        {form.authKind === 'password' ? (
          <div style={field}>
            <span style={label}>
              SSH 密码
              {selectedPeer?.hasSecret.hasPassword && <span style={{ fontWeight: 400, opacity: 0.55 }}>（已保存，留空保持不变）</span>}
            </span>
            <input style={inputStyle} type="password" autoComplete="new-password" value={form.password}
              placeholder={selectedPeer?.hasSecret.hasPassword ? '••••••••' : ''}
              onChange={(e) => setForm((c) => ({ ...c, password: e.target.value }))} />
          </div>
        ) : (
          <>
            <div style={field}>
              <span style={label}>
                私钥内容
                {selectedPeer?.hasSecret.hasKey && <span style={{ fontWeight: 400, opacity: 0.55 }}>（已保存，留空保持不变）</span>}
              </span>
              <textarea
                style={{ ...inputStyle, minHeight: 100, padding: '10px', resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                value={form.privateKey}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                onChange={(e) => setForm((c) => ({ ...c, privateKey: e.target.value }))}
              />
            </div>
            <div style={field}>
              <span style={label}>
                私钥 passphrase
                <span style={{ fontWeight: 400, opacity: 0.55 }}>
                  {selectedPeer?.hasSecret.hasPassphrase ? '（已保存，留空保持不变）' : '（可选）'}
                </span>
              </span>
              <input style={inputStyle} type="password" autoComplete="new-password" value={form.passphrase}
                onChange={(e) => setForm((c) => ({ ...c, passphrase: e.target.value }))} />
            </div>
          </>
        )}

        {/* 远端配置 */}
        <div style={{ ...groupTitle, marginTop: 20 }}>远端配置</div>

        <div style={field}>
          <span style={label}>远端 DSH_HOME</span>
          <input style={inputStyle} value={form.remoteDshHome} placeholder="默认使用 SSH 账号的 ~/.dsh"
            onChange={(e) => setForm((c) => ({ ...c, remoteDshHome: e.target.value }))} />
          <div style={hint}>远端 DSH 数据目录，留空使用默认路径</div>
        </div>

        <div className="dshb-sync-two-col">
          <div style={field}>
            <span style={label}>远端 profile</span>
            <input style={inputStyle} value={form.remoteProfile} placeholder="web"
              onChange={(e) => setForm((c) => ({ ...c, remoteProfile: e.target.value }))} />
          </div>
          <div style={field}>
            <span style={label}>远端 Web 端口</span>
            <input style={inputStyle} inputMode="numeric" value={form.remoteWebPort} placeholder="3080"
              onChange={(e) => setForm((c) => ({ ...c, remoteWebPort: e.target.value }))} />
            <div style={hint}>留空使用默认 3080</div>
          </div>
        </div>

        {/* 同步策略 */}
        <div style={{ ...groupTitle, marginTop: 20 }}>同步策略</div>

        <div className="dshb-sync-two-col">
          <div style={field}>
            <span style={label}>同步方向</span>
            <select style={inputStyle} value={form.direction}
              onChange={(e) => setForm((c) => ({ ...c, direction: e.target.value as SyncPeerForm['direction'] }))}>
              <option value="pull">单向拉取到本机</option>
              <option value="bidirectional">双向同步</option>
            </select>
          </div>
          <div style={field}>
            <span style={label}>同步时机</span>
            <select style={inputStyle} value={form.schedule}
              onChange={(e) => setForm((c) => ({ ...c, schedule: e.target.value as SyncPeerForm['schedule'] }))}>
              <option value="manual">手动</option>
              <option value="every-5m">每 5 分钟</option>
            </select>
          </div>
        </div>

        <div style={{ ...field, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.syncSessions} style={{ marginTop: 2 }}
              onChange={(e) => setForm((c) => ({ ...c, syncSessions: e.target.checked }))} />
            <span>
              <span style={{ fontSize: 13 }}>同步工作区会话</span>
              <span style={{ display: 'block', fontSize: 11, opacity: 0.5, marginTop: 2 }}>
                覆盖已绑定 SSH 或 Docker 远程节点的工作区，保留冲突分支供恢复
              </span>
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.enabled}
              onChange={(e) => setForm((c) => ({ ...c, enabled: e.target.checked }))} />
            <span style={{ fontSize: 13 }}>启用此同步节点</span>
          </label>
        </div>

        {/* 主机指纹 */}
        {selectedPeer?.hostKeyFingerprint && (
          <div style={field}>
            <span style={label}>已信任 SSH 主机指纹</span>
            <code style={{ fontSize: 11, opacity: 0.6, overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
              {selectedPeer.hostKeyFingerprint}
            </code>
          </div>
        )}

        {/* 指纹确认 */}
        {hostKeyChallenge && (
          <div style={{
            ...field,
            padding: '12px 14px',
            border: '1px solid var(--dsw-alias-state-warn-label, #f59e0b)',
            borderRadius: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 12,
          }}>
            <strong>{hostKeyChallenge.code === 'host-key-changed' ? '主机指纹发生变化' : '首次连接需要确认主机身份'}</strong>
            {hostKeyChallenge.expected && (
              <div style={{ overflowWrap: 'anywhere' }}>已保存：<code>{hostKeyChallenge.expected}</code></div>
            )}
            <div style={{ overflowWrap: 'anywhere' }}>本次观察：<code>{hostKeyChallenge.fingerprint}</code></div>
            <button type="button" onClick={() => void trustObservedHostKey()} disabled={busy || probing}
              style={{ ...secondaryBtn, alignSelf: 'flex-start', marginTop: 4 }}>
              信任本次观察的指纹
            </button>
          </div>
        )}

        {/* 通知 */}
        {notice && (
          <div style={{
            ...field,
            padding: '10px 14px',
            borderRadius: 8,
            fontSize: 13,
            background: notice.kind === 'ok'
              ? 'var(--dsw-alias-state-success-bg, rgba(34,197,94,.1))'
              : 'var(--dsw-alias-state-error-bg, rgba(248,113,113,.1))',
            color: notice.kind === 'ok'
              ? 'var(--dsw-alias-state-success-primary, #22c55e)'
              : 'var(--dsw-alias-state-error-primary, #f87171)',
          }}>
            {notice.text}
          </div>
        )}

        {/* 操作按钮 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4, marginBottom: 16 }}>
          <button type="button" onClick={() => void save()} disabled={busy} style={primaryBtn}>
            {busy ? '保存中…' : isNew ? '创建同步节点' : '保存同步节点'}
          </button>
          {!isNew && (
            <button type="button" onClick={() => void probe()} disabled={busy || probing} style={secondaryBtn}>
              {probing ? '测试中…' : '测试 SSH 握手'}
            </button>
          )}
          {!isNew && (
            <button type="button" onClick={() => void runSync()} disabled={busy || probing || syncInProgress || !selectedPeer?.enabled} style={secondaryBtn}>
              {syncInProgress ? '同步中…' : '立即同步'}
            </button>
          )}
          {!isNew && (
            <button type="button" onClick={() => void remove()} disabled={busy} style={dangerBtn}>
              删除
            </button>
          )}
        </div>

        <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 24 }}>
          节点与会话数据通过 SSH 执行通道传输；会话附件与 spill 对象随 session bundle 一并校验。
        </div>

      </div>

      {/* 会话冲突归档 */}
      <div style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 16, maxWidth: 560 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, opacity: 0.7 }}>会话冲突归档</h3>
        <div style={{ fontSize: 11, opacity: 0.55, lineHeight: 1.55, marginBottom: 12 }}>
          冲突的旧版本会保留在这里；恢复版本后，原当前版本也会进入归档。
        </div>
        {archives.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.5 }}>暂无待恢复的会话分支</div>
        ) : (
          archives.map((archive) => (
            <div key={archive.branchId} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 12px',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 8,
              marginBottom: 8,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <code title={archive.originSessionId}>{shortenSessionId(archive.originSessionId)}</code>
                  <button type="button" title="复制完整会话 ID" aria-label="复制完整会话 ID" onClick={() => copyText(archive.originSessionId)} style={{ ...secondaryBtn, height: 22, padding: '0 6px', fontSize: 10 }}>复制 ID</button>
                </div>
                <div style={{ fontSize: 11, opacity: 0.5, marginTop: 3 }}>归档于 {new Date(archive.archivedAt).toLocaleString()}</div>
              </div>
              <button type="button" onClick={() => void restoreArchive(archive.branchId)} disabled={busy} style={secondaryBtn}>
                恢复版本
              </button>
            </div>
          ))
        )}
      </div>
    </>
  )
}
