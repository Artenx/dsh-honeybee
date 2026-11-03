import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest } from '../../auth/loopback.js'
import { SyncNodeManifestError, type SyncNodeService } from './node-sync.js'
import {
  MAX_SESSION_OBJECT_STREAM_BYTES,
  SYNC_PROTOCOL_VERSION,
  SYNC_SESSION_BUNDLE_OBJECTS_CAPABILITY,
  SYNC_SESSION_EVENT_TAIL_CAPABILITY,
  SYNC_SESSION_MANIFEST_CAPABILITY,
  SYNC_SESSION_OBJECT_STREAM_CAPABILITY,
  SYNC_CATALOG_CAPABILITY,
} from './protocol.js'
import { SyncSessionError, type SyncSessionEventPrefix, type SyncSessionService, validateObjectPayload } from './session-sync.js'
import type { SyncStateStore } from './stores.js'
import { exportSyncCatalog } from './catalog.js'

// 与 MAX_SYNC_TRANSFER_BYTES 对齐的请求体硬上限：超限直接断开（resolve null → 400），
// 避免对端（或恶意请求）把宿主堆吃满。协调器分批后正常请求远小于该值。
const MAX_APPLY_BODY_BYTES = 128 * 1024 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function pathSegments(req: IncomingMessage): string[] {
  return new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      resolve(null)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_APPLY_BODY_BYTES) {
        fail()
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          fail()
          return
        }
        settled = true
        resolve(value as Record<string, unknown>)
      } catch {
        fail()
      }
    })
    req.on('error', fail)
  })
}

/**
 * 会话对象带外流端点（POST /api/dshb/sync/internal/sessions/objects）：
 * - 拉取模式（application/json 请求体 {objects: 描述符[]}）：把本地对象编码为
 *   "JSON 头行 + 原始字节" 帧流响应，磁盘到网络流式读出，内存 O(帧)。
 * - 推送模式（application/x-dshb-object-stream 请求体）：请求帧流直接落盘
 *   收件箱（边收边校验摘要），返回 JSON 摘要。
 * 两种模式全程流式，单对象体积上限 MAX_SESSION_OBJECT_STREAM_BYTES（64GB），
 * 不受 JSON bundle 传输上限约束。
 */
async function handleSessionObjects(
  sessionSync: SyncSessionService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) {
    sendJson(res, 403, { ok: false, error: 'loopback access required' })
    return
  }
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType === 'application/x-dshb-object-stream') {
    try {
      const received = await sessionSync.ingestObjectStream(req)
      sendJson(res, 200, { ok: true, received })
    } catch (error) {
      const code = error instanceof SyncSessionError ? error.code : 'object-stream-failed'
      sendJson(res, 422, { ok: false, code, error: error instanceof SyncSessionError ? error.message : 'object stream ingest failed' })
    }
    return
  }
  if (contentType !== 'application/json') {
    sendJson(res, 400, { ok: false, code: 'object-request-invalid', error: 'json or object-stream content type is required' })
    return
  }
  const body = await readJsonBody(req)
  if (!body || !Array.isArray(body.objects) || body.objects.length > 10_000 ||
    body.objects.some((object) => {
      try {
        return validateObjectPayload(object).deferred !== true
      } catch {
        return true
      }
    })) {
    sendJson(res, 400, { ok: false, code: 'object-request-invalid', error: 'deferred session object descriptors are required' })
    return
  }
  const objects = (body.objects as unknown[]).map((object) => validateObjectPayload(object))
  res.writeHead(200, { 'content-type': 'application/x-dshb-object-stream', 'cache-control': 'no-store' })
  try {
    for await (const chunk of sessionSync.streamObjects(objects)) {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          res.once('drain', resolve)
          res.once('error', reject)
        })
      }
    }
    res.end()
  } catch {
    res.destroy()
  }
}

