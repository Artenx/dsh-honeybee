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
  syncSessions: boolean
  enabled: boolean
}

export interface SyncPeerFormView extends Omit<SyncPeerForm, 'password' | 'privateKey' | 'passphrase' | 'port' | 'remoteWebPort' | 'remoteDshHome' | 'remoteProfile'> {
  port: number
  remoteDshHome?: string
  remoteProfile?: string
  remoteWebPort?: number
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
  syncSessions: false,
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
    syncSessions: peer.syncSessions,
    enabled: peer.enabled,
  }
}

export function buildSyncPeerFormRequest(form: SyncPeerForm): SyncPeerFormRequest {
  const fields: Record<string, unknown> = {
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authKind: form.authKind,
    direction: form.direction,
    schedule: form.schedule,
    syncSessions: form.syncSessions,
    enabled: form.enabled,
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
