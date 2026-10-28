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
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [notice, setNotice] = useState<Notice>(undefined)

  const exportArchive = async (): Promise<void> => {
    const error = passwordError(exportPassword)
    if (error) { setNotice({ kind: 'error', text: error }); return }
    if (exportPassword !== confirmPassword) { setNotice({ kind: 'error', text: '两次输入的包密码不一致' }); return }
    setBusy(true)
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
      setBusy(false)
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
    setBusy(true)
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
      props.onImported?.()
    } catch (caught) {
      setNotice({ kind: 'error', text: caught instanceof Error ? caught.message : '导入离线配置失败' })
    } finally {
      setBusy(false)
      setStatus('')
      setImportPassword('')
    }
  }

  return (
    <div style={{ flex: 1, minWidth: 0, maxWidth: 620 }}>
      <div style={{ marginBottom: 18 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>导出加密配置包</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.72, lineHeight: 1.5 }}>
          包含远程节点配置与节点凭据。默认排除会话、同步 peer 凭据和本地节点；包密码只用于本次导出。
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            包密码
            <input style={fieldStyle} type="password" autoComplete="new-password" value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            确认包密码
            <input style={fieldStyle} type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={includeSessions} onChange={(event) => setIncludeSessions(event.target.checked)} />
            包含可映射的远程工作区会话
          </label>
          <div><button type="button" style={buttonStyle} disabled={busy} onClick={() => void exportArchive()}>{busy ? '处理中…' : '导出 .dshb-sync'}</button></div>
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 18 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>导入加密配置包</h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.72, lineHeight: 1.5 }}>
          系统会先验证密码、格式、摘要、路径和空间，再应用配置。相同来源的重复导入会按来源身份去重。
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            选择文件
            <input type="file" accept=".dshb-sync,application/octet-stream" disabled={busy} onChange={(event) => setFile(event.target.files?.[0])} />
          </label>
          {file && <span style={{ fontSize: 12, opacity: 0.72 }}>{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MiB</span>}
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            包密码
            <input style={fieldStyle} type="password" autoComplete="current-password" value={importPassword} onChange={(event) => setImportPassword(event.target.value)} />
          </label>
          <div><button type="button" style={buttonStyle} disabled={busy || !file} onClick={() => void importArchive()}>{busy ? '正在导入…' : '验证并导入'}</button></div>
        </div>
      </div>
      {status && <div role="status" style={{ marginTop: 14, fontSize: 13, opacity: 0.8 }}>{status}</div>}
      {notice && <div role="status" style={{ marginTop: 14, fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }}>{notice.text}</div>}
    </div>
  )
}
