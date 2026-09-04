import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CSSProperties, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'

interface NodeProfileView {
  id: string
  name: string
  type: 'local-host' | 'local-docker' | 'remote-ssh' | 'remote-docker'
  status?: { reachable?: boolean }
}

interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface ContainerInfo {
  id: string
  name: string
  status: string
  image: string
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0 10px',
  height: 32,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: 'inherit',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  outline: 'none',
}
const buttonStyle: CSSProperties = {
  boxSizing: 'border-box',
  height: 36,
  padding: '0 14px',
  borderRadius: 18,
  fontSize: 14,
  lineHeight: '22px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: 'none',
  display: 'inline-flex',
  justifyContent: 'center',
  alignItems: 'center',
  gap: 4,
}
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}
const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid var(--dsw-alias-border-l2)',
  color: 'var(--dsw-alias-label-primary)',
  background: 'transparent',
}
const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--dsw-alias-overlay-mask, rgba(0,0,0,0.45))',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
}
const dialogStyle: CSSProperties = {
  width: 'min(92vw, 560px)',
  maxHeight: '80vh',
  overflow: 'auto',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  padding: 20,
  color: 'var(--dsw-alias-label-primary)',
}

function joinPath(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${name}`
}

export function DirectoryFlowOccupant(props: DirectoryFlowOwnerProps): ReactElement | null {
  const [nodes, setNodes] = useState<NodeProfileView[]>([])
  const [nodeId, setNodeId] = useState<string>('')
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [newDirName, setNewDirName] = useState('')
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [containerMode, setContainerMode] = useState<'existing' | 'new'>('existing')
  const [containerId, setContainerId] = useState('')
  const [newImage, setNewImage] = useState('')
  const [newCpus, setNewCpus] = useState('')
  const [newMemory, setNewMemory] = useState('')

  useEffect(() => {
    if (!props.open) return
    void (async () => {
      try {
        const res = await fetch('/api/dshb/nodes')
        if (!res.ok) return
        const data = (await res.json()) as { nodes?: NodeProfileView[] }
        setNodes((data.nodes ?? []).filter((n) => n.type === 'local-host' || n.status?.reachable === true))
      } catch {}
    })()
  }, [props.open])

  const browse = useCallback(async (id: string, dir: string) => {
    setError(undefined)
    try {
      const res = await fetch(`/api/dshb/nodes/${id}/browse?path=${encodeURIComponent(dir)}`)
      const data = (await res.json()) as { ok?: boolean; path?: string; entries?: DirEntry[]; error?: string }
      if (!res.ok || !data.ok) {
        setError(data.error ?? '目录读取失败')
        return
      }
      setPath(data.path ?? dir)
      setEntries((data.entries ?? []).filter((e) => e.isDirectory))
    } catch {
      setError('网络错误')
    }
  }, [])

  const selectNode = useCallback(
    (id: string) => {
      setNodeId(id)
      setPath('')
      setEntries([])
      setError(undefined)
      setContainers([])
      setContainerId('')
      const node = nodes.find((n) => n.id === id)
      if (node) {
        if (node.type === 'local-docker' || node.type === 'remote-docker') {
          void (async () => {
            try {
              const res = await fetch(`/api/dshb/docker/${id}/containers`)
              const data = (await res.json()) as { ok?: boolean; containers?: ContainerInfo[] }
              if (data.ok) setContainers(data.containers ?? [])
            } catch {}
          })()
        }
        void browse(id, node.type === 'local-host' ? '/' : '~')
      }
    },
    [nodes, browse],
  )

  const mkdir = useCallback(async () => {
    if (!newDirName.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      const target = joinPath(path, newDirName.trim())
      const res = await fetch(`/api/dshb/nodes/${nodeId}/mkdir`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: target }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setError(data.error ?? '创建目录失败')
        return
      }
      setNewDirName('')
      void browse(nodeId, path)
    } catch {
      setError('网络错误')
    } finally {
      setBusy(false)
    }
  }, [newDirName, nodeId, path, browse])

  const confirm = useCallback(async () => {
    if (!nodeId || !path) {
      setError('请选择节点与目录')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) return
      if (node.type === 'local-host') {
        props.onPicked(path)
        return
      }
      let targetNodeId = nodeId
      if (node.type === 'local-docker' || node.type === 'remote-docker') {
        if (containerMode === 'new') {
          if (!newImage.trim()) {
            setError('请填写自定义镜像')
            return
          }
          setError(undefined)
          const provRes = await fetch(`/api/dshb/docker/${nodeId}/provision`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              image: newImage.trim(),
              cpus: newCpus ? Number(newCpus) : undefined,
              memoryMB: newMemory ? Number(newMemory) : undefined,
            }),
          })
          const provData = (await provRes.json()) as { ok?: boolean; containerId?: string; error?: string }
          if (!provRes.ok || !provData.ok) {
            setError(provData.error ?? '容器创建失败')
            return
          }
        }
      }
      const res = await fetch('/api/dshb/workspaces/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: targetNodeId, remotePath: path }),
      })
      const data = (await res.json()) as { ok?: boolean; mirrorPath?: string; error?: string }
      if (!res.ok || !data.ok || !data.mirrorPath) {
        setError(data.error ?? '工作区注册失败')
        return
      }
      props.onPicked(data.mirrorPath)
    } catch {
      setError('网络错误')
    } finally {
      setBusy(false)
    }
  }, [nodeId, path, nodes, props, containerMode, newImage, newCpus, newMemory])

  if (!props.open) return null

  const node = nodes.find((n) => n.id === nodeId)

  return (
    <div style={overlayStyle} role="dialog" aria-label="添加工作区">
      <div style={dialogStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: 'var(--dsw-alias-label-primary)' }}>添加工作区</h2>
          <button type="button" onClick={props.onCancel} style={secondaryButtonStyle}>
            关闭
          </button>
        </div>

        <label style={{ display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 }}>工作节点</label>
        <select style={{ ...inputStyle, marginBottom: 14 }} value={nodeId} onChange={(e) => selectNode(e.target.value)} disabled={props.busy || busy}>
          <option value="">选择节点…</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}（{n.type === 'local-host' ? '本地环境' : n.type === 'remote-ssh' ? '远程 SSH' : n.type}）
            </option>
          ))}
        </select>

        {node && (node.type === 'local-docker' || node.type === 'remote-docker') && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 }}>容器</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button type="button" onClick={() => setContainerMode('existing')} style={containerMode === 'existing' ? primaryButtonStyle : secondaryButtonStyle}>
                已存在容器
              </button>
              <button type="button" onClick={() => setContainerMode('new')} style={containerMode === 'new' ? primaryButtonStyle : secondaryButtonStyle}>
                新建容器
              </button>
            </div>
            {containerMode === 'existing' && (
              <select style={inputStyle} value={containerId} onChange={(e) => setContainerId(e.target.value)}>
                <option value="">选择容器…</option>
                {containers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.image}，{c.status}）
                  </option>
                ))}
              </select>
            )}
            {containerMode === 'new' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input style={inputStyle} value={newImage} onChange={(e) => setNewImage(e.target.value)} placeholder="自定义镜像（如 alpine:latest）" />
                <div style={{ display: 'flex', gap: 8 }}>
                  <input style={inputStyle} value={newCpus} onChange={(e) => setNewCpus(e.target.value)} placeholder="CPU 核数（可选）" />
                  <input style={inputStyle} value={newMemory} onChange={(e) => setNewMemory(e.target.value)} placeholder="内存 MB（可选）" />
                </div>
              </div>
            )}
          </div>
        )}

        {nodeId !== '' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>目录（{node?.type === 'local-host' ? '本机' : '远端'}）</label>
              <button type="button" onClick={() => void browse(nodeId, dirnameOf(path))} disabled={busy} style={secondaryButtonStyle}>
                上一级
              </button>
            </div>
            <input style={{ ...inputStyle, marginBottom: 8 }} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/workspace" />
            <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, marginBottom: 10 }}>
              {entries.map((e) => (
                <div key={e.path} onClick={() => void browse(nodeId, e.path)} style={{ padding: '7px 10px', cursor: 'pointer', fontSize: 13, borderRadius: 6, color: 'var(--dsw-alias-label-primary)' }} onMouseEnter={(ev) => (ev.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)')} onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}>
                  📁 {e.name}
                </div>
              ))}
              {entries.length === 0 && <div style={{ padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>无子目录</div>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input style={inputStyle} value={newDirName} onChange={(e) => setNewDirName(e.target.value)} placeholder="新建目录名（可选）" />
              <button type="button" onClick={() => void mkdir()} disabled={busy || !newDirName.trim()} style={secondaryButtonStyle}>
                新建
              </button>
            </div>
          </>
        )}

        {error && <div style={{ fontSize: 13, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 10 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" onClick={props.onCancel} style={secondaryButtonStyle}>
            取消
          </button>
          <button type="button" onClick={() => void confirm()} disabled={busy || props.busy || !nodeId || !path} style={primaryButtonStyle}>
            设为工作区
          </button>
        </div>
      </div>
    </div>
  )
}

function dirnameOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}
