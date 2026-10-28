import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import {
  MAX_SYNC_CONTROL_FRAME_BYTES,
  MAX_SYNC_DATA_CHUNK_BYTES,
  SyncFrameDecoder,
  SyncProtocolError,
  encodeSyncControlFrame,
  encodeSyncDataFrame,
} from '../../src/core/sync/protocol.js'
import { SyncSshSession } from '../../src/core/sync/ssh-transport.js'

describe('sync frame protocol', () => {
  it('streams control and data frames through an SSH session channel', async () => {
    const writes: Buffer[] = []
    const channel = Object.assign(new EventEmitter(), {
      stdout: Readable.from([
        encodeSyncControlFrame({ kind: 'ack', sequence: 0 }),
        encodeSyncDataFrame(0, Buffer.from('remote-data')),
      ]),
      write(frame: Buffer) { writes.push(Buffer.from(frame)); return true },
      end() {},
      destroy() {},
    })
    const session = new SyncSshSession({ end() {} } as never, channel as never)

    await session.sendControl({ kind: 'request' })
    await session.sendData(0, Buffer.from('local-data'))
    const received = []
    for await (const frame of session.readFrames()) received.push(frame)
    const outbound = new SyncFrameDecoder()
    const sent = writes.flatMap((frame) => outbound.push(frame))
    outbound.finish()

    expect(sent).toMatchObject([
      { kind: 'control', value: { kind: 'request' } },
      { kind: 'data', sequence: 0, data: Buffer.from('local-data') },
    ])
    expect(received).toMatchObject([
      { kind: 'control', value: { kind: 'ack', sequence: 0 } },
      { kind: 'data', sequence: 0, data: Buffer.from('remote-data') },
    ])
  })

  it('decodes partial and coalesced control/data frames', () => {
    const control = encodeSyncControlFrame({ kind: 'request', operation: 'handshake' })
    const data = encodeSyncDataFrame(0, Buffer.from('chunk-body'))
    const stream = Buffer.concat([control, data, encodeSyncControlFrame({ kind: 'end' })])
    const decoder = new SyncFrameDecoder()
    const frames = [
      ...decoder.push(stream.subarray(0, 3)),
      ...decoder.push(stream.subarray(3, 13)),
      ...decoder.push(stream.subarray(13)),
    ]
    decoder.finish()

    expect(frames).toHaveLength(3)
    expect(frames[0]).toEqual({ kind: 'control', value: { kind: 'request', operation: 'handshake' } })
    expect(frames[1]).toMatchObject({ kind: 'data', sequence: 0, data: Buffer.from('chunk-body') })
    expect(frames[2]).toEqual({ kind: 'control', value: { kind: 'end' } })
  })

  it('rejects out-of-order data chunks and digest corruption', () => {
    const decoder = new SyncFrameDecoder()
    expect(() => decoder.push(encodeSyncDataFrame(1, Buffer.from('bad order')))).toThrow('out of order')

    const valid = encodeSyncDataFrame(0, Buffer.from('original'))
    valid[valid.length - 1] ^= 1
    expect(() => new SyncFrameDecoder().push(valid)).toThrow('digest mismatch')
  })

  it('rejects invalid control frames, unknown types and truncated streams', () => {
    const invalidJson = Buffer.alloc(7)
    invalidJson[0] = 0
    invalidJson.writeUInt32BE(2, 1)
    invalidJson.write('x\n', 5)
    expect(() => new SyncFrameDecoder().push(invalidJson)).toThrow('invalid JSON')

    const unknownType = Buffer.from([9, 0, 0, 0, 2, 0x7b, 0x7d])
    expect(() => new SyncFrameDecoder().push(unknownType)).toThrow('unknown frame type')

    const truncated = new SyncFrameDecoder()
    truncated.push(Buffer.from([0, 0]))
    expect(() => truncated.finish()).toThrow('truncated')
  })

  it('enforces control and data frame size bounds', () => {
    expect(() => encodeSyncControlFrame({ text: 'x'.repeat(MAX_SYNC_CONTROL_FRAME_BYTES) })).toThrow('size limit')
    expect(() => encodeSyncDataFrame(0, Buffer.alloc(MAX_SYNC_DATA_CHUNK_BYTES + 1))).toThrow('size limit')

    const oversizedHeader = Buffer.alloc(5)
    oversizedHeader[0] = 0
    oversizedHeader.writeUInt32BE(MAX_SYNC_CONTROL_FRAME_BYTES + 1, 1)
    expect(() => new SyncFrameDecoder().push(oversizedHeader)).toThrow(SyncProtocolError)
  })
})
