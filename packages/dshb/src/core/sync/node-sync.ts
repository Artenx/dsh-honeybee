import { createHash } from 'node:crypto'
import { compareSyncRevision, HybridLogicalClock } from './revision.js'
import { isNonNegativeSafeInteger, isRecord, syncRecordKey, type SyncImportMethod, type SyncRecordMetadata, type SyncState } from './model.js'
import { NodeRegistry, type NodeCreateInput, type NodeDocker, type NodeProfile, type NodeSecrets, type NodeSsh } from '../node-registry.js'
import type { WorkspaceBindingsStore } from '../workspace-bindings.js'
import type { SyncStateStore } from './stores.js'

const MAX_NODE_RECORDS = 10_000
const MAX_SECRET_BYTES = 64 * 1024

export interface SyncNodeProfile {
  name: string
  type: 'remote-ssh' | 'remote-docker'
  ssh: NodeSsh
  docker?: NodeDocker
}

export interface SyncNodeEntry {
  metadata: SyncRecordMetadata
  profile?: SyncNodeProfile
  secrets?: NodeSecrets
}

export interface SyncNodeManifest {
  protocolVersion: 1
  instanceId: string
  records: SyncNodeEntry[]
}

export interface SyncNodeApplyResult {
  created: number
  updated: number
  deleted: number
  pendingRemoval: number
  skipped: number
}

export interface SyncNodeView {
  importedVia?: 'peer' | 'offline'
  sourceName?: string
  pendingRemoval: boolean
  credentialsRequired?: boolean
}

export class SyncNodeManifestError extends Error {
  constructor(message = 'invalid node sync manifest') {
    super(message)
    this.name = 'SyncNodeManifestError'
  }
}

export class SyncNodeInUseError extends Error {
  constructor(readonly workspaces: string[]) {
    super('node is still bound to active workspaces')
    this.name = 'SyncNodeInUseError'
  }
}

interface WorkspaceRegistryLike {
  list(): Array<{ path: string; title: string }>
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  const entries = Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
  return `{${entries.join(',')}}`
}

function nodeDigest(profile: SyncNodeProfile, secrets: NodeSecrets | undefined, credentialsRequired: boolean): string {
  const canonicalSecrets = secrets && Object.keys(secrets).length > 0 ? secrets : null
  return `sha256:${createHash('sha256').update(canonicalJson({ profile, secrets: canonicalSecrets, credentialsRequired })).digest('hex')}`
}

function tombstoneDigest(metadata: Pick<SyncRecordMetadata, 'originInstanceId' | 'originEntityId'>): string {
  const origin = { originInstanceId: metadata.originInstanceId, originEntityId: metadata.originEntityId }
  return `sha256:${createHash('sha256').update(canonicalJson({ kind: 'node', origin, deleted: true })).digest('hex')}`
}

function syncable(node: NodeProfile): node is NodeProfile & { type: 'remote-ssh' | 'remote-docker'; ssh: NodeSsh } {
  return (node.type === 'remote-ssh' || node.type === 'remote-docker') && Boolean(node.ssh)
}

function sanitizedProfile(node: NodeProfile): SyncNodeProfile {
  if (!syncable(node)) throw new Error('node is outside the sync scope')
  return {
    name: node.name,
    type: node.type,
    ssh: {
      host: node.ssh.host,
      port: node.ssh.port,
      username: node.ssh.username,
      auth: { kind: node.ssh.auth.kind },
      ...(node.ssh.jump ? {
        jump: node.ssh.jump.map(({ host, port, username }) => ({ host, ...(port ? { port } : {}), ...(username ? { username } : {}) })),
      } : {}),
      ...(node.ssh.hostKeyFingerprint ? { hostKeyFingerprint: node.ssh.hostKeyFingerprint } : {}),
    },
    ...(node.docker ? { docker: { ...node.docker, ...(node.docker.resources ? { resources: { ...node.docker.resources } } : {}) } } : {}),
  }
}

