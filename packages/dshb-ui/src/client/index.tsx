import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CSSProperties, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { DirectoryFlowOccupant } from './directory-flow.js'

export const inject = ['connection']

const SECTION_ID = 'dshb-nodes'

interface NodeProfileView {
  id: string
  name: string
  type: 'local-host' | 'local-docker' | 'remote-ssh' | 'remote-docker'
  ssh?: {
    host: string
    port: number
    username: string
    auth: { kind: 'password' | 'key' | 'agent'; keyPath?: string }
  }
  hasSecret: { hasPassword: boolean; hasKey: boolean; hasPassphrase: boolean }
  status?: { reachable?: boolean; lastCheckedAt?: string; error?: string }
}

interface SshConfigEntryView {
  host: string
  port: number
  username: string
  identityFile?: string
  hasIdentityFile: boolean
  hasProxyJump: boolean
}

interface FormState {
  name: string
  type: 'local-host' | 'remote-ssh'
  host: string
  port: string
  username: string
  authKind: 'password' | 'key' | 'agent'
  password: string
  privateKey: string
  passphrase: string
  keyPath: string
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'remote-ssh',
  host: '',
  port: '22',
  username: '',
  authKind: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  keyPath: '',
}

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  border: '1px solid var(--dsw-border, #3a4050)',
  borderRadius: 6,
  fontSize: 14,
  fontFamily: 'inherit',
  background: 'var(--dsw-input-bg, transparent)',
  color: 'inherit',
}
const buttonStyle: CSSProperties = {
  padding: '7px 14px',
  borderRadius: 6,
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px solid transparent',
}

function useNodes(reloadKey: number): NodeProfileView[] {
  const [nodes, setNodes] = useState<NodeProfileView[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/dshb/nodes')
        if (!res.ok) return
        const data = (await res.json()) as { nodes?: NodeProfileView[] }
        if (!cancelled) setNodes(data.nodes ?? [])
      } catch {}
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey])
  return nodes
}

