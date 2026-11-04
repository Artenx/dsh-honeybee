import type { SyncSelection } from '../core/sync/model.js'

export interface SyncPeerSecretFlags {
  hasPassword: boolean
  hasKey: boolean
  hasPassphrase: boolean
}

export interface SyncPeerForm {
  name: string
  host: string
  port: string
  username: string
  authKind: 'password' | 'key'
  password: string
  privateKey: string
  passphrase: string
  remoteDshHome: string
  remoteProfile: string
  remoteWebPort: string
  direction: 'pull' | 'bidirectional'
  schedule: 'manual' | 'every-5m'
  mode: 'full' | 'metadata'
  syncNodes: boolean
  syncSessions: boolean
  selection: SyncSelection
  enabled: boolean
}

export interface SyncPeerFormView extends Omit<SyncPeerForm, 'password' | 'privateKey' | 'passphrase' | 'port' | 'remoteWebPort' | 'remoteDshHome' | 'remoteProfile' | 'selection' | 'mode' | 'syncNodes'> {
  port: number
  remoteDshHome?: string
  remoteProfile?: string
  remoteWebPort?: number
  selection?: SyncSelection
  mode?: 'full' | 'metadata'
  syncNodes?: boolean
  hasSecret: SyncPeerSecretFlags
}

export const EMPTY_SYNC_PEER_FORM: SyncPeerForm = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authKind: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  remoteDshHome: '',
  remoteProfile: '',
  remoteWebPort: '',
  direction: 'pull',
  schedule: 'manual',
  mode: 'full',
  syncNodes: true,
  syncSessions: false,
  selection: { mode: 'all', nodes: [], workspaces: [], sessions: [] },
  enabled: true,
}

export interface SyncPeerFormRequest {
  fields: Record<string, unknown>
  secrets: Record<string, string>
}

function validPort(value: string): boolean {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function syncPeerFormError(form: SyncPeerForm, savedSecrets?: SyncPeerSecretFlags): string | undefined {
  if (!form.name.trim() || !form.host.trim() || !form.username.trim()) return '请填写名称、SSH 主机和系统账号'
  if (!validPort(form.port)) return 'SSH 端口必须在 1 到 65535 之间'
  if (form.remoteWebPort.trim() && !validPort(form.remoteWebPort)) return '远端 Web 端口必须在 1 到 65535 之间'
  if (form.authKind === 'password' && !form.password && !savedSecrets?.hasPassword) return '请填写 SSH 密码'
  if (form.authKind === 'key' && !form.privateKey && !savedSecrets?.hasKey) return '请填写 SSH 私钥内容'
  return undefined
}

export function toSyncPeerForm(peer: SyncPeerFormView): SyncPeerForm {
  const syncSessions = peer.syncSessions
  const mode = syncSessions ? peer.mode ?? 'full' : 'full'
  return {
    name: peer.name,
    host: peer.host,
    port: String(peer.port),
    username: peer.username,
    authKind: peer.authKind,
    password: '',
    privateKey: '',
    passphrase: '',
    remoteDshHome: peer.remoteDshHome ?? '',
    remoteProfile: peer.remoteProfile ?? '',
    remoteWebPort: peer.remoteWebPort == null ? '' : String(peer.remoteWebPort),
    direction: peer.direction,
    schedule: peer.schedule,
    mode,
    // 全量会话同步依赖节点配置；仅元数据模式允许关闭节点同步。
    syncNodes: mode === 'metadata' ? peer.syncNodes ?? true : true,
    syncSessions,
    selection: peer.selection ?? { mode: 'all', nodes: [], workspaces: [], sessions: [] },
    enabled: true,
  }
}

/**
 * 把表单归一化为保存请求：
 * - 「启用此同步节点」已移除，enabled 恒 true（停用语义由删除节点承担）。
 * - 元数据同步且不同步工作节点时没有任何调度内容，强制手动时机。
 * - 全量会话同步依赖工作节点配置，强制开启节点同步。
 */
export function buildSyncPeerFormRequest(form: SyncPeerForm): SyncPeerFormRequest {
  const syncSessions = form.syncSessions
  const mode = syncSessions ? form.mode : 'full'
  const syncNodes = mode === 'metadata' ? form.syncNodes : true
  const schedule = mode === 'metadata' && !syncNodes ? 'manual' as const : form.schedule
  const fields: Record<string, unknown> = {
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authKind: form.authKind,
    direction: form.direction,
    schedule,
    mode,
    syncNodes,
    syncSessions,
    selection: form.selection,
    enabled: true,
    ...(form.remoteDshHome.trim() ? { remoteDshHome: form.remoteDshHome.trim() } : {}),
    ...(form.remoteProfile.trim() ? { remoteProfile: form.remoteProfile.trim() } : {}),
    ...(form.remoteWebPort.trim() ? { remoteWebPort: Number(form.remoteWebPort) } : {}),
  }
  const secrets: Record<string, string> = {}
  if (form.authKind === 'password') {
    if (form.password) secrets.password = form.password
  } else {
    if (form.privateKey) secrets.privateKey = form.privateKey
    if (form.passphrase) secrets.passphrase = form.passphrase
  }
  return { fields, secrets }
}

export interface SyncRemoteProbeProfile {
  name: string
  dshbInstalled: boolean
  home: string
}

export interface SyncRemoteProbe {
  homes: string[]
  profiles: SyncRemoteProbeProfile[]
  handshakes?: Array<{ port: number; instanceId: string }>
  webPort?: number
  instanceId?: string
  hostKeyFingerprint: string
}

/**
 * 把探测结果回填进表单：DSH_HOME 取首个命中目录（保留用户已填的显式覆盖），
 * profile 取首个装有 dshb 的条目，Web 端口取握手命中值。仅在对应字段为空
 * 或明显是默认值时回填，避免覆盖用户手改内容。
 */
export function applyRemoteProbeToForm(form: SyncPeerForm, probe: SyncRemoteProbe): SyncPeerForm {
  const detectedHome = probe.homes[0]
  const detectedProfile = probe.profiles.find((profile) => profile.dshbInstalled) ?? probe.profiles[0]
  const homeKept = form.remoteDshHome.trim() !== '' && form.remoteDshHome.trim() !== (detectedHome ?? '')
  const profileKept = form.remoteProfile.trim() !== '' && form.remoteProfile.trim() !== 'web'
  return {
    ...form,
    remoteDshHome: homeKept ? form.remoteDshHome : (detectedHome ?? form.remoteDshHome),
    remoteProfile: profileKept ? form.remoteProfile : (detectedProfile?.name ?? form.remoteProfile),
    remoteWebPort: probe.webPort !== undefined ? String(probe.webPort) : form.remoteWebPort,
  }
}

/** 远端 profile 下拉选项：探测结果优先（dshb 已装的排前），并保留当前手填值。 */
export function remoteProfileOptions(form: SyncPeerForm, probe?: SyncRemoteProbe): Array<{ name: string; dshbInstalled?: boolean }> {
  const options: Array<{ name: string; dshbInstalled?: boolean }> = (probe?.profiles ?? [])
    .slice()
    .sort((left, right) => Number(right.dshbInstalled) - Number(left.dshbInstalled))
    .map((profile) => ({ name: profile.name, dshbInstalled: profile.dshbInstalled }))
  const current = form.remoteProfile.trim()
  if (current && !options.some((option) => option.name === current)) {
    options.push({ name: current })
  }
  if (options.length === 0) options.push({ name: 'web' })
  return options
}
