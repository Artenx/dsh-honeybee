import { Buffer } from 'node:buffer'

const REMOTE_HELPER_SOURCE = String.raw`'use strict'
const { createHash, timingSafeEqual } = require('node:crypto')
const MAX_CONTROL = 65536
const MAX_CHUNK = 1048576
const MAX_TRANSFER = 107374182400
const OBJECT_STREAM_LIMIT = 68719476736
const PATHS = {
  handshake: { path: '/api/dshb/sync/internal/handshake', method: 'GET' },
  'node-manifest': { path: '/api/dshb/sync/internal/nodes/manifest', method: 'GET' },
  'node-apply': { path: '/api/dshb/sync/internal/nodes/apply', method: 'POST' },
  'session-bundle': { path: '/api/dshb/sync/internal/sessions/bundle', method: 'GET' },
  'session-manifest': { path: '/api/dshb/sync/internal/sessions/manifest', method: 'GET' },
  catalog: { path: '/api/dshb/sync/internal/catalog', method: 'GET' },
  'session-entries': { path: '/api/dshb/sync/internal/sessions/entries', method: 'POST' },
  'session-apply': { path: '/api/dshb/sync/internal/sessions/apply', method: 'POST' },
  'session-objects': { path: '/api/dshb/sync/internal/sessions/objects', method: 'POST' },
  'session-objects-push': { path: '/api/dshb/sync/internal/sessions/objects', method: 'POST' },
  'relay-ticket': { path: '/api/dshb/sync/internal/relay-ticket', method: 'POST' },
}
const BUFFERED_BODY_OPERATIONS = ['node-apply', 'session-entries', 'session-apply', 'session-objects', 'relay-ticket']
const STREAMING_RESPONSE_OPERATIONS = ['node-manifest', 'session-bundle', 'session-manifest', 'session-entries', 'session-objects', 'catalog', 'relay-ticket']

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

function decodeOneFrame(kind, payload, state) {
  if (kind === 0) {
    if (payload.length < 2 || payload[payload.length - 1] !== 10) throw new Error('invalid control frame')
    return { kind: 'control', value: JSON.parse(payload.subarray(0, -1).toString('utf8')) }
  }
  if (payload.length < 36) throw new Error('invalid data frame')
  const currentSequence = payload.readUInt32BE(0)
  const expected = payload.subarray(4, 36)
  const data = payload.subarray(36)
  const actual = createHash('sha256').update(data).digest()
  if (currentSequence !== state.sequence || !timingSafeEqual(expected, actual)) throw new Error('invalid data chunk')
  state.sequence += 1
  state.totalData += data.length
  if (state.totalData > MAX_TRANSFER && state.totalData > OBJECT_STREAM_LIMIT) throw new Error('transfer exceeds size limit')
  return { kind: 'data', data }
}

async function readFrame(iterator, state) {
  for (;;) {
    if (state.buffer.length >= 5) {
      const kind = state.buffer[0]
      const length = state.buffer.readUInt32BE(1)
      const maxLength = kind === 0 ? MAX_CONTROL : 36 + MAX_CHUNK
      if ((kind !== 0 && kind !== 1) || length > maxLength) throw new Error('invalid frame length')
      if (state.buffer.length >= 5 + length) {
        const payload = state.buffer.subarray(5, 5 + length)
        state.buffer = state.buffer.subarray(5 + length)
        return decodeOneFrame(kind, payload, state)
      }
    }
    const next = await iterator.next()
    if (next.done) throw new Error('helper input ended inside a frame')
    state.buffer = Buffer.concat([state.buffer, Buffer.from(next.value)])
  }
}

function validateRequest(request) {
  if (!request || request.kind !== 'request' || request.protocolVersion !== 1 || !Object.prototype.hasOwnProperty.call(PATHS, request.operation)) {
    throw new Error('unsupported helper request')
  }
  if (Object.keys(request).some(function (key) { return ['kind', 'protocolVersion', 'operation', 'port'].indexOf(key) < 0 })) {
    throw new Error('unsupported helper request field')
  }
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) throw new Error('invalid loopback port')
  return PATHS[request.operation]
}

function writeStdout(data) {
  return new Promise(function (resolve, reject) {
    if (process.stdout.write(data)) resolve()
    else process.stdout.once('drain', resolve)
  })
}

async function run() {
  const iterator = process.stdin[Symbol.asyncIterator]()
  const state = { buffer: Buffer.alloc(0), sequence: 0, totalData: 0 }
  const first = await readFrame(iterator, state)
  if (first.kind !== 'control' || first.value.kind !== 'request') throw new Error('request control frame required')
  const request = first.value
  const operation = validateRequest(request)
  const url = 'http://127.0.0.1:' + request.port + operation.path

  if (request.operation === 'session-objects-push') {
    // 对象推送：请求体（对象帧流）直接转发为 HTTP 流式请求体，内存 O(帧)。
    const { Readable } = require('node:stream')
    const bodyStream = new Readable({ read: function () {} })
    const pump = (async function () {
      try {
        for (;;) {
          const frame = await readFrame(iterator, state)
          if (frame.kind === 'control' && frame.value.kind === 'request-end') break
          if (frame.kind !== 'data') throw new Error('invalid object push frame')
          if (!bodyStream.push(Buffer.from(frame.data))) {
            await new Promise(function (resolve) { bodyStream.once('drain', resolve) })
          }
        }
        bodyStream.push(null)
      } catch (error) {
        bodyStream.destroy(error)
      }
    })()
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-dshb-object-stream' },
      body: bodyStream,
      duplex: 'half',
    })
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL) throw new Error('response control frame too large')
    await writeStdout(encodeControl({ kind: 'response', status: response.status, body: JSON.parse(text) }))
    if (!response.ok) process.exitCode = 1
    await pump
    return
  }

  let body
  if (BUFFERED_BODY_OPERATIONS.indexOf(request.operation) >= 0) {
    // 帧序：control(request) → data… → control(request-end)。
    const chunks = []
    for (;;) {
      const frame = await readFrame(iterator, state)
      if (frame.kind === 'control' && frame.value.kind === 'request-end') break
      if (frame.kind !== 'data') throw new Error('invalid apply request body')
      chunks.push(frame.data)
    }
    body = Buffer.concat(chunks)
  }

  const response = await fetch(url, {
    method: operation.method,
    redirect: 'error',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
  })

  if (STREAMING_RESPONSE_OPERATIONS.indexOf(request.operation) >= 0) {
    await writeStdout(encodeControl({ kind: 'response', status: response.status, bodyMode: 'data' }))
    if (!response.body) throw new Error('streaming response body missing')
    var sequence = 0
    var total = 0
    for await (var chunk of response.body) {
      var data = Buffer.from(chunk)
      total += data.length
      if (total > MAX_TRANSFER && total > OBJECT_STREAM_LIMIT) throw new Error('response exceeds size limit')
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
  var responseBody = JSON.parse(text)
  await writeStdout(encodeControl({ kind: 'response', status: response.status, body: responseBody }))
  var recoverableDeltaMismatch = request.operation === 'session-apply' && response.status === 409 &&
    responseBody && responseBody.code === 'session-delta-prefix'
  if (!response.ok && !recoverableDeltaMismatch) process.exitCode = 1
}

run().catch(function () {
  try { process.stdout.write(encodeControl({ kind: 'error', code: 'helper-failed' })) } catch (err) {}
  process.exitCode = 1
})
`

const REMOTE_HELPER_BASE64 = Buffer.from(REMOTE_HELPER_SOURCE, 'utf8').toString('base64')

export const REMOTE_SYNC_HELPER_COMMAND =
  `node -e 'eval(Buffer.from("${REMOTE_HELPER_BASE64}","base64").toString("utf8"))'`
