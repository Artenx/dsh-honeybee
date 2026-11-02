import { Client, type ConnectConfig } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import { once } from 'node:events'
import { classifySshError } from '../../exec-ssh/connection.js'
import { SyncPeerManager, SyncPeerNotFoundError, type SyncPeerSecrets } from './peer-manager.js'
import { isRecord, type SyncPeer } from './model.js'
import { SyncHostKeyChallengeError, SyncHostKeyChallenges, inspectSyncHostKey } from './host-key.js'
import type { SyncNodeApplyResult, SyncNodeManifest } from './node-sync.js'
import {
  MAX_SESSION_OBJECT_STREAM_BYTES,
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
import type { SyncSessionApplyResult, SyncSessionBundle, SyncSessionEventPrefix, SyncSessionManifest, SyncSessionObject } from './session-sync.js'

const SSH_READY_TIMEOUT_MS = 30_000
const SSH_READ_IDLE_TIMEOUT_MS = 60_000
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
  private readonly closeSignal = new AbortController()
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
    channel.on('close', () => { this.closeSignal.abort() })
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

  async *readFrames(idleTimeoutMs = SSH_READ_IDLE_TIMEOUT_MS): AsyncGenerator<SyncFrame> {
    if (this.reading) throw new SyncProtocolError('SSH sync channel can only be read once')
    this.reading = true
    const channel = this.channel
    const decoder = this.decoder
    let idleDeadline: NodeJS.Timeout | undefined
    const armIdleDeadline = (): void => {
      clearTimeout(idleDeadline)
      idleDeadline = setTimeout(() => {
        this.pendingError = new Error(`SSH channel idle for more than ${Math.round(idleTimeoutMs / 1000)}s`)
        // Full teardown: destroying the channel alone may leave the stdout
        // stream open, which would keep a plain for-await suspended forever.
        this.close()
      }, idleTimeoutMs)
    }
    // channel.destroy() does not reliably end ssh2's stdout stream; racing the
    // iterator against the close signal guarantees this generator settles.
    // A channel close resolves with a sentinel instead of rejecting: a normal
    // helper exit closes the channel around the same moment stdout reaches EOF,
    // and only a pendingError (idle timeout, helper crash) makes it an error.
    const CLOSE: unique symbol = Symbol('channel-close')
    const closed: Promise<IteratorResult<Buffer> | typeof CLOSE> = new Promise((resolve) => {
      this.closeSignal.signal.addEventListener('abort', () => resolve(CLOSE), { once: true })
    })
    const iterator = (channel.stdout as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
    try {
      armIdleDeadline()
      for (;;) {
        const next = await Promise.race([iterator.next(), closed])
        if (next === CLOSE || next.done) {
          if (this.pendingError) throw new SyncProtocolError(`SSH channel error: ${this.pendingError.message}`)
          break
        }
        armIdleDeadline()
        for (const frame of decoder.push(Buffer.from(next.value))) yield frame
      }
      decoder.finish()
    } catch (error) {
      if (error instanceof SyncProtocolError) throw error
      const detail = this.pendingError ? this.pendingError.message : error instanceof Error ? error.message : 'unknown error'
      throw new SyncProtocolError(`SSH channel read failed: ${detail}`)
    } finally {
      clearTimeout(idleDeadline)
      void iterator.return?.().catch(() => {})
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
    if (this.channel.write(frame)) return
    // A frozen connection never drains; bound the wait so writes cannot hang.
    const drainDeadline = setTimeout(() => this.closeSignal.abort(), SSH_READ_IDLE_TIMEOUT_MS)
    try {
      await once(this.channel, 'drain', { signal: this.closeSignal.signal })
    } catch (error) {
      if (this.closeSignal.signal.aborted) throw new SyncProtocolError('SSH channel closed before write could drain')
      throw error
    } finally {
      clearTimeout(drainDeadline)
    }
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
    keepaliveInterval: 15_000,
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
          clearTimeout(readyDeadline)
          if (error) reject(error)
          else resolve()
        }

        // ssh2's readyTimeout can be defeated by stalls behind transparent
        // proxies; this deadline guarantees the connect promise settles.
        const readyDeadline = setTimeout(() => {
          const timeout = new Error('Timed out while waiting for SSH handshake')
          ;(timeout as Error & { level?: string }).level = 'client-timeout'
          finish(timeout)
          client.end()
        }, SSH_READY_TIMEOUT_MS * 2)
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
        const execDeadline = setTimeout(() => {
          reject(new Error('Timed out while waiting for the sync helper channel'))
          client.end()
        }, SSH_READY_TIMEOUT_MS)
        client.exec(REMOTE_SYNC_HELPER_COMMAND, (error, opened) => {
          clearTimeout(execDeadline)
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
    deferredObjects = false,
  ): Promise<SyncSessionBundle> {
    const value = await this.fetchDataOperation(peerId, 'session-entries', { keys, manifestDigest, prefixes, deferredObjects })
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

  /**
   * 拉取带外对象流：响应以帧流形式逐块 yield，调用方（收件箱）边收边落盘，
   * 内存 O(单帧)。会话在流结束/出错时关闭（生成器 finally）。
   */
  async *fetchSessionObjects(
    peerId: string,
    objects: readonly SyncSessionObject[],
  ): AsyncGenerator<Uint8Array> {
    const body = Buffer.from(JSON.stringify({ objects: [...objects] }), 'utf8')
    if (body.length > MAX_SYNC_TRANSFER_BYTES) throw new SyncSshProbeError('protocol')
    const { peer, session } = await this.openSession(peerId)
    try {
      await session.sendControl({
        kind: 'request',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        operation: 'session-objects',
        port: peer.remoteWebPort ?? DEFAULT_REMOTE_WEB_PORT,
      })
      for (let offset = 0, sequence = 0; offset < body.length; offset += MAX_SYNC_DATA_CHUNK_BYTES, sequence += 1) {
        await session.sendData(sequence, body.subarray(offset, Math.min(offset + MAX_SYNC_DATA_CHUNK_BYTES, body.length)))
      }
      await session.sendControl({ kind: 'request-end' })
      session.endInput()

      let responseStatus: number | undefined
      let bodyMode: string | undefined
      let responseEnded = false
      let totalBytes = 0
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
          throw new SyncProtocolError('unexpected session-objects control frame')
        }
        if (responseStatus === undefined || bodyMode !== 'data' || responseEnded) {
          throw new SyncProtocolError('unexpected session-objects data frame')
        }
        totalBytes += frame.data.length
        if (totalBytes > MAX_SESSION_OBJECT_STREAM_BYTES) {
          throw new SyncProtocolError('session-objects exceeds object stream limit')
        }
        yield frame.data
      }
      if (responseStatus !== 200 || !responseEnded) throw new SyncSshProbeError('helper')
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

  /**
   * 推送带外对象流：把帧流按 1MB 分块写入请求体，逐块经 SSH 发送；
   * 对端流式落盘收件箱后返回 JSON 摘要。
   */
  async pushSessionObjects(peerId: string, frames: AsyncIterable<Uint8Array>): Promise<void> {
    const { peer, session } = await this.openSession(peerId)
    try {
      await session.sendControl({
        kind: 'request',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        operation: 'session-objects-push',
        port: peer.remoteWebPort ?? DEFAULT_REMOTE_WEB_PORT,
      })
      let sequence = 0
      let totalBytes = 0
      for await (const chunk of frames) {
        if (!(chunk instanceof Uint8Array)) throw new SyncProtocolError('session-objects-push contains a non-byte chunk')
        const data = Buffer.from(chunk)
        totalBytes += data.byteLength
        if (totalBytes > MAX_SESSION_OBJECT_STREAM_BYTES) {
          throw new SyncProtocolError('session-objects-push exceeds object stream limit')
        }
        for (let offset = 0; offset < data.byteLength; offset += MAX_SYNC_DATA_CHUNK_BYTES, sequence += 1) {
          await session.sendData(sequence, data.subarray(offset, Math.min(offset + MAX_SYNC_DATA_CHUNK_BYTES, data.byteLength)))
        }
      }
      await session.sendControl({ kind: 'request-end' })
      session.endInput()

      let response: Record<string, unknown> | undefined
      for await (const frame of session.readFrames()) {
        if (frame.kind !== 'control' || response !== undefined) throw new SyncProtocolError('unexpected session-objects-push frame')
        if (frame.value.kind === 'error') throw new SyncSshProbeError('helper')
        if (frame.value.kind === 'response') response = frame.value
      }
      if (!response || response.status !== 200) throw new SyncSshProbeError('helper')
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

//#region 远端配置探测（SSH 登录后自动发现 DSH_HOME / profile / Web 端口）

export interface SyncRemoteProbeDraft {
  host: string
  port: number
  username: string
  authKind: 'password' | 'key'
}

export interface SyncRemoteProbeProfile {
  name: string
  dshbInstalled: boolean
  home: string
}

export interface SyncRemoteProbeHandshake {
  port: number
  instanceId: string
}

export interface SyncRemoteProbeResult {
  homes: string[]
  profiles: SyncRemoteProbeProfile[]
  /** 握手命中的全部端口（同机多实例时可能有多个；配置端口的命中排最前）。 */
  handshakes: SyncRemoteProbeHandshake[]
  webPort?: number
  instanceId?: string
  processHints: string[]
  hostKeyFingerprint: string
}

export const REMOTE_PROBE_BEGIN_MARKER = 'DSHB_PROBE_BEGIN'
export const REMOTE_PROBE_END_MARKER = 'DSHB_PROBE_END'
const REMOTE_PROBE_TIMEOUT_MS = 12_000
const REMOTE_PROBE_MAX_OUTPUT_BYTES = 256 * 1024

/**
 * 生成远端发现脚本：纯 POSIX sh + 远端 node（DSH 所在机器必然有 node）。
 * 三个动作：① 多候选定位 DSH_HOME（含桌面版常见路径）；② 列出 profiles 及
 * dshb 安装标记；③ 握手探测真实 Web 端口（仅远端回环，桌面版 127.0.0.1:3080
 * 即可命中）。输出以 BEGIN/END 标记包裹，逐行 "key value"。
 */
export function buildRemoteProbeScript(dshHome?: string, preferredWebPort?: number): string {
  const homeOverride = dshHome === undefined ? '' : JSON.stringify(dshHome)
  const homeCandidates = (homeOverride ? ` ${homeOverride}` : '')
    + ' "$DSH_HOME" "$HOME/.dsh" "$HOME/Library/Application Support/dsh"'
    + ' "$HOME/Library/Application Support/DeepSeek Harness"'
  return [
    `echo ${REMOTE_PROBE_BEGIN_MARKER}`,
    `for c in${homeCandidates}; do`,
    '  [ -n "$c" ] && [ -d "$c/profiles" ] && echo "home $c"',
    'done',
    `for c in${homeCandidates}; do`,
    '  [ -n "$c" ] && [ -d "$c/profiles" ] || continue',
    '  for p in "$c"/profiles/*/; do',
    '    [ -d "$p" ] || continue',
    '    b=no; [ -d "${p}node_modules/@artenx/dshb" ] && b=yes',
    '    [ -f "${p}package.json" ] || continue',
    '    echo "profile $(basename "$p") $b $c"',
    '  done',
    'done',
    'ps -eo args= 2>/dev/null | grep -E "dsh .*--profile|--profile .*--port|dsh web" | grep -v grep | head -6',
    `node -e '`
    + 'const http=require("http");'
    + 'const ports=process.argv.slice(1).map(Number).filter(Number.isInteger);'
    + 'let i=0;'
    + 'function probe(){'
    + 'if(i>=ports.length)process.exit(0);'
    + 'const port=ports[i++];'
    + 'const req=http.get({host:"127.0.0.1",port,path:"/api/dshb/sync/internal/handshake",timeout:700},res=>{'
    + 'let body="";res.on("data",c=>body+=c);res.on("end",()=>{'
    + 'try{const j=JSON.parse(body);if(j&&j.ok===true&&typeof j.instanceId==="string")'
    + '{console.log("handshake "+port+" "+j.instanceId)}}catch(e){}probe()})});'
    + 'req.on("timeout",()=>{req.destroy();probe()});'
    + 'req.on("error",()=>probe());'
    + '}probe()'
    + "' "
    + (preferredWebPort !== undefined ? ` ${preferredWebPort}` : '')
    + ' 3080 8080 3079 3204 3206 3207 9080'
    + ` $(ps -eo args= 2>/dev/null | grep -o "\\-\\-port [0-9]\\+" | awk '{print $2}' | head -6)`,
    `echo ${REMOTE_PROBE_END_MARKER}`,
  ].join('\n')
}

/** 解析探测输出：仅在 BEGIN/END 标记之间取行，容忍未知行。 */
export function parseRemoteProbeOutput(output: string, hostKeyFingerprint: string, preferredWebPort?: number): SyncRemoteProbeResult {
  const begin = output.indexOf(REMOTE_PROBE_BEGIN_MARKER)
  const end = output.indexOf(REMOTE_PROBE_END_MARKER)
  if (begin < 0 || end < begin) throw new SyncSshProbeError('helper')
  const lines = output.slice(begin + REMOTE_PROBE_BEGIN_MARKER.length, end).split('\n')
    .map((line) => line.trim()).filter(Boolean)
  const result: SyncRemoteProbeResult = { homes: [], profiles: [], handshakes: [], processHints: [], hostKeyFingerprint }
  for (const line of lines) {
    const [head, ...rest] = line.split(/\s+/)
    const value = rest.join(' ')
    if (head === 'home' && value) result.homes.push(value)
    else if (head === 'profile' && rest.length >= 3) {
      const [name, dshb, home] = rest
      result.profiles.push({ name, dshbInstalled: dshb === 'yes', home })
    } else if (head === 'handshake' && rest.length >= 2) {
      const port = Number(rest[0])
      if (Number.isInteger(port) && port >= 1 && port <= 65535
        && !result.handshakes.some((hit) => hit.port === port)) {
        result.handshakes.push({ port, instanceId: rest[1] })
      }
    } else if (line && !line.startsWith('home ') && !line.startsWith('profile ') && !line.startsWith('handshake ')) {
      result.processHints.push(line)
    }
  }
  result.homes = [...new Set(result.homes)]
  result.profiles = result.profiles.filter((profile, index, all) =>
    all.findIndex((candidate) => candidate.name === profile.name && candidate.home === profile.home) === index)
  // 首选端口（已保存对端的配置值）的命中作为自动回填值；其余命中仅提示。
  const preferred = result.handshakes.find((hit) => hit.port === preferredWebPort)
    ?? result.handshakes[0]
  if (preferred) {
    result.webPort = preferred.port
    result.instanceId = preferred.instanceId
  }
  return result
}

export class SyncRemoteProbe {
  /** 探测远端：SSH 登录 + 单次 exec 发现脚本；主机密钥自动接受（只读发现，指纹随结果返回）。 */
  async probeRemote(draft: SyncRemoteProbeDraft, secrets: SyncPeerSecrets, preferredWebPort?: number): Promise<SyncRemoteProbeResult> {
    if (draft.authKind === 'password' && !secrets.password) throw new SyncSshProbeError('auth')
    if (draft.authKind === 'key' && !secrets.privateKey) throw new SyncSshProbeError('auth')
    let fingerprint = ''
    const client = new Client()
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: unknown): void => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          if (error) reject(error)
          else resolve()
        }
        const deadline = setTimeout(() => {
          const timeout = new Error('Timed out while waiting for SSH handshake')
          ;(timeout as Error & { level?: string }).level = 'client-timeout'
          finish(timeout)
          client.end()
        }, SSH_READY_TIMEOUT_MS)
        client.once('ready', () => finish())
        client.on('error', (error: Error) => finish(error))
        const config: ConnectConfig = {
          host: draft.host,
          port: draft.port,
          username: draft.username,
          hostHash: 'sha256',
          readyTimeout: SSH_READY_TIMEOUT_MS,
          // 只读探测：自动接受指纹并记录，随结果返回供 UI 展示；
          // 保存对端后的真实同步仍走 run/trust-host-key 的显式信任流程。
          hostVerifier: (sha256Hex: string): boolean => {
            fingerprint = sha256Hex
            return true
          },
          ...(draft.authKind === 'password'
            ? { password: secrets.password }
            : { privateKey: secrets.privateKey, ...(secrets.passphrase ? { passphrase: secrets.passphrase } : {}) }),
        }
        try {
          client.connect(config)
        } catch (error) {
          finish(error)
        }
      })
      const stdout = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        let settled = false
        const finish = (error?: unknown, text?: string): void => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          if (error) reject(error)
          else resolve(text ?? '')
        }
        const deadline = setTimeout(() => finish(new Error('Timed out while waiting for the remote probe script')), REMOTE_PROBE_TIMEOUT_MS)
        client.exec(buildRemoteProbeScript(undefined, preferredWebPort), (error, channel) => {
          if (error) { finish(error); return }
          channel.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > REMOTE_PROBE_MAX_OUTPUT_BYTES) { finish(new Error('remote probe output exceeds size limit')); return }
            chunks.push(chunk)
          })
          channel.on('error', (error: Error) => finish(error))
          channel.on('close', (code: number | null) => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (code !== 0 && !text.includes(REMOTE_PROBE_END_MARKER)) finish(new Error(`remote probe script exited with ${code}`))
            else finish(undefined, text)
          })
          channel.stderr.resume()
        })
      })
      return parseRemoteProbeOutput(stdout, fingerprint, preferredWebPort)
    } catch (error) {
      if (error instanceof SyncSshProbeError) throw error
      const category = classifySshError(error)
      if (category === 'auth' || category === 'network' || category === 'timeout') throw new SyncSshProbeError(category)
      if (category === 'hostkey') throw new SyncSshProbeError('hostkey')
      throw new SyncSshProbeError('helper')
    } finally {
      try {
        client.end()
      } catch {}
    }
  }
}
