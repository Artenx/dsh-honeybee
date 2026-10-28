import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { parseSyncPeer, parseSyncPeerDraft, type SyncPeer, type SyncPeerDraft, type SyncPeerProgress } from './model.js'
import { SyncPeerStore, SyncStateStore } from './stores.js'

export interface SyncPeerSecrets {
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface SyncPeerView extends SyncPeer {
  hasSecret: { hasPassword: boolean; hasKey: boolean; hasPassphrase: boolean }
  progress?: SyncPeerProgress
}

export type SyncPeerChangeListener = (peerId: string, peer: SyncPeer | undefined) => void

interface CredentialsLike {
  readRecord(key: CredentialKey): Promise<unknown>
  modifyRecord(key: CredentialKey, mutate: (current: unknown) => Promise<unknown>): Promise<unknown>
  deleteRecord(key: CredentialKey): Promise<void>
}

const SECRET_FIELDS = new Set(['password', 'privateKey', 'passphrase'])
const PATCH_FIELDS = new Set([
  'name',
  'host',
  'port',
  'username',
  'authKind',
  'remoteDshHome',
  'remoteProfile',
  'remoteWebPort',
  'direction',
  'schedule',
  'syncSessions',
  'enabled',
])
const MAX_SECRET_BYTES = 64 * 1024

export class SyncPeerInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncPeerInputError'
  }
}

export class SyncPeerNotFoundError extends Error {
  constructor(id: string) {
    super(`sync peer ${id} not found`)
    this.name = 'SyncPeerNotFoundError'
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyncPeerInputError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseSecrets(value: unknown): SyncPeerSecrets | undefined {
  if (value === undefined) return undefined
  const input = asRecord(value, 'secrets')
  for (const key of Object.keys(input)) {
    if (!SECRET_FIELDS.has(key)) throw new SyncPeerInputError(`unsupported secret field: ${key}`)
  }

  const output: SyncPeerSecrets = {}
  for (const field of ['password', 'privateKey', 'passphrase'] as const) {
    const secret = input[field]
    if (secret === undefined || secret === '') continue
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES || secret.includes('\0')) {
      throw new SyncPeerInputError(`${field} is invalid`)
    }
    output[field] = secret
  }
  return Object.keys(output).length === 0 ? undefined : output
}

function payloadFromRecord(value: unknown): SyncPeerSecrets {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const payload = (value as { payload?: unknown }).payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const source = payload as Record<string, unknown>
  return {
    ...(typeof source.password === 'string' ? { password: source.password } : {}),
    ...(typeof source.privateKey === 'string' ? { privateKey: source.privateKey } : {}),
    ...(typeof source.passphrase === 'string' ? { passphrase: source.passphrase } : {}),
  }
}

function toView(peer: SyncPeer, secrets: SyncPeerSecrets): SyncPeerView {
  return {
    ...peer,
    hasSecret: {
      hasPassword: Boolean(secrets.password),
      hasKey: Boolean(secrets.privateKey),
      hasPassphrase: Boolean(secrets.passphrase),
    },
  }
}

function validateAuthSecrets(
  authKind: SyncPeer['authKind'],
  supplied: SyncPeerSecrets | undefined,
  effective: SyncPeerSecrets,
): void {
  if (authKind === 'password') {
    if (supplied?.privateKey !== undefined || supplied?.passphrase !== undefined) {
      throw new SyncPeerInputError('key credentials do not match password authentication')
    }
    if (!effective.password) throw new SyncPeerInputError('password authentication requires a saved password')
    return
  }
  if (supplied?.password !== undefined) throw new SyncPeerInputError('password does not match key authentication')
  if (!effective.privateKey) throw new SyncPeerInputError('key authentication requires a saved private key')
}

function secretsForAuth(authKind: SyncPeer['authKind'], secrets: SyncPeerSecrets): SyncPeerSecrets {
  return authKind === 'password'
    ? (secrets.password ? { password: secrets.password } : {})
    : {
        ...(secrets.privateKey ? { privateKey: secrets.privateKey } : {}),
        ...(secrets.passphrase ? { passphrase: secrets.passphrase } : {}),
      }
}

function asInputError(error: unknown): SyncPeerInputError {
  return error instanceof SyncPeerInputError
    ? error
    : new SyncPeerInputError(error instanceof Error ? error.message : 'invalid sync peer')
}

export class SyncPeerManager {
  private readonly listeners = new Set<SyncPeerChangeListener>()

  constructor(
    private readonly peers: SyncPeerStore,
    private readonly state: SyncStateStore,
    private readonly credentials: CredentialsLike,
  ) {}

  async list(): Promise<SyncPeerView[]> {
    return Promise.all(this.peers.list().map((peer) => this.view(peer)))
  }

