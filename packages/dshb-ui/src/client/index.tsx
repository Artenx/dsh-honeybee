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
  provision?: { state: 'provisioning' | 'ready' | 'failed'; error?: string; containerId?: string; updatedAt: string }
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
  type: 'local-host' | 'local-docker' | 'remote-ssh' | 'remote-docker'
  host: string
  port: string
  username: string
  authKind: 'password' | 'key' | 'agent'
  password: string
  privateKey: string
  passphrase: string
  keyPath: string
  dockerImage: string
  dockerCpus: string
  dockerMemory: string
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
  dockerImage: '',
  dockerCpus: '',
  dockerMemory: '',
}

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

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
const dangerOutlineButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid var(--dsw-alias-state-error-primary)',
  color: 'var(--dsw-alias-state-error-primary)',
  background: 'transparent',
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
        type: node.type,
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
      const isRemote = form.type === 'remote-ssh' || form.type === 'remote-docker'
      const isDocker = form.type === 'local-docker' || form.type === 'remote-docker'
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
        docker: isDocker
          ? {
              mode: 'managed' as const,
              ...(form.dockerImage.trim() ? { image: form.dockerImage.trim() } : {}),
              ...(form.dockerCpus ? { resources: { cpus: Number(form.dockerCpus) || undefined } } : {}),
              ...(form.dockerMemory ? { resources: { memoryMB: Number(form.dockerMemory) || undefined } } : {}),
              ...(form.dockerCpus && form.dockerMemory ? { resources: { cpus: Number(form.dockerCpus) || undefined, memoryMB: Number(form.dockerMemory) || undefined } } : {}),
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
    const isRemote = form.type === 'remote-ssh' || form.type === 'remote-docker'
    if (!isRemote) {
      flash({ kind: 'error', text: '本地节点无需测试连接' })
      return
    }
    if (!form.host.trim()) {
      flash({ kind: 'error', text: '请填写主机地址' })
      return
    }
    setTesting(true)
    setTestResult(undefined)
    try {
      const payload = {
        ssh: {
          host: form.host.trim(),
          port: Number(form.port) || 22,
          username: form.username.trim(),
          auth: { kind: form.authKind, ...(form.keyPath.trim() ? { keyPath: form.keyPath.trim() } : {}) },
        },
        secrets: {
          ...(form.password ? { password: form.password } : {}),
          ...(form.privateKey ? { privateKey: form.privateKey } : {}),
          ...(form.passphrase ? { passphrase: form.passphrase } : {}),
        },
      }
      const url = selectedId === 'new' ? '/api/dshb/nodes/test-unsaved' : `/api/dshb/nodes/${selectedId}/test`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
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
  }, [form, selectedId, flash, reload])

  const selectedNode = selectedId === 'new' ? undefined : nodes.find((n) => n.id === selectedId)

  return (
    <>
    <style>{`@media (max-width:767px){.dshb-node-section{flex-direction:column!important}.dshb-node-section>div:first-child{width:100%!important;border-right:none!important;border-bottom:1px solid var(--dsw-alias-border-l2);padding-right:0!important;padding-bottom:12px;margin-bottom:12px}}`}</style>
    <div className="dshb-node-section" style={{ display: 'flex', gap: 20, minHeight: 320 }}>
      <div style={{ width: 200, flexShrink: 0, borderRight: '1px solid var(--dsw-alias-border-l2)', paddingRight: 16 }}>
        <button type="button" onClick={() => selectNode('new')} style={{ ...primaryButtonStyle, width: '100%', marginBottom: 10 }}>
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
              background: selectedId === n.id ? 'var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover))' : 'transparent',
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
                  background: n.status?.reachable === true ? 'var(--dsw-alias-state-success-primary)' : n.status?.reachable === false ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-dimmed)',
                }}
              />
              {n.type === 'local-host' ? '本地环境' : n.type === 'remote-ssh' ? '远程 SSH' : n.type === 'local-docker' ? '本地 Docker' : n.type === 'remote-docker' ? '远程 Docker' : n.type}
            </div>
            {n.provision && (
              <div style={{ fontSize: 11, marginTop: 2, color: n.provision.state === 'ready' ? 'var(--dsw-alias-state-success-primary)' : n.provision.state === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-label)' }}>
                {n.provision.state === 'provisioning' ? '容器拉起中…' : n.provision.state === 'ready' ? '容器已就绪' : `容器拉起失败：${n.provision.error ?? '未知错误'}`}
              </div>
            )}
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
              <option value="remote-docker">远程 Docker（SSH 通道）</option>
              <option value="local-host">本地环境</option>
              <option value="local-docker">本地 Docker 容器</option>
            </select>
          </label>

          {(form.type === 'remote-ssh' || form.type === 'remote-docker') && (
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

          {(form.type === 'local-docker' || form.type === 'remote-docker') && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                镜像地址
                <input style={inputStyle} value={form.dockerImage} onChange={(e) => setForm((f) => ({ ...f, dockerImage: e.target.value }))} placeholder="alpine:latest" />
              </label>
              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: 1 }}>
                  CPU 核数（可选）
                  <input style={inputStyle} value={form.dockerCpus} onChange={(e) => setForm((f) => ({ ...f, dockerCpus: e.target.value }))} placeholder="2" />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, flex: 1 }}>
                  内存 MB（可选）
                  <input style={inputStyle} value={form.dockerMemory} onChange={(e) => setForm((f) => ({ ...f, dockerMemory: e.target.value }))} placeholder="512" />
                </label>
              </div>
            </>
          )}

          {testResult !== undefined && (
            <div style={{ fontSize: 13, color: testResult === '连接成功' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }}>{testResult}</div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button type="button" onClick={() => void save()} disabled={busy} style={primaryButtonStyle}>
              {selectedId === 'new' ? '创建节点' : '保存'}
            </button>
            {(form.type === 'remote-ssh' || form.type === 'remote-docker') && (
              <button type="button" onClick={() => void test()} disabled={busy || testing} style={secondaryButtonStyle}>
                {testing ? '测试中…' : '测试连接'}
              </button>
            )}
            {selectedId !== 'new' && (
              <button type="button" onClick={() => void remove()} disabled={busy} style={dangerOutlineButtonStyle}>
                删除
              </button>
            )}
            {notice && <span style={{ fontSize: 13, alignSelf: 'center', color: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }}>{notice.text}</span>}
          </div>
        </div>
      </div>
    </div>
    </>
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

  const ICON_SVG: Record<string, string> = {
    auth: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 7C9.3807 7 10.5 5.8807 10.5 4.5C10.5 3.1193 9.3807 2 8 2C6.6193 2 5.5 3.1193 5.5 4.5C5.5 5.8807 6.6193 7 8 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14C3 11.2386 5.2386 9 8 9C10.7614 9 13 11.2386 13 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'dshb-nodes': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="3.5" cy="4" r="2" stroke="currentColor" stroke-width="1.5"/><circle cx="12.5" cy="4" r="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="12" r="2" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 6V8C3.5 9.1 4.4 10 5.5 10H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12.5 6V8C12.5 9.1 11.6 10 10.5 10H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  }
  const ICON_LABELS: Record<string, string> = { '认证': 'auth', '工作节点': 'dshb-nodes' }

  const observer = new MutationObserver(() => {
    const cells = document.querySelectorAll('button[class*="navCell"]')
    for (const cell of Array.from(cells)) {
      const label = cell.querySelector('span[class*="navLabel"]')
      if (!label) continue
      const text = label.textContent ?? ''
      const iconKey = ICON_LABELS[text]
      if (!iconKey) continue
      const iconSlot = cell.querySelector('[class*="navIcon"]')
      if (!iconSlot) continue
      if (iconSlot.getAttribute('data-dshb-icon') === iconKey) continue
      iconSlot.innerHTML = ICON_SVG[iconKey] ?? ''
      iconSlot.setAttribute('data-dshb-icon', iconKey)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
