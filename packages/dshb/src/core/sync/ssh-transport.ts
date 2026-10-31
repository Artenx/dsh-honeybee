import { Client, type ConnectConfig } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import { once } from 'node:events'
import { classifySshError } from '../../exec-ssh/connection.js'
import { SyncPeerManager, SyncPeerNotFoundError, type SyncPeerSecrets } from './peer-manager.js'
import { isRecord, type SyncPeer } from './model.js'
import { SyncHostKeyChallengeError, SyncHostKeyChallenges, inspectSyncHostKey } from './host-key.js'
import type { SyncNodeApplyResult, SyncNodeManifest } from './node-sync.js'
import {
  MAX_SYNC_DATA_CHUNK_BYTES,
  MAX_SYNC_TRANSFER_BYTES,
  SYNC_PROTOCOL_VERSION,
  SyncFrameDecoder,
  SyncProtocolError,
  encodeSyncControlFrame,
  encodeSyncDataFrame,
  type SyncFrame,
} from './protocol.js'
import { REMOTE_SYNC_HELPER_COMMAND } from './remote-helper.js'
import type { SyncSessionApplyResult, SyncSessionBundle, SyncSessionEventPrefix, SyncSessionManifest } from './session-sync.js'

const SSH_READY_TIMEOUT_MS = 30_000
const DEFAULT_REMOTE_WEB_PORT = 3080

export type SyncSshErrorCategory = 'auth' | 'network' | 'hostkey' | 'timeout' | 'helper' | 'protocol'

export class SyncSshProbeError extends Error {
  constructor(readonly category: SyncSshErrorCategory) {
    super(`SSH sync probe failed: ${category}`)
    this.name = 'SyncSshProbeError'
  }
}

export class SyncSessionDeltaPrefixError extends Error {
  constructor() {
    super('remote session event prefix changed during transfer')
    this.name = 'SyncSessionDeltaPrefixError'
  }
}

export interface SyncRemoteHandshake {
  protocolVersion: number
  instanceId: string
  capabilities: string[]
}

export interface SyncRemoteNodeManifest extends SyncNodeManifest {
  capabilities?: string[]
}

export class SyncSshSession {
  private readonly decoder = new SyncFrameDecoder()
  private reading = false
  private closed = false
  private inputEnded = false
  private nextDataSequence = 0
  private pendingError: Error | undefined

  constructor(
    private readonly client: Client,
    private readonly channel: ClientChannel,
  ) {
    channel.on('error', (error: Error) => { this.pendingError = error })
    channel.on('exit', (code: number | null) => {
      if (code !== null && code !== 0) this.pendingError = new Error(`remote helper exited with code ${code}`)
    })
  }

  async sendControl(value: Record<string, unknown>): Promise<void> {
    await this.write(encodeSyncControlFrame(value))
  }

  async sendData(sequence: number, data: Buffer): Promise<void> {
    if (sequence !== this.nextDataSequence) throw new SyncProtocolError('outgoing data sequence is out of order')
    await this.write(encodeSyncDataFrame(sequence, data))
    this.nextDataSequence += 1
  }

  endInput(): void {
    if (this.closed || this.inputEnded) return
    this.inputEnded = true
    this.channel.end()
  }

