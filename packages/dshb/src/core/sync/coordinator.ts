import { createHash } from 'node:crypto'
import { SyncNodeManifestError, type SyncNodeApplyResult, type SyncNodeEntry, type SyncNodeService } from './node-sync.js'
import { SyncHostKeyChallengeError } from './host-key.js'
import { compareSyncRevision } from './revision.js'
import { syncRecordKey, type SyncPeer } from './model.js'
import { SyncPeerManager, SyncPeerNotFoundError } from './peer-manager.js'
import type { SyncStateStore } from './stores.js'
import { SyncSshProbeError, SyncSshTransport } from './ssh-transport.js'
import { makeSyncSessionBundle, planSessionTransfers, SyncSessionError, SyncSessionService, validateSyncSessionBundle } from './session-sync.js'
import type { SyncSessionApplyResult } from './session-sync.js'

const EMPTY_APPLY_RESULT: SyncNodeApplyResult = { created: 0, updated: 0, deleted: 0, pendingRemoval: 0, skipped: 0 }
const TRANSPORT_RETRY_DELAY_MS = 250

export interface NodeTransferPlan {
  toLocal: SyncNodeEntry[]
  toRemote: SyncNodeEntry[]
  skipped: number
}

export interface SyncRunSummary {
  peerId: string
  direction: SyncPeer['direction']
  startedAt: string
  finishedAt: string
  remoteInstanceId: string
  imported: number
  exported: number
  skipped: number
  pendingRemoval: number
  importedSessions: number
  exportedSessions: number
  skippedSessions: number
}

export class SyncCoordinatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SyncCoordinatorError'
  }
}

function addCount(result: SyncNodeApplyResult): number {
  return result.created + result.updated + result.deleted
}

