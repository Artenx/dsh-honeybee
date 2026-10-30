import type { CSSProperties, ReactElement } from 'react'
import { useState } from 'react'

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

const fieldStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 36,
  padding: '8px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
}

const buttonStyle: CSSProperties = {
  minHeight: 36,
  padding: '0 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 18,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  cursor: 'pointer',
}

function passwordError(value: string): string | undefined {
  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes < 8 || bytes > 1024) return '包密码需为 8-1024 个 UTF-8 字节'
  if (value.includes('\0')) return '包密码包含无效字符'
  return undefined
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const data = await response.json() as { error?: string }
    return new Error(data.error ?? fallback)
  } catch {
    return new Error(fallback)
  }
}

export function SyncOfflineSection(props: { onImported?: () => void }): ReactElement {
  const [exportPassword, setExportPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [includeSessions, setIncludeSessions] = useState(false)
  const [importPassword, setImportPassword] = useState('')
  const [file, setFile] = useState<File | undefined>(undefined)
  const [fileInputKey, setFileInputKey] = useState(0)
  const [busy, setBusy] = useState<'export' | 'import' | undefined>(undefined)
  const [status, setStatus] = useState('')
  const [notice, setNotice] = useState<Notice>(undefined)

  const exportArchive = async (): Promise<void> => {
    const error = passwordError(exportPassword)
    if (error) { setNotice({ kind: 'error', text: error }); return }
    if (exportPassword !== confirmPassword) { setNotice({ kind: 'error', text: '两次输入的包密码不一致' }); return }
    setBusy('export')
    setStatus('正在生成并加密归档…')
    setNotice(undefined)
    try {
      const response = await fetch('/api/dshb/sync/offline/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: exportPassword, includeSessions }),
      })
      if (!response.ok) throw await responseError(response, '导出离线配置失败')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `dshb-sync-${new Date().toISOString().slice(0, 10)}.dshb-sync`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setExportPassword('')
      setConfirmPassword('')
      setNotice({ kind: 'ok', text: '加密配置包已生成并下载' })
    } catch (caught) {
      setNotice({ kind: 'error', text: caught instanceof Error ? caught.message : '导出离线配置失败' })
    } finally {
      setBusy(undefined)
      setStatus('')
      setExportPassword('')
      setConfirmPassword('')
    }
  }

  const importArchive = async (): Promise<void> => {
    const error = passwordError(importPassword)
    if (error) { setNotice({ kind: 'error', text: error }); return }
    if (!file) { setNotice({ kind: 'error', text: '请选择 .dshb-sync 文件' }); return }
    if (file.size > 128 * 1024 * 1024) { setNotice({ kind: 'error', text: '归档文件超过 128 MiB 上限' }); return }
    setBusy('import')
    setStatus('正在准备安全上传…')
    setNotice(undefined)
    try {
      const tokenResponse = await fetch('/api/dshb/sync/offline/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: importPassword }),
      })
      const tokenData = await tokenResponse.json() as { ok?: boolean; uploadToken?: string; error?: string }
      if (!tokenResponse.ok || !tokenData.ok || !tokenData.uploadToken) throw new Error(tokenData.error ?? '准备离线导入失败')

      setStatus('正在上传、解密并校验归档…')
      const response = await fetch(`/api/dshb/sync/offline/import/${tokenData.uploadToken}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      if (!response.ok) throw await responseError(response, '导入离线配置失败')
      const data = await response.json() as {
        ok?: boolean
        result?: { nodes?: { created: number; updated: number; deleted: number; skipped: number }; sessions?: { created: number; updated: number; archived: number; deleted: number; skipped: number } }
        error?: string
      }
      if (!data.ok || !data.result) throw new Error(data.error ?? '导入离线配置失败')
      const nodes = data.result.nodes
      const sessions = data.result.sessions
      setNotice({
        kind: 'ok',
        text: `导入完成：节点新增 ${nodes?.created ?? 0}、更新 ${nodes?.updated ?? 0}、删除 ${nodes?.deleted ?? 0}${sessions ? `；会话新增 ${sessions.created}、更新 ${sessions.updated}、归档 ${sessions.archived}` : ''}`,
      })
      setImportPassword('')
      setFile(undefined)
      setFileInputKey((key) => key + 1)
      props.onImported?.()
    } catch (caught) {
      setNotice({ kind: 'error', text: caught instanceof Error ? caught.message : '导入离线配置失败' })
    } finally {
      setBusy(undefined)
      setStatus('')
      setImportPassword('')
    }
  }

  return (
    <div style={{ flex: 1, minWidth: 0, width: '100%', maxWidth: 900 }}>
      <style>{`.dshb-sync-offline-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px;align-items:start}.dshb-sync-offline-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;background:var(--dsw-alias-bg-layer-1);min-width:0}.dshb-sync-offline-hint{font-size:12px;line-height:1.5;opacity:.68;margin:0 0 12px}.dshb-sync-offline-actions{margin-top:2px}.dshb-sync-offline-actions button{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dshb-sync-offline-file{max-width:100%;width:100%;box-sizing:border-box;font-size:12px;line-height:1.5}.dshb-sync-offline-file::file-selector-button{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media(max-width:600px){.dshb-sync-offline-grid{grid-template-columns:1fr;gap:12px}.dshb-sync-offline-actions{display:flex}.dshb-sync-offline-actions button{width:100%}}`}</style>
      <div style={{ marginBottom: 14, fontSize: 13, lineHeight: 1.55, opacity: 0.75, maxWidth: '72ch' }}>
        通过加密文件在实例间迁移远程节点和可选会话，适用于网络隔离或备份恢复。
      </div>
      <div className="dshb-sync-offline-grid">
        <section className="dshb-sync-offline-card" style={{ borderTop: '3px solid var(--dsw-alias-button-primary-fill)' }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>导出加密配置包</h3>
          <p className="dshb-sync-offline-hint">
            默认导出远程节点配置与凭据；勾选后可包含可映射的工作区会话。同步 peer 凭据和本地节点不会进入导出包。
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              包密码
              <input style={fieldStyle} type="password" autoComplete="new-password" value={exportPassword} disabled={busy !== undefined} onChange={(event) => setExportPassword(event.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              确认包密码
              <input style={fieldStyle} type="password" autoComplete="new-password" value={confirmPassword} disabled={busy !== undefined} onChange={(event) => setConfirmPassword(event.target.value)} />
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={includeSessions} disabled={busy !== undefined} onChange={(event) => setIncludeSessions(event.target.checked)} />
              <span>包含可映射的远程工作区会话<span style={{ display: 'block', fontSize: 11, opacity: 0.65, marginTop: 3 }}>包含会话日志与附件，导出文件可能较大。</span></span>
            </label>
            <div className="dshb-sync-offline-actions"><button type="button" style={buttonStyle} disabled={busy !== undefined} onClick={() => void exportArchive()}>{busy === 'export' ? '正在导出…' : '导出 .dshb-sync'}</button></div>
          </div>
        </section>

        <section className="dshb-sync-offline-card" style={{ borderTop: '3px solid var(--dsw-alias-border-l2)' }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>导入加密配置包</h3>
          <p className="dshb-sync-offline-hint">
            先验证密码、格式、摘要、路径和空间，再应用配置。同一来源的重复导入会按身份去重。
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              归档文件
              <input className="dshb-sync-offline-file" key={fileInputKey} type="file" accept=".dshb-sync,application/octet-stream" disabled={busy !== undefined} onChange={(event) => setFile(event.target.files?.[0])} />
            </label>
            <div style={{ fontSize: 12, opacity: 0.7, minHeight: 18, wordBreak: 'break-all' }}>
              {file ? <><strong>{file.name}</strong><span style={{ marginLeft: 6 }}>{(file.size / 1024 / 1024).toFixed(2)} MiB / 上限 128 MiB</span></> : '尚未选择文件，支持 .dshb-sync，最大 128 MiB'}
            </div>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              包密码
              <input style={fieldStyle} type="password" autoComplete="current-password" value={importPassword} disabled={busy !== undefined} onChange={(event) => setImportPassword(event.target.value)} />
            </label>
            <div className="dshb-sync-offline-actions"><button type="button" style={buttonStyle} disabled={busy !== undefined || !file} onClick={() => void importArchive()}>{busy === 'import' ? '正在导入…' : '验证并导入'}</button></div>
          </div>
        </section>
      </div>
      {status && <div role="status" style={{ marginTop: 14, padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, fontSize: 13, opacity: 0.8 }}>{status}</div>}
      {notice && <div role="status" style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, fontSize: 13, background: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-bg, rgba(34,197,94,.1))' : 'var(--dsw-alias-state-error-bg, rgba(248,113,113,.1))', color: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }}>{notice.text}</div>}
      <div style={{ marginTop: 14, fontSize: 11, lineHeight: 1.6, opacity: 0.55 }}>
        加密配置包包含敏感凭据，请妥善保存并仅在可信实例间传输。
      </div>
    </div>
  )
}