  async *readFrames(): AsyncGenerator<SyncFrame> {
    if (this.reading) throw new SyncProtocolError('SSH sync channel can only be read once')
    this.reading = true
    const channel = this.channel
    const decoder = this.decoder
    try {
      for await (const chunk of channel.stdout as AsyncIterable<Buffer>) {
        for (const frame of decoder.push(Buffer.from(chunk))) yield frame
      }
      if (this.pendingError) throw new SyncProtocolError(`SSH channel error: ${this.pendingError.message}`)
      decoder.finish()
    } catch (error) {
      if (error instanceof SyncProtocolError) throw error
      const detail = this.pendingError ? this.pendingError.message : error instanceof Error ? error.message : 'unknown error'
      throw new SyncProtocolError(`SSH channel read failed: ${detail}`)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.channel.destroy()
    this.client.end()
  }

  private async write(frame: Buffer): Promise<void> {
    if (this.closed || this.inputEnded) throw new SyncProtocolError('SSH sync channel input is closed')
    if (!this.channel.write(frame)) await once(this.channel, 'drain')
  }
}

export function buildSyncSshConnectConfig(
  peer: SyncPeer,
  secrets: SyncPeerSecrets,
  challenges: SyncHostKeyChallenges,
  onChallenge: (error: SyncHostKeyChallengeError) => void,
): ConnectConfig {
  return {
    host: peer.host,
    port: peer.port,
    username: peer.username,
    hostHash: 'sha256',
    readyTimeout: SSH_READY_TIMEOUT_MS,
    keepaliveInterval: 0,
    hostVerifier: (sha256Hex: string): boolean => {
      try {
        const decision = inspectSyncHostKey(peer, sha256Hex, challenges)
        if (!decision.trusted) onChallenge(decision.challenge)
        return decision.trusted
      } catch (error) {
        if (error instanceof SyncHostKeyChallengeError) onChallenge(error)
        return false
      }
    },
    ...(peer.authKind === 'password'
      ? { password: secrets.password }
      : { privateKey: secrets.privateKey, ...(secrets.passphrase ? { passphrase: secrets.passphrase } : {}) }),
  }
}

export class SyncSshTransport {
  private readonly hostKeyChallenges = new SyncHostKeyChallenges()

  constructor(private readonly peerManager: SyncPeerManager) {}

  async probe(peerId: string): Promise<SyncRemoteHandshake> {
    const { peer, session } = await this.openSession(peerId)
    try {
      const handshake = await this.requestHandshake(session, peer.remoteWebPort ?? DEFAULT_REMOTE_WEB_PORT)
      if (handshake.protocolVersion !== SYNC_PROTOCOL_VERSION) throw new SyncSshProbeError('protocol')
      return handshake
    } catch (error) {
      if (
        error instanceof SyncHostKeyChallengeError ||
        error instanceof SyncPeerNotFoundError ||
        error instanceof SyncSshProbeError
      ) {
        throw error
      }
      if (error instanceof SyncProtocolError) throw new SyncSshProbeError('protocol')
      throw new SyncSshProbeError('helper')
    } finally {
      session.close()
    }
  }

  async openSession(peerId: string): Promise<{ peer: SyncPeer; session: SyncSshSession }> {
    const { peer, secrets } = await this.peerManager.connectionData(peerId)
    if (peer.authKind === 'password' && !secrets.password) throw new SyncSshProbeError('auth')
    if (peer.authKind === 'key' && !secrets.privateKey) throw new SyncSshProbeError('auth')

    const client = new Client()
    let challenge: SyncHostKeyChallengeError | undefined
    let sessionOpened = false
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: unknown): void => {
          if (settled) return
          settled = true
          if (error) reject(error)
          else resolve()
        }

        client.once('ready', () => finish())
        client.on('error', (error: Error) => finish(challenge ?? error))
        const config = buildSyncSshConnectConfig(peer, secrets, this.hostKeyChallenges, (error) => {
          challenge = error
        })