function manifestDigest(entries: readonly SyncNodeEntry[]): string {
  const versions = entries
    .map((entry) => ({
      key: syncRecordKey('node', entry.metadata),
      revision: entry.metadata.revision,
      contentDigest: entry.metadata.contentDigest,
      deleted: Boolean(entry.metadata.deleted),
    }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  return `sha256:${createHash('sha256').update(JSON.stringify(versions)).digest('hex')}`
}

export function planNodeTransfers(
  direction: SyncPeer['direction'],
  localEntries: readonly SyncNodeEntry[],
  remoteEntries: readonly SyncNodeEntry[],
): NodeTransferPlan {
  const toLocal: SyncNodeEntry[] = []
  const toRemote: SyncNodeEntry[] = []
  if (direction === 'pull') return { toLocal: [...remoteEntries], toRemote, skipped: 0 }

  const localByKey = new Map(localEntries.map((entry) => [syncRecordKey('node', entry.metadata), entry]))
  const remoteByKey = new Map(remoteEntries.map((entry) => [syncRecordKey('node', entry.metadata), entry]))
  const keys = new Set([...localByKey.keys(), ...remoteByKey.keys()])
  let skipped = 0

  for (const key of keys) {
    const local = localByKey.get(key)
    const remote = remoteByKey.get(key)
    if (!local) {
      toLocal.push(remote!)
      continue
    }
    if (!remote) {
      toRemote.push(local)
      continue
    }

    const comparison = compareSyncRevision(local.metadata.revision, remote.metadata.revision)
    if (comparison > 0) {
      toRemote.push(local)
    } else if (comparison < 0) {
      toLocal.push(remote)
    } else if (
      local.metadata.contentDigest === remote.metadata.contentDigest &&
      Boolean(local.metadata.deleted) === Boolean(remote.metadata.deleted)
    ) {
      skipped += 1
    } else {
      throw new SyncCoordinatorError('revision-conflict', 'Equal node revisions contain different content')
    }
  }
  return { toLocal, toRemote, skipped }
}

function mapFailure(error: unknown): SyncCoordinatorError {
  if (error instanceof SyncCoordinatorError) return error
  if (error instanceof SyncPeerNotFoundError) return new SyncCoordinatorError('peer-not-found', '同步节点已不存在')
  if (error instanceof SyncHostKeyChallengeError) {
    const code = error.decision === 'changed' ? 'host-key-changed' : 'host-key-untrusted'
    return new SyncCoordinatorError(code, error.message)
  }
  if (error instanceof SyncSshProbeError) {
    const messages: Record<string, string> = {
      auth: 'SSH 认证失败',
      network: 'SSH 节点不可达',
      timeout: 'SSH 连接超时',
      hostkey: 'SSH 主机密钥校验失败',
      helper: '远端同步 helper 不可用',
      protocol: '同步协议不兼容',
    }
    const baseMsg = messages[error.category] ?? 'SSH 同步失败'
    const detail = (error as Error & { detail?: string }).detail
    return new SyncCoordinatorError(`ssh-${error.category}`, detail ? `${baseMsg}：${detail}` : baseMsg)
  }
  if (error instanceof SyncNodeManifestError) return new SyncCoordinatorError('manifest-invalid', '节点 manifest 校验失败')
  if (error instanceof SyncSessionError) {
    return new SyncCoordinatorError(error.code.startsWith('session-') ? error.code : `session-${error.code}`, error.message)
  }
  return new SyncCoordinatorError('sync-failed', '同步作业失败')
}

function resultCount(result: SyncNodeApplyResult): { applied: number; skipped: number; pendingRemoval: number } {
  return {
    applied: addCount(result),
    skipped: result.skipped,
    pendingRemoval: result.pendingRemoval,
  }
}

function emptySessionResult(): SyncSessionApplyResult {
  return { created: 0, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }
}

function sessionResultCount(result: SyncSessionApplyResult): number {
  return result.created + result.updated + result.deleted
}

export class SyncCoordinator {
  private readonly inFlight = new Map<string, Promise<SyncRunSummary>>()

  constructor(
    private readonly peers: SyncPeerManager,
    private readonly state: SyncStateStore,
    private readonly nodes: SyncNodeService,
    private readonly transport: SyncSshTransport,
    private readonly now: () => number = Date.now,
    private readonly sessions?: SyncSessionService,
  ) {}

  run(peerId: string): Promise<SyncRunSummary> {
    const active = this.inFlight.get(peerId)
    if (active) return active
    const run = this.execute(peerId)
    this.inFlight.set(peerId, run)
    void run.then(() => this.clear(peerId, run), () => this.clear(peerId, run))
    return run
  }

  private async execute(peerId: string): Promise<SyncRunSummary> {
    const peer = await this.peers.get(peerId)
    if (!peer) throw new SyncCoordinatorError('peer-not-found', '同步节点已不存在')
    if (!peer.enabled) throw new SyncCoordinatorError('peer-disabled', '此同步节点已停用')

    const startedAt = new Date(this.now()).toISOString()
    this.peers.updateProgress(peer.id, {
      lastRunAt: startedAt,
      lastRunStatus: 'running',
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    })

    try {
      if (peer.syncSessions && !this.sessions) throw new SyncCoordinatorError('sessions-unavailable', '会话同步服务不可用')
      const remoteManifest = await this.retryTransport(() => this.transport.fetchNodeManifest(peer.id))
      if (remoteManifest.protocolVersion !== 1 || remoteManifest.instanceId === this.state.instanceId()) {
        throw new SyncCoordinatorError('protocol-invalid', '同步 peer 协议版本或实例身份无效')
      }
      const remoteEntries = this.nodes.validateManifest(remoteManifest.records)
      const localManifest = await this.nodes.exportManifest()
      const localEntries = this.nodes.validateManifest(localManifest.records)
      const plan = planNodeTransfers(peer.direction, localEntries, remoteEntries)

      const localResult = plan.toLocal.length > 0
        ? await this.nodes.applyManifest(plan.toLocal, peer.name, 'peer')
        : EMPTY_APPLY_RESULT
      const remoteResult = plan.toRemote.length > 0
        ? await this.retryTransport(() => this.transport.applyNodeManifest(peer.id, plan.toRemote, localManifest.instanceId))
        : EMPTY_APPLY_RESULT
      const localCounts = resultCount(localResult)
      const remoteCounts = resultCount(remoteResult)
      let importedSessions = 0
      let exportedSessions = 0
      let skippedSessions = 0
      let digest = manifestDigest(remoteEntries)
      if (peer.syncSessions) {
        const sessionService = this.sessions!
        const remoteBundle = validateSyncSessionBundle(await this.retryTransport(() => this.transport.fetchSessionBundle(peer.id)))
        if (remoteBundle.instanceId !== remoteManifest.instanceId) {
          throw new SyncCoordinatorError('protocol-invalid', '节点与会话 manifest 的实例身份不一致')
        }
        const localBundle = await sessionService.exportBundle()
        const plan = planSessionTransfers(peer.direction, localBundle.entries, remoteBundle.entries)
        const localBundleToApply = makeSyncSessionBundle(remoteBundle.instanceId, plan.toLocal, remoteBundle.skipped)
        const remoteBundleToApply = makeSyncSessionBundle(localBundle.instanceId, plan.toRemote, localBundle.skipped)
        const sessionLocalResult = plan.toLocal.length > 0 || remoteBundle.skipped.length > 0
          ? await sessionService.applyBundle(localBundleToApply, peer.name, peer.id)
          : emptySessionResult()
        const sessionRemoteResult = plan.toRemote.length > 0
          ? await this.retryTransport(() => this.transport.applySessionBundle(peer.id, remoteBundleToApply, localBundle.instanceId))
          : emptySessionResult()
        importedSessions = sessionResultCount(sessionLocalResult)
        exportedSessions = sessionResultCount(sessionRemoteResult)
        skippedSessions = plan.skipped + sessionLocalResult.skipped + sessionRemoteResult.skipped
        digest = `sha256:${createHash('sha256').update(`${digest}\0${remoteBundle.digest}\0${localBundle.digest}`).digest('hex')}`
      }
      const finishedAt = new Date(this.now()).toISOString()
      const summary: SyncRunSummary = {
        peerId,
        direction: peer.direction,
        startedAt,
        finishedAt,
        remoteInstanceId: remoteManifest.instanceId,
        imported: localCounts.applied,
        exported: remoteCounts.applied,
        skipped: plan.skipped + localCounts.skipped + remoteCounts.skipped + skippedSessions,
        pendingRemoval: localCounts.pendingRemoval + remoteCounts.pendingRemoval,
        importedSessions,
        exportedSessions,
        skippedSessions,
      }

      this.peers.updateProgress(peer.id, {
        lastRunAt: finishedAt,
        lastRunStatus: 'succeeded',
        lastSuccessAt: finishedAt,
        lastManifestDigest: digest,
        watermark: digest,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        lastResult: {
          imported: summary.imported,
          exported: summary.exported,
          skipped: summary.skipped,
          pendingRemoval: summary.pendingRemoval,
          importedSessions,
          exportedSessions,
          skippedSessions,
        },
      })
      return summary
    } catch (error) {
      const failure = mapFailure(error)
      if (!(error instanceof SyncCoordinatorError) && !(error instanceof SyncSshProbeError) && !(error instanceof SyncSessionError) && !(error instanceof SyncNodeManifestError) && !(error instanceof SyncHostKeyChallengeError) && !(error instanceof SyncPeerNotFoundError)) {
        failure.message = `${failure.message}：${error instanceof Error ? error.message : String(error)}`
      }
      try {
        this.peers.updateProgress(peer.id, {
          lastRunAt: new Date(this.now()).toISOString(),
          lastRunStatus: 'failed',
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
        })
      } catch {}
      throw failure
    }
  }

  private clear(peerId: string, run: Promise<SyncRunSummary>): void {
    if (this.inFlight.get(peerId) === run) this.inFlight.delete(peerId)
  }

  private async retryTransport<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof SyncSshProbeError) || !['network', 'timeout', 'helper'].includes(error.category)) throw error
      await new Promise((resolve) => setTimeout(resolve, TRANSPORT_RETRY_DELAY_MS))
      return operation()
    }
  }
}
