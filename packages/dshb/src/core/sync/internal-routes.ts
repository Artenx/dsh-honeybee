import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest } from '../../auth/loopback.js'
import { SyncNodeManifestError, type SyncNodeService } from './node-sync.js'
import { SyncSessionError, type SyncSessionService } from './session-sync.js'
import { MAX_SYNC_TRANSFER_BYTES, SYNC_PROTOCOL_VERSION } from './protocol.js'
import type { SyncStateStore } from './stores.js'

const MAX_APPLY_BODY_BYTES = MAX_SYNC_TRANSFER_BYTES

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

export function registerSyncInternalRoutes(
  ctx: Context,
  state: SyncStateStore,
  nodeSync?: SyncNodeService,
  sessionSync?: SyncSessionService,
): void {
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
            capabilities: [
              'peer-handshake',
              ...(nodeSync ? ['node-sync'] : []),
              ...(sessionSync ? ['session-sync'] : []),
            ],
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
            sendJson(res, 200, { ok: true, manifest: await nodeSync.exportManifest() })
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
                : code === 'workspace-unmapped' ? 409 : 500
            sendJson(res, status, { ok: false, code, error: error instanceof SyncSessionError ? error.message : 'session bundle apply failed' })
          }
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}