function credentialsRequired(profile: SyncNodeProfile, secrets: NodeSecrets | undefined): boolean {
  if (profile.ssh.auth.kind === 'agent') return true
  if (profile.ssh.auth.kind === 'password') return !secrets?.password
  return !secrets?.privateKey
}

function shareableSecrets(profile: SyncNodeProfile, secrets: NodeSecrets | undefined): NodeSecrets | undefined {
  if (profile.ssh.auth.kind === 'agent') return undefined
  if (profile.ssh.auth.kind === 'password') {
    return secrets?.password ? { password: secrets.password } : undefined
  }
  return secrets?.privateKey
    ? { privateKey: secrets.privateKey, ...(secrets.passphrase ? { passphrase: secrets.passphrase } : {}) }
    : undefined
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid node sync ${label}`)
  }
  return value.trim()
}

function parseSsh(value: unknown): NodeSsh {
  if (!isRecord(value)) throw new Error('invalid node sync SSH configuration')
  const allowed = new Set(['host', 'port', 'username', 'auth', 'jump', 'hostKeyFingerprint'])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('unsupported node sync SSH field')
  if (!Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) {
    throw new Error('invalid node sync SSH port')
  }
  if (!isRecord(value.auth) || !['password', 'key', 'agent'].includes(String(value.auth.kind))) {
    throw new Error('invalid node sync SSH auth method')
  }
  if (Object.keys(value.auth).some((key) => key !== 'kind')) throw new Error('SSH key paths cannot be imported')
  const jump = value.jump
  if (jump !== undefined && !Array.isArray(jump)) throw new Error('invalid node sync SSH jump list')
  const parsedJump = jump?.map((hop) => {
    if (!isRecord(hop) || Object.keys(hop).some((key) => !['host', 'port', 'username'].includes(key))) {
      throw new Error('invalid node sync SSH jump hop')
    }
    if (hop.port !== undefined && (!Number.isSafeInteger(hop.port) || (hop.port as number) < 1 || (hop.port as number) > 65535)) {
      throw new Error('invalid node sync SSH jump port')
    }
    const host = text(hop.host, 'SSH jump host', 255)
    const username = hop.username === undefined ? undefined : text(hop.username, 'SSH jump username', 128)
    if (/\s/.test(host) || (username !== undefined && /\s/.test(username))) throw new Error('invalid node sync SSH jump address')
    return {
      host,
      ...(hop.port === undefined ? {} : { port: hop.port as number }),
      ...(username === undefined ? {} : { username }),
    }
  })
  const fingerprint = value.hostKeyFingerprint
  if (fingerprint !== undefined && (typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint))) {
    throw new Error('invalid node sync SSH host-key fingerprint')
  }
  const host = text(value.host, 'SSH host', 255)
  const username = text(value.username, 'SSH username', 128)
  if (/\s/.test(host) || /\s/.test(username)) throw new Error('invalid node sync SSH address')
  return {
    host,
    port: value.port as number,
    username,
    auth: { kind: value.auth.kind as NodeSsh['auth']['kind'] },
    ...(parsedJump ? { jump: parsedJump } : {}),
    ...(typeof fingerprint === 'string' ? { hostKeyFingerprint: fingerprint } : {}),
  }
}

function parseDocker(value: unknown): NodeDocker {
  if (!isRecord(value)) throw new Error('invalid node sync Docker configuration')
  const allowed = new Set(['mode', 'containerId', 'image', 'resources'])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('unsupported node sync Docker field')
  if (value.mode !== 'existing' && value.mode !== 'managed') throw new Error('invalid node sync Docker mode')
  const containerId = value.containerId === undefined ? undefined : text(value.containerId, 'Docker container ID', 256)
  const image = value.image === undefined ? undefined : text(value.image, 'Docker image', 512)
  let resources: NodeDocker['resources']
  if (value.resources !== undefined) {
    if (!isRecord(value.resources) || Object.keys(value.resources).some((key) => !['cpus', 'memoryMB'].includes(key))) {
      throw new Error('invalid node sync Docker resources')
    }
    const cpus = value.resources.cpus
    const memoryMB = value.resources.memoryMB
    if (cpus !== undefined && (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus <= 0)) {
      throw new Error('invalid node sync Docker CPU limit')
    }
    if (memoryMB !== undefined && (!Number.isSafeInteger(memoryMB) || (memoryMB as number) <= 0)) {
      throw new Error('invalid node sync Docker memory limit')
    }
    resources = {
      ...(cpus === undefined ? {} : { cpus: cpus as number }),
      ...(memoryMB === undefined ? {} : { memoryMB: memoryMB as number }),
    }
  }
  return {
    mode: value.mode,
    ...(containerId === undefined ? {} : { containerId }),
    ...(image === undefined ? {} : { image }),
    ...(resources ? { resources } : {}),
  }
}

function parseProfile(value: unknown): SyncNodeProfile {
  if (!isRecord(value)) throw new Error('invalid node sync profile')
  if (Object.keys(value).some((key) => !['name', 'type', 'ssh', 'docker'].includes(key))) {
    throw new Error('unsupported node sync profile field')
  }
  if (value.type !== 'remote-ssh' && value.type !== 'remote-docker') {
    throw new Error('local nodes cannot be imported')
  }
  const ssh = parseSsh(value.ssh)
  if (value.type === 'remote-ssh' && value.docker !== undefined) throw new Error('SSH node contains Docker configuration')
  if (value.type === 'remote-docker' && value.docker === undefined) throw new Error('remote Docker node requires Docker configuration')
  return {
    name: text(value.name, 'name', 64),
    type: value.type,
    ssh,
    ...(value.docker === undefined ? {} : { docker: parseDocker(value.docker) }),
  }
}

function parseSecrets(value: unknown): NodeSecrets | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).some((key) => !['password', 'privateKey', 'passphrase'].includes(key))) {
    throw new Error('invalid node sync secret payload')
  }
  const result: NodeSecrets = {}
  for (const key of ['password', 'privateKey', 'passphrase'] as const) {
    const secret = value[key]
    if (secret === undefined) continue
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES || secret.includes('\0')) {
      throw new Error(`invalid node sync secret: ${key}`)
    }
    if (secret) result[key] = secret
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function validateMetadata(value: unknown): SyncRecordMetadata {
  const safeText = (input: unknown): input is string =>
    typeof input === 'string' && input.length > 0 && input.length <= 512 && !/[\u0000-\u001f\u007f]/.test(input)
  if (
    !isRecord(value) || value.kind !== 'node' ||
    !safeText(value.originInstanceId) ||
    !safeText(value.originEntityId) ||
    !safeText(value.localEntityId) ||
    !isRecord(value.revision) ||
    !isNonNegativeSafeInteger(value.revision.physicalTimeMs) ||
    !isNonNegativeSafeInteger(value.revision.logicalCounter) ||
    !safeText(value.revision.writerInstanceId) ||
    typeof value.contentDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.contentDigest) ||
    (value.deleted !== undefined && typeof value.deleted !== 'boolean') ||
    (value.pendingRemoval !== undefined && typeof value.pendingRemoval !== 'boolean') ||
    (value.credentialsRequired !== undefined && typeof value.credentialsRequired !== 'boolean') ||
    (value.importedVia !== undefined && value.importedVia !== 'peer' && value.importedVia !== 'offline') ||
    (value.sourceName !== undefined && !safeText(value.sourceName))
  ) {
    throw new Error('invalid node sync metadata')
  }
  return value as unknown as SyncRecordMetadata
}

function makeTombstone(metadata: SyncRecordMetadata, revision: SyncRecordMetadata['revision']): SyncRecordMetadata {
  const origin = { originInstanceId: metadata.originInstanceId, originEntityId: metadata.originEntityId }
  return {
    ...metadata,
    revision,
    contentDigest: tombstoneDigest(origin),
    deleted: true,
    pendingRemoval: false,
  }
}

function makePlaceholderLocalId(origin: { originInstanceId: string; originEntityId: string }): string {
  return `t-${createHash('sha256').update(canonicalJson(origin)).digest('hex').slice(0, 24)}`
}

function makeImportedLocalId(origin: { originInstanceId: string; originEntityId: string }): string {
  return `s-${createHash('sha256').update(canonicalJson(origin)).digest('hex').slice(0, 32)}`
}

export class SyncNodeService {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly registry: NodeRegistry,
    private readonly bindings: WorkspaceBindingsStore,
    private readonly state: SyncStateStore,
    private readonly getWorkspaceRegistry?: () => WorkspaceRegistryLike | undefined,
    private readonly disposeWorld?: (nodeId: string) => void,
  ) {}

  exportManifest(): Promise<SyncNodeManifest> {
    return this.serializeMutation(() => this.exportManifestNow())
  }

  private async exportManifestNow(): Promise<SyncNodeManifest> {
    const instanceId = this.state.instanceId()
    const initial = this.state.read()
    const clock = new HybridLogicalClock(instanceId, initial.clock)
    const records = new Map(Object.entries(initial.records))
    const changed = new Map<string, SyncRecordMetadata>()
    const localRecords = new Map<string, SyncRecordMetadata>()
    for (const metadata of records.values()) {
      if (metadata.kind !== 'node') continue
      const existing = localRecords.get(metadata.localEntityId)
      if (!existing || compareSyncRevision(metadata.revision, existing.revision) > 0) {
        localRecords.set(metadata.localEntityId, metadata)
      }
    }
    const entries: SyncNodeEntry[] = []
    for (const node of this.registry.list()) {
      if (!syncable(node)) continue
      const profile = sanitizedProfile(node)
      const secrets = shareableSecrets(profile, parseSecrets(await this.registry.getSecrets(node.id)))
      const credentialsNeeded = credentialsRequired(profile, secrets)
      const digest = nodeDigest(profile, secrets, credentialsNeeded)
      const current = localRecords.get(node.id)
      if (current?.deleted) continue
      let metadata = current
      if (!metadata || metadata.contentDigest !== digest || metadata.credentialsRequired !== credentialsNeeded) {
        const revision = clock.tick()
        metadata = {
          ...(current ?? {
            kind: 'node' as const,
            originInstanceId: instanceId,
            originEntityId: node.id,
            localEntityId: node.id,
          }),
          kind: 'node',
          localEntityId: node.id,
          revision,
          contentDigest: digest,
          deleted: false,
          pendingRemoval: false,
          credentialsRequired: credentialsNeeded,
        }
        const key = syncRecordKey('node', metadata)
        records.set(key, metadata)
        localRecords.set(node.id, metadata)
        changed.set(key, metadata)
      }
      entries.push({ metadata, profile, ...(secrets ? { secrets } : {}) })
    }

    for (const metadata of records.values()) {
      if (metadata.kind === 'node' && metadata.deleted && !entries.some((entry) => sameOrigin(entry.metadata, metadata))) {
        entries.push({ metadata })
      }
    }
    if (changed.size > 0) {
      this.state.update((state) => {
        mergeClock(state, clock.snapshot())
        for (const [key, metadata] of changed) state.records[key] = metadata
      })
    }
    return { protocolVersion: 1, instanceId, records: entries }
  }

  validateManifest(value: unknown): SyncNodeEntry[] {
    if (!Array.isArray(value) || value.length > MAX_NODE_RECORDS) throw new SyncNodeManifestError()
    try {
      const entries = value.map(parseEntry)
      const keys = entries.map((entry) => syncRecordKey('node', entry.metadata))
      if (new Set(keys).size !== keys.length) throw new Error('duplicate origins')
      return entries
    } catch (error) {
      throw new SyncNodeManifestError(error instanceof Error ? error.message : 'invalid node sync manifest')
    }
  }

  async preflightManifest(value: unknown): Promise<void> {
    const entries = this.validateManifest(value)
    const localInstanceId = this.state.instanceId()
    const state = this.state.read()
    for (const entry of entries) {
      const { metadata } = entry
      const current = state.records[syncRecordKey('node', metadata)]
      if (current) {
        const comparison = compareSyncRevision(metadata.revision, current.revision)
        if (comparison === 0 && (metadata.contentDigest !== current.contentDigest || Boolean(metadata.deleted) !== Boolean(current.deleted))) {
          throw new SyncNodeManifestError('conflicting node records share the same revision')
        }
        continue
      }
      if (metadata.originInstanceId !== localInstanceId || metadata.deleted) continue
      const local = this.registry.get(metadata.originEntityId)
      if (!local) continue
      const profile = sanitizedProfile(local)
      const secrets = shareableSecrets(profile, parseSecrets(await this.registry.getSecrets(local.id)))
      const required = credentialsRequired(profile, secrets)
      if (nodeDigest(profile, secrets, required) !== metadata.contentDigest) {
        throw new SyncNodeManifestError('local origin metadata is missing for a changed node')
      }
    }
  }

  applyManifest(value: unknown, sourceName: string, importedVia: SyncImportMethod = 'peer'): Promise<SyncNodeApplyResult> {
    return this.serializeMutation(() => this.applyManifestNow(value, sourceName, importedVia))
  }

  private async applyManifestNow(value: unknown, sourceName: string, importedVia: SyncImportMethod): Promise<SyncNodeApplyResult> {
    await this.preflightManifest(value)
    const entries = this.validateManifest(value)
    let safeSourceName: string
    try {
      safeSourceName = text(sourceName, 'source name', 128)
    } catch (error) {
      throw new SyncNodeManifestError(error instanceof Error ? error.message : 'invalid node sync manifest')
    }
    const result: SyncNodeApplyResult = { created: 0, updated: 0, deleted: 0, pendingRemoval: 0, skipped: 0 }
    const localInstanceId = this.state.instanceId()
    const initial = this.state.read()
    const clock = new HybridLogicalClock(localInstanceId, initial.clock)
    const records = new Map(Object.entries(initial.records))
    const changed = new Map<string, SyncRecordMetadata>()

    for (const entry of entries) {
      const { metadata } = entry
      const key = syncRecordKey('node', metadata)
      const current = records.get(key)
      if (metadata.originInstanceId === localInstanceId && !current) {
        const local = this.registry.get(metadata.originEntityId)
        if (local && !metadata.deleted) {
          const localProfile = sanitizedProfile(local)
          const localSecrets = shareableSecrets(localProfile, parseSecrets(await this.registry.getSecrets(local.id)))
          const localRequired = credentialsRequired(localProfile, localSecrets)
          if (nodeDigest(localProfile, localSecrets, localRequired) !== metadata.contentDigest) {
            throw new SyncNodeManifestError('local origin metadata is missing for a changed node')
          }
          clock.observe(metadata.revision)
          const localMetadata = { ...metadata, localEntityId: local.id, importedVia: undefined, sourceName: undefined }
          records.set(key, localMetadata)
          changed.set(key, localMetadata)
          this.state.update((state) => {
            mergeClock(state, clock.snapshot())
            state.records[key] = localMetadata
          })
          result.skipped += 1
          continue
        }
      }

      if (current) {
        const comparison = compareSyncRevision(metadata.revision, current.revision)
        if (comparison < 0) {
          result.skipped += 1
          continue
        }
        if (comparison === 0) {
          if (metadata.contentDigest !== current.contentDigest || Boolean(metadata.deleted) !== Boolean(current.deleted)) {
            throw new SyncNodeManifestError('conflicting node records share the same revision')
          }
          result.skipped += 1
          continue
        }
      }
      clock.observe(metadata.revision)

      const mappedLocalId = current?.deleted && current.localEntityId.startsWith('t-')
        ? undefined
        : current?.localEntityId
      if (metadata.deleted) {
        const localId = mappedLocalId ?? (metadata.originInstanceId === localInstanceId
          ? metadata.originEntityId
          : makePlaceholderLocalId(metadata))
        const pendingMetadata = {
          ...metadata,
          localEntityId: localId,
          importedVia: metadata.originInstanceId === localInstanceId ? undefined : importedVia,
          sourceName: metadata.originInstanceId === localInstanceId ? undefined : safeSourceName,
          pendingRemoval: true,
        }
        this.saveRecord(pendingMetadata)
        records.set(key, pendingMetadata)
        changed.set(key, pendingMetadata)
        const pending = this.hasActiveBinding(localId)
        if (pending) {
          result.pendingRemoval += 1
        } else {
          await this.removeNodeAndStaleBindings(localId)
          const tombstoneMetadata = {
            ...metadata,
            localEntityId: localId,
            importedVia: metadata.originInstanceId === localInstanceId ? undefined : importedVia,
            sourceName: metadata.originInstanceId === localInstanceId ? undefined : safeSourceName,
            pendingRemoval: false,
          }
          records.set(key, tombstoneMetadata)
          changed.set(key, tombstoneMetadata)
          this.saveRecord(tombstoneMetadata)
          result.deleted += 1
        }
        continue
      }

      if (!entry.profile) throw new SyncNodeManifestError('node profile is missing from active manifest record')
      const input = toNodeCreateInput(entry.profile, entry.secrets)
      const localId = mappedLocalId ?? (metadata.originInstanceId === localInstanceId
        ? metadata.originEntityId
        : makeImportedLocalId(metadata))
      let node: NodeProfile
      if (this.registry.get(localId)) {
        node = await this.registry.updateImported(localId, input)
        result.updated += 1
      } else {
        node = await this.registry.createImported(input, localId)
        result.created += 1
      }
      this.disposeWorld?.(node.id)
      const appliedMetadata = {
        ...metadata,
        localEntityId: node.id,
        importedVia: metadata.originInstanceId === localInstanceId ? undefined : importedVia,
        sourceName: metadata.originInstanceId === localInstanceId ? undefined : safeSourceName,
        deleted: false,
        pendingRemoval: false,
        credentialsRequired: credentialsRequired(entry.profile, entry.secrets),
      }
      records.set(key, appliedMetadata)
      changed.set(key, appliedMetadata)
      this.state.update((state) => {
        mergeClock(state, clock.snapshot())
        state.records[key] = appliedMetadata
      })
    }

    const finalClock = clock.snapshot()
    if (
      changed.size > 0 ||
      finalClock.physicalTimeMs !== initial.clock.physicalTimeMs ||
      finalClock.logicalCounter !== initial.clock.logicalCounter
    ) {
      this.state.update((state) => {
        mergeClock(state, finalClock)
        for (const [key, metadata] of changed) state.records[key] = metadata
      })
    }
    return result
  }

  removeLocalNode(nodeId: string, remove: () => Promise<void>): Promise<void> {
    return this.serializeMutation(() => this.removeLocalNodeNow(nodeId, remove))
  }

  private async removeLocalNodeNow(nodeId: string, remove: () => Promise<void>): Promise<void> {
    const node = this.registry.get(nodeId)
    if (!node || !syncable(node)) {
      await remove()
      return
    }

    const active = this.activeBindings(nodeId)
    if (active.length > 0) throw new SyncNodeInUseError(active.map((binding) => binding.workspaceId ?? binding.mirrorPath))

    const current = findNodeRecord(Object.values(this.state.read().records), nodeId)
    const instanceId = this.state.instanceId()
    const origin = current ?? {
      kind: 'node' as const,
      originInstanceId: instanceId,
      originEntityId: nodeId,
      localEntityId: nodeId,
      revision: { physicalTimeMs: 0, logicalCounter: 0, writerInstanceId: instanceId },
      contentDigest: '',
    }
    const tombstone = { ...makeTombstone(origin, this.state.nextRevision()), pendingRemoval: true }
    const key = syncRecordKey('node', tombstone)
    this.saveRecord(tombstone)
    try {
      await remove()
      this.saveRecord({ ...tombstone, pendingRemoval: false })
    } catch (error) {
      this.state.update((state) => {
        if (current) state.records[key] = current
        else delete state.records[key]
      })
      throw error
    }
  }

  view(nodeId: string): SyncNodeView | undefined {
    return this.views([nodeId]).get(nodeId)
  }

  views(nodeIds: readonly string[]): Map<string, SyncNodeView> {
    const wanted = new Set(nodeIds)
    const metadataById = new Map<string, SyncRecordMetadata>()
    for (const metadata of Object.values(this.state.read().records)) {
      if (metadata.kind !== 'node' || !wanted.has(metadata.localEntityId)) continue
      const current = metadataById.get(metadata.localEntityId)
      if (!current || compareSyncRevision(metadata.revision, current.revision) > 0) {
        metadataById.set(metadata.localEntityId, metadata)
      }
    }
    const views = new Map<string, SyncNodeView>()
    for (const [localId, metadata] of metadataById) {
      views.set(localId, {
        ...(metadata.importedVia ? { importedVia: metadata.importedVia } : {}),
        ...(metadata.sourceName ? { sourceName: metadata.sourceName } : {}),
        pendingRemoval: Boolean(metadata.deleted && metadata.pendingRemoval),
        ...(metadata.credentialsRequired === undefined ? {} : { credentialsRequired: metadata.credentialsRequired }),
      })
    }
    return views
  }

  isPendingRemoval(nodeId: string): boolean {
    return this.view(nodeId)?.pendingRemoval ?? false
  }

  originForLocalNode(nodeId: string): { originInstanceId: string; originEntityId: string } | undefined {
    const metadata = findNodeRecord(Object.values(this.state.read().records), nodeId)
    return !metadata || metadata.deleted
      ? undefined
      : { originInstanceId: metadata.originInstanceId, originEntityId: metadata.originEntityId }
  }

  localNodeIdForOrigin(origin: { originInstanceId: string; originEntityId: string }): string | undefined {
    const metadata = Object.values(this.state.read().records)
      .filter((record) => record.kind === 'node' &&
        record.originInstanceId === origin.originInstanceId && record.originEntityId === origin.originEntityId)
      .sort((a, b) => compareSyncRevision(b.revision, a.revision))[0]
    return !metadata || metadata.deleted ? undefined : metadata.localEntityId
  }

  withAvailableRemoteNode<T>(
    origin: { originInstanceId: string; originEntityId: string },
    operation: (nodeId: string) => Promise<T>,
  ): Promise<T | undefined> {
    return this.serializeMutation(async () => {
      const nodeId = this.localNodeIdForOrigin(origin)
      const node = nodeId ? this.registry.get(nodeId) : undefined
      if (!node || !syncable(node) || this.isPendingRemoval(node.id)) return undefined
      return operation(node.id)
    })
  }

  reconcilePendingRemovals(): Promise<void> {
    return this.serializeMutation(() => this.reconcilePendingRemovalsNow())
  }

  private async reconcilePendingRemovalsNow(): Promise<void> {
    const records = Object.values(this.state.read().records).filter(
      (metadata) => metadata.kind === 'node' && metadata.deleted && metadata.pendingRemoval,
    )
    for (const metadata of records) {
      if (this.hasActiveBinding(metadata.localEntityId)) continue
      await this.removeNodeAndStaleBindings(metadata.localEntityId)
      this.saveRecord({ ...metadata, pendingRemoval: false })
    }
  }

  private hasActiveBinding(nodeId: string): boolean {
    return this.activeBindings(nodeId).length > 0
  }

  private activeBindings(nodeId: string): Array<{ mirrorPath: string; workspaceId?: string }> {
    const bindings = this.bindings.list().filter((binding) => binding.nodeId === nodeId)
    if (bindings.length === 0) return []
    let registry: WorkspaceRegistryLike | undefined
    try {
      registry = this.getWorkspaceRegistry?.()
    } catch {}
    if (!registry) return bindings
    try {
      const activePaths = new Set(registry.list().map((workspace) => workspace.path))
      return bindings.filter((binding) => activePaths.has(binding.mirrorPath))
    } catch {
      return bindings
    }
  }

  private async removeNodeAndStaleBindings(nodeId: string): Promise<void> {
    const bindings = this.bindings.list().filter((binding) => binding.nodeId === nodeId)
    let activePaths: Set<string> | undefined
    try {
      const registry = this.getWorkspaceRegistry?.()
      if (registry) activePaths = new Set(registry.list().map((workspace) => workspace.path))
    } catch {}
    for (const binding of bindings) {
      if (activePaths?.has(binding.mirrorPath)) continue
      this.bindings.remove(binding.mirrorPath)
    }
    if (this.registry.get(nodeId)) {
      await this.registry.removeImported(nodeId)
      this.disposeWorld?.(nodeId)
    } else {
      await this.registry.removeImported(nodeId)
    }
  }

  private saveRecord(metadata: SyncRecordMetadata): void {
    const key = syncRecordKey('node', metadata)
    this.state.update((state) => {
      state.records[key] = metadata
    })
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function mergeClock(state: SyncState, incoming: SyncState['clock']): void {
  if (
    incoming.physicalTimeMs > state.clock.physicalTimeMs ||
    (incoming.physicalTimeMs === state.clock.physicalTimeMs && incoming.logicalCounter > state.clock.logicalCounter)
  ) {
    state.clock = incoming
  }
}

function findNodeRecord(records: Iterable<SyncRecordMetadata>, localId: string): SyncRecordMetadata | undefined {
  return [...records]
    .filter((metadata) => metadata.kind === 'node' && metadata.localEntityId === localId)
    .sort((a, b) => compareSyncRevision(b.revision, a.revision))[0]
}

function sameOrigin(a: SyncRecordMetadata, b: SyncRecordMetadata): boolean {
  return a.kind === b.kind && a.originInstanceId === b.originInstanceId && a.originEntityId === b.originEntityId
}

function toNodeCreateInput(profile: SyncNodeProfile, secrets?: NodeSecrets): NodeCreateInput {
  return {
    name: profile.name,
    type: profile.type,
    ssh: profile.ssh,
    ...(profile.docker ? { docker: profile.docker } : {}),
    ...(secrets ? { secrets } : {}),
  }
}

function parseEntry(value: unknown): SyncNodeEntry {
  if (!isRecord(value)) throw new Error('invalid node sync entry')
  const metadata = validateMetadata(value.metadata)
  if (metadata.deleted) {
    if (value.profile !== undefined || value.secrets !== undefined || metadata.contentDigest !== tombstoneDigest(metadata)) {
      throw new Error('invalid node sync tombstone')
    }
    return { metadata }
  }

  const profile = parseProfile(value.profile)
  const rawSecrets = parseSecrets(value.secrets)
  if (
    (profile.ssh.auth.kind === 'agent' && rawSecrets) ||
    (profile.ssh.auth.kind === 'password' && (rawSecrets?.privateKey || rawSecrets?.passphrase)) ||
    (profile.ssh.auth.kind === 'key' && (rawSecrets?.password || (!rawSecrets?.privateKey && rawSecrets?.passphrase)))
  ) {
    throw new Error('node sync secrets do not match the SSH auth method')
  }
  const secrets = shareableSecrets(profile, rawSecrets)
  const needed = credentialsRequired(profile, secrets)
  if (metadata.credentialsRequired !== undefined && metadata.credentialsRequired !== needed) {
    throw new Error('node sync credential status does not match its payload')
  }
  if (metadata.contentDigest !== nodeDigest(profile, secrets, needed)) throw new Error('node sync digest mismatch')
  return { metadata: { ...metadata, credentialsRequired: needed }, profile, ...(secrets ? { secrets } : {}) }
}