        try {
          client.connect(config)
        } catch (error) {
          finish(error)
        }
      })

      const channel = await new Promise<ClientChannel>((resolve, reject) => {
          client.exec(REMOTE_SYNC_HELPER_COMMAND, (error, opened) => {
          if (error) reject(error)
          else resolve(opened)
        })
      })
      const session = new SyncSshSession(client, channel)
      sessionOpened = true
      return { peer, session }
    } catch (error) {
      if (error instanceof SyncHostKeyChallengeError || error instanceof SyncPeerNotFoundError || error instanceof SyncSshProbeError) {
        throw error
      }
      if (challenge) throw challenge
      const category = classifySshError(error)
      if (category === 'auth' || category === 'network' || category === 'timeout') {
        throw new SyncSshProbeError(category)
      }
      if (category === 'hostkey') throw new SyncSshProbeError('hostkey')
      if (error instanceof SyncProtocolError) throw new SyncSshProbeError('protocol')
      throw new SyncSshProbeError('helper')
    } finally {
      if (!sessionOpened) {
        try {
          client.end()
        } catch {}
      }
    }
  }

  async fetchNodeManifest(peerId: string): Promise<SyncRemoteNodeManifest> {
    const value = await this.fetchDataOperation(peerId, 'node-manifest')
    if (!isRecord(value) || value.ok !== true || !isRecord(value.manifest)) throw new SyncSshProbeError('helper')
    const manifest = value.manifest
    if (manifest.protocolVersion !== SYNC_PROTOCOL_VERSION || typeof manifest.instanceId !== 'string' || !Array.isArray(manifest.records)) {
      throw new SyncSshProbeError('protocol')
    }
    const capabilities = value.capabilities === undefined ? undefined : value.capabilities
    if (capabilities !== undefined && (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === 'string'))) {
      throw new SyncSshProbeError('protocol')
    }
    return { ...manifest, ...(capabilities ? { capabilities } : {}) } as unknown as SyncRemoteNodeManifest
  }

  async applyNodeManifest(
    peerId: string,
    records: SyncNodeManifest['records'],
    sourceName: string,
  ): Promise<SyncNodeApplyResult> {
    const requestBody = Buffer.from(JSON.stringify({ records, sourceName }), 'utf8')
    if (requestBody.length > MAX_SYNC_TRANSFER_BYTES) throw new SyncSshProbeError('protocol')
    const { peer, session } = await this.openSession(peerId)
    try {
      await session.sendControl({
        kind: 'request',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        operation: 'node-apply',
        port: peer.remoteWebPort ?? DEFAULT_REMOTE_WEB_PORT,
      })
      for (let offset = 0, sequence = 0; offset < requestBody.length; offset += MAX_SYNC_DATA_CHUNK_BYTES, sequence += 1) {
        await session.sendData(sequence, requestBody.subarray(offset, Math.min(offset + MAX_SYNC_DATA_CHUNK_BYTES, requestBody.length)))
      }
      await session.sendControl({ kind: 'request-end' })
      session.endInput()

      let response: Record<string, unknown> | undefined
      for await (const frame of session.readFrames()) {
        if (frame.kind !== 'control' || response) throw new SyncProtocolError('unexpected node apply response frame')
        response = frame.value
      }
      if (!response || response.kind === 'error') throw new SyncSshProbeError('helper')
      if (response.kind !== 'response' || response.status !== 200 || response.body === null || typeof response.body !== 'object') {
        throw new SyncSshProbeError('helper')
      }
      const body = response.body as Record<string, unknown>
      if (body.ok !== true || body.result === null || typeof body.result !== 'object') throw new SyncSshProbeError('helper')
      const result = body.result as Record<string, unknown>
      for (const key of ['created', 'updated', 'deleted', 'pendingRemoval', 'skipped'] as const) {
        if (!Number.isSafeInteger(result[key]) || (result[key] as number) < 0) throw new SyncSshProbeError('protocol')
      }
      return result as unknown as SyncNodeApplyResult
    } catch (error) {
      if (error instanceof SyncSshProbeError) throw error
      if (error instanceof SyncProtocolError) throw new SyncSshProbeError('protocol')
      throw new SyncSshProbeError('helper')
    } finally {
      session.close()
    }
  }

  async fetchSessionBundle(peerId: string): Promise<SyncSessionBundle> {
    const value = await this.fetchDataOperation(peerId, 'session-bundle')
    if (!isRecord(value) || value.ok !== true || !isRecord(value.bundle)) throw new SyncSshProbeError('helper')
    const bundle = value.bundle
    if (bundle.protocolVersion !== 1 || typeof bundle.instanceId !== 'string' ||
      !Array.isArray(bundle.entries) || !Array.isArray(bundle.skipped) || typeof bundle.digest !== 'string') {
      throw new SyncSshProbeError('protocol')
    }
    return bundle as unknown as SyncSessionBundle
  }

  async fetchSessionManifest(peerId: string): Promise<SyncSessionManifest> {
    const value = await this.fetchDataOperation(peerId, 'session-manifest')
    if (!isRecord(value) || value.ok !== true || !isRecord(value.manifest)) throw new SyncSshProbeError('helper')
    const manifest = value.manifest
    if (manifest.protocolVersion !== 1 || typeof manifest.instanceId !== 'string' ||
      !Array.isArray(manifest.entries) || !Array.isArray(manifest.skipped) || typeof manifest.digest !== 'string') {
      throw new SyncSshProbeError('protocol')
    }
    return manifest as unknown as SyncSessionManifest
  }

  async fetchSessionEntries(
    peerId: string,
    keys: readonly string[],
    manifestDigest: string,
    prefixes: readonly SyncSessionEventPrefix[] = [],
  ): Promise<SyncSessionBundle> {
    const value = await this.fetchDataOperation(peerId, 'session-entries', { keys, manifestDigest, prefixes })
    if (!isRecord(value) || value.ok !== true || !isRecord(value.bundle)) throw new SyncSshProbeError('helper')
    const bundle = value.bundle
    if (bundle.protocolVersion !== 1 || typeof bundle.instanceId !== 'string' ||
      !Array.isArray(bundle.entries) || !Array.isArray(bundle.skipped) || typeof bundle.digest !== 'string') {
      throw new SyncSshProbeError('protocol')
    }
    return bundle as unknown as SyncSessionBundle
  }

  async applySessionBundle(peerId: string, bundle: SyncSessionBundle, sourceName: string): Promise<SyncSessionApplyResult> {
    const requestBody = Buffer.from(JSON.stringify({ bundle, sourceName, peerId }), 'utf8')
    if (requestBody.length > MAX_SYNC_TRANSFER_BYTES) throw new SyncSshProbeError('protocol')
    const { peer, session } = await this.openSession(peerId)
    try {
      await session.sendControl({
        kind: 'request',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        operation: 'session-apply',
        port: peer.remoteWebPort ?? DEFAULT_REMOTE_WEB_PORT,
      })
      for (let offset = 0, sequence = 0; offset < requestBody.length; offset += MAX_SYNC_DATA_CHUNK_BYTES, sequence += 1) {
        await session.sendData(sequence, requestBody.subarray(offset, Math.min(offset + MAX_SYNC_DATA_CHUNK_BYTES, requestBody.length)))
      }
      await session.sendControl({ kind: 'request-end' })
      session.endInput()

      let response: Record<string, unknown> | undefined
      for await (const frame of session.readFrames()) {
        if (frame.kind !== 'control' || response) throw new SyncProtocolError('unexpected session apply response frame')
        response = frame.value
      }
      if (!response || response.kind === 'error') throw new SyncSshProbeError('helper')
      if (response.kind === 'response' && response.status === 409 && isRecord(response.body) &&
        response.body.code === 'session-delta-prefix') throw new SyncSessionDeltaPrefixError()
      if (response.kind !== 'response' || response.status !== 200 || response.body === null || typeof response.body !== 'object') {
        throw new SyncSshProbeError('helper')
      }
      const body = response.body as Record<string, unknown>
      if (body.ok !== true || body.result === null || typeof body.result !== 'object') throw new SyncSshProbeError('helper')
      const result = body.result as Record<string, unknown>
      for (const key of ['created', 'updated', 'archived', 'deleted', 'skipped', 'unmapped'] as const) {
        if (!Number.isSafeInteger(result[key]) || (result[key] as number) < 0) throw new SyncSshProbeError('protocol')
      }
      return result as unknown as SyncSessionApplyResult
    } catch (error) {
      if (error instanceof SyncSessionDeltaPrefixError) throw error
      if (error instanceof SyncSshProbeError) throw error
      if (error instanceof SyncProtocolError) throw new SyncSshProbeError('protocol')
      throw new SyncSshProbeError('helper')
    } finally {
      session.close()
    }
  }

  async trustObservedHostKey(peerId: string): Promise<void> {
    const { peer } = await this.peerManager.connectionData(peerId)
    const fingerprint = this.hostKeyChallenges.acceptObserved(peer)
    await this.peerManager.pinHostKey(peerId, fingerprint)
  }

  private async fetchDataOperation(
    peerId: string,
    operation: 'node-manifest' | 'session-bundle' | 'session-manifest' | 'session-entries',
    requestBody?: Record<string, unknown>,
  ): Promise<unknown> {
    const body = requestBody === undefined ? undefined : Buffer.from(JSON.stringify(requestBody), 'utf8')
    if (body && body.length > MAX_SYNC_TRANSFER_BYTES) throw new SyncSshProbeError('protocol')
    const { peer, session } = await this.openSession(peerId)
    try {
      await session.sendControl({
        kind: 'request',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        operation,
        port: peer.remoteWebPort ?? DEFAULT_REMOTE_WEB_PORT,
      })
      if (body) {
        for (let offset = 0, sequence = 0; offset < body.length; offset += MAX_SYNC_DATA_CHUNK_BYTES, sequence += 1) {
          await session.sendData(sequence, body.subarray(offset, Math.min(offset + MAX_SYNC_DATA_CHUNK_BYTES, body.length)))
        }
        await session.sendControl({ kind: 'request-end' })
      }
      session.endInput()

      let responseStatus: number | undefined
      let bodyMode: string | undefined
      let responseEnded = false
      let totalBytes = 0
      const chunks: Buffer[] = []
      for await (const frame of session.readFrames()) {
        if (frame.kind === 'control') {
          if (frame.value.kind === 'error') throw new SyncSshProbeError('helper')
          if (frame.value.kind === 'response' && responseStatus === undefined) {
            responseStatus = typeof frame.value.status === 'number' ? frame.value.status : undefined
            bodyMode = typeof frame.value.bodyMode === 'string' ? frame.value.bodyMode : undefined
            continue
          }
          if (frame.value.kind === 'response-end' && responseStatus !== undefined && !responseEnded) {
            responseEnded = true
            continue
          }
          throw new SyncProtocolError(`unexpected ${operation} control frame`)
        }
        if (responseStatus === undefined || bodyMode !== 'data' || responseEnded) {
          throw new SyncProtocolError(`unexpected ${operation} data frame`)
        }
        totalBytes += frame.data.length
        if (totalBytes > MAX_SYNC_TRANSFER_BYTES) throw new SyncProtocolError(`${operation} exceeds transfer limit`)
        chunks.push(frame.data)
      }
      if (responseStatus !== 200 || !responseEnded) throw new SyncSshProbeError('helper')
      try {
        return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')) as unknown
      } catch {
        throw new SyncProtocolError(`${operation} response is invalid JSON`)
      }
    } catch (error) {
      if (error instanceof SyncSshProbeError) throw error
      if (error instanceof SyncProtocolError) {
        const probe = new SyncSshProbeError('protocol')
        ;(probe as Error & { detail?: string }).detail = error.message
        throw probe
      }
      throw new SyncSshProbeError('helper')
    } finally {
      session.close()
    }
  }

  private async requestHandshake(session: SyncSshSession, port: number): Promise<SyncRemoteHandshake> {
    await session.sendControl({
      kind: 'request',
      protocolVersion: SYNC_PROTOCOL_VERSION,
      operation: 'handshake',
      port,
    })
    session.endInput()

    let response: Record<string, unknown> | undefined
    for await (const frame of session.readFrames()) {
      if (frame.kind !== 'control' || response) throw new SyncProtocolError('unexpected helper frame')
      response = frame.value
    }
    if (!response) throw new SyncProtocolError('helper returned no handshake response')
    return validateHandshakeResponse(response)
  }
}

function validateHandshakeResponse(value: Record<string, unknown>): SyncRemoteHandshake {
  if (value.kind === 'error') throw new SyncSshProbeError('helper')
  if (value.kind !== 'response' || value.status !== 200 || value.body === null || typeof value.body !== 'object') {
    throw new SyncSshProbeError('helper')
  }
  const body = value.body as Record<string, unknown>
  if (
    typeof body.protocolVersion !== 'number' ||
    typeof body.instanceId !== 'string' ||
    !Array.isArray(body.capabilities) ||
    !body.capabilities.every((capability) => typeof capability === 'string')
  ) {
    throw new SyncSshProbeError('protocol')
  }
  return {
    protocolVersion: body.protocolVersion,
    instanceId: body.instanceId,
    capabilities: body.capabilities,
  }
}