export function NodeSection(_props: PropsRuntime<'settings.section'>): ReactElement {
  const [reloadKey, setReloadKey] = useState(0)
  const nodes = useNodes(reloadKey)
  const [selectedId, setSelectedId] = useState<string | 'new'>('new')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [notice, setNotice] = useState<Notice>(undefined)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | undefined>(undefined)
  const [sshConfigEntries, setSshConfigEntries] = useState<SshConfigEntryView[]>([])

  const flash = useCallback((n: Notice) => {
    setNotice(n)
    if (n) setTimeout(() => setNotice(undefined), 6000)
  }, [])

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/dshb/ssh-config')
        if (!res.ok) return
        const data = (await res.json()) as { entries?: SshConfigEntryView[] }
        setSshConfigEntries(data.entries ?? [])
      } catch {}
    })()
  }, [])

  const selectNode = useCallback(
    (id: string | 'new') => {
      setSelectedId(id)
      setTestResult(undefined)
      if (id === 'new') {
        setForm(EMPTY_FORM)
        return
      }
      const node = nodes.find((n) => n.id === id)
      if (!node) return
      setForm({
        name: node.name,
        type: node.type === 'local-host' ? 'local-host' : 'remote-ssh',
        host: node.ssh?.host ?? '',
        port: String(node.ssh?.port ?? 22),
        username: node.ssh?.username ?? '',
        authKind: node.ssh?.auth.kind ?? 'password',
        password: '',
        privateKey: '',
        passphrase: '',
        keyPath: node.ssh?.auth.keyPath ?? '',
      })
    },
    [nodes],
  )

  const importSshConfig = useCallback((entry: SshConfigEntryView) => {
    setForm((f) => ({
      ...f,
      type: 'remote-ssh',
      host: entry.host,
      port: String(entry.port),
      username: entry.username,
      authKind: entry.hasIdentityFile ? 'key' : f.authKind,
      keyPath: entry.identityFile ?? f.keyPath,
      name: f.name || entry.host,
    }))
    setTestResult(undefined)
    flash({ kind: 'ok', text: `已从 ~/.ssh/config 导入 ${entry.host}` })
  }, [flash])

  const save = useCallback(async () => {
    if (!form.name.trim()) {
      flash({ kind: 'error', text: '请填写节点名称' })
      return
    }
    setBusy(true)
    try {
      const isRemote = form.type === 'remote-ssh'
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        type: form.type,
        ssh: isRemote
          ? {
              host: form.host.trim(),
              port: Number(form.port) || 22,
              username: form.username.trim(),
              auth: { kind: form.authKind, ...(form.keyPath.trim() ? { keyPath: form.keyPath.trim() } : {}) },
            }
          : undefined,
        secrets: isRemote
          ? {
              ...(form.password ? { password: form.password } : {}),
              ...(form.privateKey ? { privateKey: form.privateKey } : {}),
              ...(form.passphrase ? { passphrase: form.passphrase } : {}),
            }
          : undefined,
      }
      const url = selectedId === 'new' ? '/api/dshb/nodes' : `/api/dshb/nodes/${selectedId}`
      const res = await fetch(url, {
        method: selectedId === 'new' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string; node?: NodeProfileView }
      if (res.ok && data.ok) {
        flash({ kind: 'ok', text: selectedId === 'new' ? '节点已创建' : '节点已保存' })
        reload()
        if (data.node) setSelectedId(data.node.id)
      } else {
        flash({ kind: 'error', text: data.error ?? '保存失败' })
      }
    } catch {
      flash({ kind: 'error', text: '网络错误' })
    } finally {
      setBusy(false)
    }
  }, [form, selectedId, flash, reload])

  const remove = useCallback(async () => {
    if (selectedId === 'new') return
    setBusy(true)
    try {
      const res = await fetch(`/api/dshb/nodes/${selectedId}`, { method: 'DELETE' })
      if (res.ok) {
        flash({ kind: 'ok', text: '节点已删除' })
        setSelectedId('new')
        setForm(EMPTY_FORM)
        reload()
      }
    } catch {
      flash({ kind: 'error', text: '删除失败' })
    } finally {
      setBusy(false)
    }
  }, [selectedId, flash, reload])

  const test = useCallback(async () => {
    if (selectedId === 'new') {
      flash({ kind: 'error', text: '请先保存节点再测试连接' })
      return
    }
    setTesting(true)
    setTestResult(undefined)
    try {
      const res = await fetch(`/api/dshb/nodes/${selectedId}/test`, { method: 'POST' })
      const data = (await res.json()) as { ok?: boolean; report?: { ok?: boolean; reachable?: boolean; error?: string; category?: string } }
      const r = data.report
      if (r?.ok && r.reachable) {
        setTestResult('连接成功')
        flash({ kind: 'ok', text: '连接成功' })
      } else {
        const cat = r?.category ? `（${r.category}）` : ''
        setTestResult(`${r?.error ?? '连接失败'}${cat}`)
        flash({ kind: 'error', text: `连接失败${cat}` })
      }
      reload()
    } catch {
      setTestResult('网络错误')
    } finally {
      setTesting(false)
    }
  }, [selectedId, flash, reload])

  const selectedNode = selectedId === 'new' ? undefined : nodes.find((n) => n.id === selectedId)

  return (
    <div style={{ display: 'flex', gap: 20, minHeight: 320 }}>
      <div style={{ width: 200, flexShrink: 0, borderRight: '1px solid var(--dsw-border, #3a4050)', paddingRight: 16 }}>
        <button type="button" onClick={() => selectNode('new')} style={{ ...buttonStyle, width: '100%', background: 'var(--dsw-accent, #3b82f6)', color: '#fff', marginBottom: 10 }}>
          新建节点
        </button>
        {nodes.map((n) => (
          <div
            key={n.id}
            onClick={() => selectNode(n.id)}
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              cursor: 'pointer',
              marginBottom: 4,
              background: selectedId === n.id ? 'var(--dsw-hover, #2a3040)' : 'transparent',
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 500 }}>{n.name}</div>
            <div style={{ fontSize: 11, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: n.status?.reachable === true ? 'var(--dsw-ok, #237804)' : n.status?.reachable === false ? 'var(--dsw-danger, #d4380d)' : 'var(--dsw-muted, #666)',
                }}
              />
              {n.type === 'local-host' ? '本地宿主' : n.type === 'remote-ssh' ? '远程 SSH' : n.type}
            </div>
          </div>
        ))}
        {nodes.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>暂无节点</div>}
      </div>

      <div style={{ flex: 1, maxWidth: 480 }}>
        {sshConfigEntries.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, opacity: 0.75, display: 'block', marginBottom: 4 }}>从 ~/.ssh/config 导入</label>
            <select
              style={inputStyle}
              value=""
              onChange={(e) => {
                const entry = sshConfigEntries[Number(e.target.value)]
                if (entry) importSshConfig(entry)
                e.target.value = ''
              }}
            >
              <option value="">选择主机…</option>
              {sshConfigEntries.map((entry, i) => (
                <option key={entry.host} value={i}>
                  {entry.host}:{entry.port}{entry.username ? ` (${entry.username})` : ''}{entry.hasProxyJump ? ' 跳板' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            节点名称
            <input style={inputStyle} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="例如：构建机" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            节点类型
            <select style={inputStyle} value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as FormState['type'] }))}>
              <option value="remote-ssh">远程 SSH 宿主机</option>
              <option value="local-host">本地宿主（管理端所在环境）</option>
            </select>
          </label>

          {form.type === 'remote-ssh' && (
            <>
              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: 1 }}>
                  主机地址
                  <input style={inputStyle} value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} placeholder="192.168.1.10" />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, width: 90 }}>
                  端口
                  <input style={inputStyle} value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
                </label>
              </div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                用户名
                <input style={inputStyle} value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} placeholder="root" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                认证方式
                <select style={inputStyle} value={form.authKind} onChange={(e) => setForm((f) => ({ ...f, authKind: e.target.value as FormState['authKind'] }))}>
                  <option value="password">密码</option>
                  <option value="key">私钥</option>
                  <option value="agent">ssh-agent</option>
                </select>
              </label>
              {form.authKind === 'password' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                  密码{selectedNode?.hasSecret.hasPassword ? '（已保存，留空保持不变）' : ''}
                  <input style={inputStyle} type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} autoComplete="new-password" />
                </label>
              )}
              {form.authKind === 'key' && (
                <>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                    私钥内容{selectedNode?.hasSecret.hasKey ? '（已保存，留空保持不变）' : ''}
                    <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={form.privateKey} onChange={(e) => setForm((f) => ({ ...f, privateKey: e.target.value }))} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                    私钥 passphrase（可选）
                    <input style={inputStyle} type="password" value={form.passphrase} onChange={(e) => setForm((f) => ({ ...f, passphrase: e.target.value }))} autoComplete="new-password" />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                    或私钥文件路径（可选，优先使用内容）
                    <input style={inputStyle} value={form.keyPath} onChange={(e) => setForm((f) => ({ ...f, keyPath: e.target.value }))} placeholder="~/.ssh/id_ed25519" />
                  </label>
                </>
              )}
            </>
          )}

          {testResult !== undefined && (
            <div style={{ fontSize: 13, color: testResult === '连接成功' ? 'var(--dsw-ok, #237804)' : 'var(--dsw-danger, #d4380d)' }}>{testResult}</div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button type="button" onClick={() => void save()} disabled={busy} style={{ ...buttonStyle, background: 'var(--dsw-accent, #3b82f6)', color: '#fff' }}>
              {selectedId === 'new' ? '创建节点' : '保存'}
            </button>
            {selectedId !== 'new' && (
              <>
                <button type="button" onClick={() => void test()} disabled={busy || testing} style={{ ...buttonStyle, background: 'none', borderColor: 'var(--dsw-border, #3a4050)' }}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
                <button type="button" onClick={() => void remove()} disabled={busy} style={{ ...buttonStyle, background: 'none', borderColor: 'var(--dsw-danger, #d4380d)', color: 'var(--dsw-danger, #d4380d)' }}>
                  删除
                </button>
              </>
            )}
            {notice && <span style={{ fontSize: 13, alignSelf: 'center', color: notice.kind === 'ok' ? 'var(--dsw-ok, #237804)' : 'var(--dsw-danger, #d4380d)' }}>{notice.text}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.plugin({
    inject: ['slots', 'settingsScope'],
    apply: (sub: ClientContext): void => {
      sub.slots.inject('settings.section', () =>
        sub.slots.register({ name: 'settings.section', id: SECTION_ID, order: 110, label: () => '工作节点' }, NodeSection),
      )
      sub.slots.inject('conversation.hero.workspace.directoryFlow', () =>
        sub.slots.register({ name: 'conversation.hero.workspace.directoryFlow' }, DirectoryFlowOccupant),
      )
      sub.slots.inject('sidebar.workspaces.directoryFlow', () =>
        sub.slots.register({ name: 'sidebar.workspaces.directoryFlow' }, DirectoryFlowOccupant),
      )
    },
  })
}