  subscribe(listener: SyncPeerChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  updateProgress(id: string, patch: SyncPeerProgress): void {
    if (!this.peers.get(id)) throw new SyncPeerNotFoundError(id)
    this.state.update((state) => {
      state.peers[id] = { ...state.peers[id], ...patch }
    })
  }

  async get(id: string): Promise<SyncPeerView | undefined> {
    const peer = this.peers.get(id)
    return peer ? this.view(peer) : undefined
  }

  async connectionData(id: string): Promise<{ peer: SyncPeer; secrets: SyncPeerSecrets }> {
    const peer = this.peers.get(id)
    if (!peer) throw new SyncPeerNotFoundError(id)
    const record = await this.credentials.readRecord(this.credentialKey(id))
    return { peer, secrets: payloadFromRecord(record) }
  }

  async pinHostKey(id: string, fingerprint: string): Promise<SyncPeerView> {
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) {
      throw new SyncPeerInputError('invalid SSH host-key fingerprint')
    }
    const peer = this.peers.update(id, { hostKeyFingerprint: fingerprint })
    return this.view(peer)
  }

  async create(draftValue: unknown, secretsValue?: unknown): Promise<SyncPeerView> {
    let draft: SyncPeerDraft
    let secrets: SyncPeerSecrets | undefined
    try {
      draft = parseSyncPeerDraft(draftValue)
      secrets = parseSecrets(secretsValue)
      validateAuthSecrets(draft.authKind, secrets, secrets ?? {})
    } catch (error) {
      throw asInputError(error)
    }

    const peer = this.peers.create(draft)
    let attemptedSecrets = false
    try {
      if (secrets) {
        attemptedSecrets = true
        await this.writeSecrets(peer.id, secretsForAuth(peer.authKind, secrets))
      }
      const view = await this.view(peer)
      this.notify(peer.id, peer)
      return view
    } catch (error) {
      this.peers.remove(peer.id)
      if (attemptedSecrets) {
        try {
          await this.credentials.deleteRecord(this.credentialKey(peer.id))
        } catch {}
      }
      throw error
    }
  }

  async update(id: string, patchValue: unknown, secretsValue?: unknown): Promise<SyncPeerView> {
    const current = this.peers.get(id)
    if (!current) throw new SyncPeerNotFoundError(id)

    let patch: Partial<Omit<SyncPeer, 'id' | 'hostKeyFingerprint'>>
    let secrets: SyncPeerSecrets | undefined
    try {
      const input = asRecord(patchValue, 'sync peer patch')
      for (const key of Object.keys(input)) {
        if (!PATCH_FIELDS.has(key)) throw new SyncPeerInputError(`unsupported peer field: ${key}`)
      }
      const validated = parseSyncPeer({ ...current, ...input, id })
      const { id: _id, hostKeyFingerprint: _fingerprint, ...validatedPatch } = validated
      void _id
      void _fingerprint
      patch = validatedPatch
      secrets = parseSecrets(secretsValue)
    } catch (error) {
      throw asInputError(error)
    }

    const credentialKeyValue = this.credentialKey(id)
    const previousRecord = await this.credentials.readRecord(credentialKeyValue)
    const effectiveSecrets = { ...payloadFromRecord(previousRecord), ...secrets }
    const authKind = patch.authKind ?? current.authKind
    validateAuthSecrets(authKind, secrets, effectiveSecrets)
    if (secrets || authKind !== current.authKind) {
      try {
        await this.writeSecrets(id, secretsForAuth(authKind, effectiveSecrets))
      } catch (error) {
        await this.restoreCredentialRecord(credentialKeyValue, previousRecord)
        throw error
      }
    }

    let updated: SyncPeer
    try {
      updated = this.peers.update(id, patch)
    } catch (error) {
      await this.restoreCredentialRecord(credentialKeyValue, previousRecord)
      throw error
    }
    this.notify(id, updated)
    return this.view(updated)
  }

  async remove(id: string): Promise<boolean> {
    if (!this.peers.get(id)) return false
    this.peers.remove(id)
    this.notify(id, undefined)
    await this.credentials.deleteRecord(this.credentialKey(id))
    this.state.update((state) => {
      delete state.peers[id]
    })
    return true
  }

  private async view(peer: SyncPeer): Promise<SyncPeerView> {
    const record = await this.credentials.readRecord(this.credentialKey(peer.id))
    const progress = this.state.read().peers[peer.id]
    return { ...toView(peer, payloadFromRecord(record)), ...(progress ? { progress } : {}) }
  }

  private notify(peerId: string, peer: SyncPeer | undefined): void {
    for (const listener of this.listeners) {
      try {
        listener(peerId, peer)
      } catch {}
    }
  }

  private async writeSecrets(id: string, secrets: SyncPeerSecrets): Promise<void> {
    const key = this.credentialKey(id)
    await this.credentials.modifyRecord(key, async (_current) => ({
      kind: 'grant',
      payload: secrets,
    }) as CredentialRecord)
  }

  private async restoreCredentialRecord(key: CredentialKey, previous: unknown): Promise<void> {
    try {
      if (previous === undefined) await this.credentials.deleteRecord(key)
      else await this.credentials.modifyRecord(key, async () => previous)
    } catch {}
  }

  private credentialKey(id: string): CredentialKey {
    try {
      return credentialKey('dshb-core', id)
    } catch {
      throw new Error('credentials service unavailable')
    }
  }
}
