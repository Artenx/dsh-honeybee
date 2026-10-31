import { createHash, timingSafeEqual } from 'node:crypto'

export const SYNC_PROTOCOL_VERSION = 1
export const SYNC_SESSION_MANIFEST_CAPABILITY = 'session-manifest-v1'
export const SYNC_SESSION_EVENT_TAIL_CAPABILITY = 'session-event-tail-delta-v1'
export const SYNC_SESSION_BUNDLE_OBJECTS_CAPABILITY = 'session-bundle-objects-v1'
export const MAX_SYNC_CONTROL_FRAME_BYTES = 64 * 1024
export const MAX_SYNC_DATA_CHUNK_BYTES = 1024 * 1024
export const MAX_SYNC_TRANSFER_BYTES = 100 * 1024 * 1024 * 1024

const FRAME_HEADER_BYTES = 5
const CONTROL_FRAME = 0
const DATA_FRAME = 1
const DATA_METADATA_BYTES = 36

export type SyncFrame =
  | { kind: 'control'; value: Record<string, unknown> }
  | { kind: 'data'; sequence: number; digest: string; data: Buffer }

export class SyncProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncProtocolError'
  }
}

function makeHeader(type: number, payloadLength: number): Buffer {
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
  header[0] = type
  header.writeUInt32BE(payloadLength, 1)
  return header
}

export function encodeSyncControlFrame(value: Record<string, unknown>): Buffer {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  if (payload.length > MAX_SYNC_CONTROL_FRAME_BYTES) throw new SyncProtocolError('control frame exceeds size limit')
  return Buffer.concat([makeHeader(CONTROL_FRAME, payload.length), payload])
}

export function encodeSyncDataFrame(sequence: number, data: Buffer): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
    throw new SyncProtocolError('data sequence is invalid')
  }
  if (data.length > MAX_SYNC_DATA_CHUNK_BYTES) throw new SyncProtocolError('data chunk exceeds size limit')
  const metadata = Buffer.allocUnsafe(DATA_METADATA_BYTES)
  metadata.writeUInt32BE(sequence, 0)
  createHash('sha256').update(data).digest().copy(metadata, 4)
  return Buffer.concat([makeHeader(DATA_FRAME, metadata.length + data.length), metadata, data])
}

export class SyncFrameDecoder {
  private readonly header = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
  private headerOffset = 0
  private frameType = -1
  private payload: Buffer | undefined
  private payloadOffset = 0
  private nextDataSequence = 0
  private ended = false

  push(chunk: Buffer): SyncFrame[] {
    if (this.ended) throw new SyncProtocolError('frame decoder is already finished')
    const frames: SyncFrame[] = []
    let inputOffset = 0

    while (inputOffset < chunk.length) {
      if (!this.payload) {
        const copied = Math.min(FRAME_HEADER_BYTES - this.headerOffset, chunk.length - inputOffset)
        chunk.copy(this.header, this.headerOffset, inputOffset, inputOffset + copied)
        this.headerOffset += copied
        inputOffset += copied
        if (this.headerOffset < FRAME_HEADER_BYTES) continue

        this.frameType = this.header[0]
        const payloadLength = this.header.readUInt32BE(1)
        if (this.frameType === CONTROL_FRAME) {
          if (payloadLength < 2 || payloadLength > MAX_SYNC_CONTROL_FRAME_BYTES) {
            throw new SyncProtocolError('control frame length is invalid')
          }
        } else if (this.frameType === DATA_FRAME) {
          if (payloadLength < DATA_METADATA_BYTES || payloadLength > DATA_METADATA_BYTES + MAX_SYNC_DATA_CHUNK_BYTES) {
            throw new SyncProtocolError('data frame length is invalid')
          }
        } else {
          throw new SyncProtocolError('unknown frame type')
        }
        this.payload = Buffer.allocUnsafe(payloadLength)
        this.payloadOffset = 0
      }

      const payload = this.payload
      const copied = Math.min(payload.length - this.payloadOffset, chunk.length - inputOffset)
      chunk.copy(payload, this.payloadOffset, inputOffset, inputOffset + copied)
      this.payloadOffset += copied
      inputOffset += copied

      if (this.payloadOffset === payload.length) {
        frames.push(this.decodeFrame(this.frameType, payload))
        this.resetFrame()
      }
    }
    return frames
  }

  finish(): void {
    if (this.headerOffset !== 0 || this.payload !== undefined) throw new SyncProtocolError('truncated frame stream')
    this.ended = true
  }

  private decodeFrame(type: number, payload: Buffer): SyncFrame {
    if (type === CONTROL_FRAME) {
      if (payload[payload.length - 1] !== 0x0a) throw new SyncProtocolError('control frame must end with a newline')
      let value: unknown
      try {
        value = JSON.parse(payload.subarray(0, -1).toString('utf8'))
      } catch {
        throw new SyncProtocolError('control frame contains invalid JSON')
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new SyncProtocolError('control frame must contain an object')
      }
      return { kind: 'control', value: value as Record<string, unknown> }
    }

    const sequence = payload.readUInt32BE(0)
    if (sequence !== this.nextDataSequence) throw new SyncProtocolError('data sequence is out of order')
    const expectedDigest = payload.subarray(4, DATA_METADATA_BYTES)
    const data = payload.subarray(DATA_METADATA_BYTES)
    const actualDigest = createHash('sha256').update(data).digest()
    if (!timingSafeEqual(expectedDigest, actualDigest)) throw new SyncProtocolError('data chunk digest mismatch')
    this.nextDataSequence += 1
    return { kind: 'data', sequence, digest: actualDigest.toString('hex'), data: Buffer.from(data) }
  }

  private resetFrame(): void {
    this.headerOffset = 0
    this.frameType = -1
    this.payload = undefined
    this.payloadOffset = 0
  }
}
