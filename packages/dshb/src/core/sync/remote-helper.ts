import { Buffer } from 'node:buffer'

const REMOTE_HELPER_SOURCE = String.raw`'use strict'
const { createHash, timingSafeEqual } = require('node:crypto')
const MAX_CONTROL = 65536
const MAX_CHUNK = 1048576
const MAX_TRANSFER = 107374182400
const PATHS = {
  handshake: { path: '/api/dshb/sync/internal/handshake', method: 'GET' },
  'node-manifest': { path: '/api/dshb/sync/internal/nodes/manifest', method: 'GET' },
  'node-apply': { path: '/api/dshb/sync/internal/nodes/apply', method: 'POST' },
  'session-bundle': { path: '/api/dshb/sync/internal/sessions/bundle', method: 'GET' },
  'session-apply': { path: '/api/dshb/sync/internal/sessions/apply', method: 'POST' },
}
const input = []
let inputBytes = 0

function encodeControl(value) {
  const body = Buffer.from(JSON.stringify(value) + '\n', 'utf8')
  if (body.length > MAX_CONTROL) throw new Error('control frame too large')
  const header = Buffer.alloc(5)
  header[0] = 0
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

function encodeData(sequence, data) {
  const digest = createHash('sha256').update(data).digest()
  const metadata = Buffer.alloc(36)
  metadata.writeUInt32BE(sequence, 0)
  digest.copy(metadata, 4)
  const payload = Buffer.concat([metadata, data])
  const header = Buffer.alloc(5)
  header[0] = 1
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  let sequence = 0
  let totalData = 0
  while (offset < buffer.length) {
    if (buffer.length - offset < 5) throw new Error('truncated frame header')
    const kind = buffer[offset]
    const length = buffer.readUInt32BE(offset + 1)
    offset += 5
    const maxLength = kind === 0 ? MAX_CONTROL : 36 + MAX_CHUNK
    if ((kind !== 0 && kind !== 1) || length > maxLength || length > buffer.length - offset) {
      throw new Error('invalid frame length')
    }
    const payload = buffer.subarray(offset, offset + length)
    offset += length
    if (kind === 0) {
      if (length < 2 || payload[length - 1] !== 10) throw new Error('invalid control frame')
      frames.push({ kind: 'control', value: JSON.parse(payload.subarray(0, -1).toString('utf8')) })
    } else {
      if (length < 36) throw new Error('invalid data frame')
      const currentSequence = payload.readUInt32BE(0)
      const expected = payload.subarray(4, 36)
      const data = payload.subarray(36)
      const actual = createHash('sha256').update(data).digest()
      if (currentSequence !== sequence || !timingSafeEqual(expected, actual)) throw new Error('invalid data chunk')
      sequence += 1
      totalData += data.length
      if (totalData > MAX_TRANSFER) throw new Error('transfer exceeds size limit')
      frames.push({ kind: 'data', data })
    }
  }
  return frames
}

function parseRequest(buffer) {
  const frames = decodeFrames(buffer)
  const first = frames[0]
  if (!first || first.kind !== 'control') throw new Error('request control frame required')
  const request = first.value
  if (!request || request.kind !== 'request' || request.protocolVersion !== 1 || !Object.prototype.hasOwnProperty.call(PATHS, request.operation)) {
    throw new Error('unsupported helper request')
  }
  if (Object.keys(request).some((key) => !['kind', 'protocolVersion', 'operation', 'port'].includes(key))) {
    throw new Error('unsupported helper request field')
  }
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) throw new Error('invalid loopback port')
  const operation = PATHS[request.operation]
  if (request.operation === 'node-apply' || request.operation === 'session-apply') {
    const last = frames[frames.length - 1]
    if (!last || last.kind !== 'control' || last.value.kind !== 'request-end') throw new Error('apply request terminator required')
    if (frames.slice(1, -1).some((frame) => frame.kind !== 'data')) throw new Error('invalid apply request body')
    const chunks = frames.slice(1, -1).map((frame) => frame.data)
    return { request, operation, body: Buffer.concat(chunks) }
  }
  if (frames.length !== 1) throw new Error('unexpected helper request frames')
  return { request, operation }
}

async function run() {
  const buffer = Buffer.concat(input, inputBytes)
  const { request, operation, body } = parseRequest(buffer)
  const url = 'http://127.0.0.1:' + request.port + operation.path
  const response = await fetch(url, {
    method: operation.method,
    redirect: 'error',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
  })

  function writeStdout(data) {
    return new Promise(function(resolve, reject) {
      if (process.stdout.write(data)) resolve()
      else process.stdout.once('drain', resolve)
    })
  }

  if (request.operation === 'node-manifest' || request.operation === 'session-bundle') {
    await writeStdout(encodeControl({ kind: 'response', status: response.status, bodyMode: 'data' }))
    if (!response.body) throw new Error('manifest response body missing')
    var sequence = 0
    var total = 0
    for await (var chunk of response.body) {
      var data = Buffer.from(chunk)
      total += data.length
      if (total > MAX_TRANSFER) throw new Error('manifest exceeds size limit')
      for (var offset = 0; offset < data.length; offset += MAX_CHUNK) {
        await writeStdout(encodeData(sequence++, data.subarray(offset, Math.min(offset + MAX_CHUNK, data.length))))
      }
    }
    await writeStdout(encodeControl({ kind: 'response-end' }))
    if (!response.ok) process.exitCode = 1
    return
  }

  var text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL) throw new Error('response control frame too large')
  await writeStdout(encodeControl({ kind: 'response', status: response.status, body: JSON.parse(text) }))
  if (!response.ok) process.exitCode = 1
}

process.stdin.on('data', (chunk) => {
  inputBytes += chunk.length
  if (inputBytes > MAX_TRANSFER + 2 * MAX_CONTROL) {
    process.exitCode = 1
    process.stdin.destroy()
    return
  }
  input.push(Buffer.from(chunk))
})
process.stdin.on('end', () => {
  run().catch(() => {
    try { process.stdout.write(encodeControl({ kind: 'error', code: 'helper-failed' })) } catch {}
    process.exitCode = 1
  })
})
`

const REMOTE_HELPER_BASE64 = Buffer.from(REMOTE_HELPER_SOURCE, 'utf8').toString('base64')

export const REMOTE_SYNC_HELPER_COMMAND =
  `node -e 'eval(Buffer.from("${REMOTE_HELPER_BASE64}","base64").toString("utf8"))'`