export function registerSyncInternalRoutes(
  ctx: Context,
  state: SyncStateStore,
  nodeSync?: SyncNodeService,
  sessionSync?: SyncSessionService,
): void {
  const capabilities = [
    'peer-handshake',
    ...(nodeSync ? ['node-sync'] : []),
    ...(sessionSync ? ['session-sync', SYNC_SESSION_MANIFEST_CAPABILITY, SYNC_SESSION_EVENT_TAIL_CAPABILITY, SYNC_SESSION_BUNDLE_OBJECTS_CAPABILITY, SYNC_SESSION_OBJECT_STREAM_CAPABILITY] : []),
    ...(nodeSync && sessionSync ? [SYNC_CATALOG_CAPABILITY] : []),
  ]
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/dshb/sync/internal/handshake',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) {
          sendJson(res, 403, { ok: false, error: 'loopback access required' })
          return
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, {
            ok: true,
            protocolVersion: SYNC_PROTOCOL_VERSION,
            instanceId: state.instanceId(),
            capabilities,
          })
        } catch {
          sendJson(res, 503, { ok: false, error: 'sync identity unavailable' })
        }
      },
    }),
  )

  if (nodeSync) ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dshb/sync/internal/nodes',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) {
          sendJson(res, 403, { ok: false, error: 'loopback access required' })
          return
        }
        const segments = pathSegments(req)
        const action = segments[5]
        if (segments.length !== 6) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }
        if (req.method === 'GET' && action === 'manifest') {
          try {
            sendJson(res, 200, { ok: true, manifest: await nodeSync.exportManifest(), capabilities })
          } catch {
            sendJson(res, 500, { ok: false, error: 'node manifest export failed' })
          }
          return
        }
        if (req.method === 'POST' && action === 'apply') {
          const body = await readJsonBody(req)
          if (!body || !Array.isArray(body.records) || typeof body.sourceName !== 'string') {
            sendJson(res, 400, { ok: false, error: 'records and sourceName are required' })
            return
          }
          try {
            sendJson(res, 200, { ok: true, result: await nodeSync.applyManifest(body.records, body.sourceName) })
          } catch (error) {
            const status = error instanceof SyncNodeManifestError ? 400 : 500
            sendJson(res, status, { ok: false, error: status === 400 ? 'node manifest rejected' : 'node manifest apply failed' })
          }
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )

  if (nodeSync && sessionSync) ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/dshb/sync/internal/catalog',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) {
          sendJson(res, 403, { ok: false, error: 'loopback access required' })
          return
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, { ok: true, catalog: await exportSyncCatalog(nodeSync, sessionSync) })
        } catch {
          sendJson(res, 500, { ok: false, error: 'sync catalog export failed' })
        }
      },
    }),
  )

  if (!sessionSync) return
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dshb/sync/internal/sessions',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req.socket.remoteAddress, req.headers.host)) {
          sendJson(res, 403, { ok: false, error: 'loopback access required' })
          return
        }
        const segments = pathSegments(req)
        const action = segments[5]
        if (segments.length !== 6) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }
        if (req.method === 'GET' && action === 'bundle') {
          try {
            sendJson(res, 200, { ok: true, bundle: await sessionSync.exportBundle() })
          } catch (error) {
            const code = error instanceof SyncSessionError ? error.code : 'session-export-failed'
            const status = code === 'bundle-too-large' ? 413 : 500
            sendJson(res, status, { ok: false, code, error: error instanceof SyncSessionError ? error.message : 'session bundle export failed' })
          }
          return
        }
        if (req.method === 'GET' && action === 'manifest') {
          try {
            sendJson(res, 200, { ok: true, manifest: await sessionSync.exportManifest() })
          } catch (error) {
            const code = error instanceof SyncSessionError ? error.code : 'session-export-failed'
            const status = code === 'bundle-too-large' ? 413 : 500
            sendJson(res, status, { ok: false, code, error: error instanceof SyncSessionError ? error.message : 'session manifest export failed' })
          }
          return
        }
        if (req.method === 'POST' && action === 'entries') {
          const body = await readJsonBody(req)
          const prefixesValid = body?.prefixes === undefined || (Array.isArray(body.prefixes) &&
            body.prefixes.every((prefix) => prefix !== null && typeof prefix === 'object' && !Array.isArray(prefix)))
          if (!body || !Array.isArray(body.keys) || !body.keys.every((key) => typeof key === 'string') ||
            typeof body.manifestDigest !== 'string' || !prefixesValid) {
            sendJson(res, 400, { ok: false, code: 'session-request-invalid', error: 'keys, manifestDigest, and valid prefixes are required' })
            return
          }
          try {
            sendJson(res, 200, {
              ok: true,
              bundle: await sessionSync.exportEntries(
                body.keys as string[],
                body.manifestDigest,
                (body.prefixes ?? []) as SyncSessionEventPrefix[],
                { deferredObjects: body.deferredObjects === true },
              ),
            })
          } catch (error) {
            const code = error instanceof SyncSessionError ? error.code : 'session-export-failed'
            const status = code === 'bundle-too-large' ? 413 : 500
            sendJson(res, status, { ok: false, code, error: error instanceof SyncSessionError ? error.message : 'session entries export failed' })
          }
          return
        }
        if (req.method === 'POST' && action === 'objects') {
          await handleSessionObjects(sessionSync, req, res)
          return
        }
        if (req.method === 'POST' && action === 'apply') {
          const body = await readJsonBody(req)
          if (!body || body.bundle === null || typeof body.bundle !== 'object' ||
            typeof body.sourceName !== 'string' || typeof body.peerId !== 'string' || !/^p-[a-f0-9]{24}$/.test(body.peerId)) {
            sendJson(res, 400, { ok: false, code: 'session-request-invalid', error: 'bundle, sourceName, and peerId are required' })
            return
          }
          try {
            sendJson(res, 200, {
              ok: true,
              result: await sessionSync.applyBundle(body.bundle, body.sourceName, body.peerId),
            })
          } catch (error) {
            const code = error instanceof SyncSessionError ? error.code : 'session-apply-failed'
            const status = code === 'bundle-too-large' ? 413
              : ['manifest-invalid', 'manifest-digest', 'object-invalid', 'session-format'].includes(code) ? 400
                : code === 'workspace-unmapped' || code === 'session-delta-prefix' ? 409 : 500
            sendJson(res, status, { ok: false, code, error: error instanceof SyncSessionError ? error.message : 'session bundle apply failed' })
          }
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}
