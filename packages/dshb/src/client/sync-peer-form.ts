import type { SyncSelection } from '../core/sync/model.js'

export interface SyncPeerSecretFlags {
  hasPassword: boolean
  hasKey: boolean
  hasPassphrase: boolean
}

/** 工作区会话同步三态：不同步 / 全量同步 / 元数据同步（实时访问远端）。 */
export type SessionSyncChoice = 'off' | 'full' | 'metadata'

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
  sessionSync: SessionSyncChoice
  selection: SyncSelection
}

export interface SyncPeerFormView extends Omit<SyncPeerForm, 'password' | 'privateKey' | 'passphrase' | 'port' | 'remoteWebPort' | 'remoteDshHome' | 'remoteProfile' | 'selection'> {
  port: number
  remoteDshHome?: string
  remoteProfile?: string
  remoteWebPort?: number
  selection?: SyncSelection
  /** 底层存储字段：由 sessionSync 三态推导。 */
  syncSessions: boolean
  mode?: 'full' | 'metadata'
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
  sessionSync: 'off',
  selection: { mode: 'all', nodes: [], workspaces: [], sessions: [] },
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
    sessionSync: peer.syncSessions ? (peer.mode === 'metadata' ? 'metadata' : 'full') : 'off',
    selection: peer.selection ?? { mode: 'all', nodes: [], workspaces: [], sessions: [] },
  }
}

/**
 * 把表单归一化为保存请求：
 * - 工作节点配置恒同步；方向与时机逻辑已取消（双向交换、仅手动触发）。
 * - 「打开远端会话」（wss 实时访问）不依赖手动同步，元数据同步无需传输离线文件。
 */
export function buildSyncPeerFormRequest(form: SyncPeerForm): SyncPeerFormRequest {
  const syncSessions = form.sessionSync !== 'off'
  const fields: Record<string, unknown> = {
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authKind: form.authKind,
    direction: 'bidirectional',
    schedule: 'manual',
    mode: form.sessionSync === 'metadata' ? 'metadata' : 'full',
    syncNodes: true,
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
