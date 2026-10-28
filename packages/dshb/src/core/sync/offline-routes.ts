import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { pipeline } from 'node:stream/promises'
import { MAX_OFFLINE_ARCHIVE_BYTES, SyncOfflineArchiveError, SyncOfflineArchiveService } from './offline-archive.js'
import { SyncSessionError } from './session-sync.js'

const MAX_JSON_BYTES = 8 * 1024
const UPLOAD_TOKEN_TTL_MS = 5 * 60 * 1000

interface UploadToken {
  password: string
  timer: NodeJS.Timeout
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function pathSegments(req: IncomingMessage): string[] {
  return new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean)
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      resolve(undefined)
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      resolve(undefined)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.byteLength
      if (bytes > MAX_JSON_BYTES) {
        fail()
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail()
        settled = true
        resolve(value as Record<string, unknown>)
      } catch {
        fail()
      }
    })
    req.on('error', fail)
  })
}

function archiveFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof SyncSessionError) {
    const status = error.code === 'bundle-too-large' || error.code === 'session-too-large' ? 413
      : error.code.includes('conflict') ? 409
        : 422
    sendJson(res, status, { ok: false, code: error.code, error: error.message })
    return
  }
  if (!(error instanceof SyncOfflineArchiveError)) {
    sendJson(res, 500, { ok: false, code: 'archive-failed', error: 'Offline archive operation failed' })
    return
  }
  const status = error.code === 'archive-too-large' ? 413
    : error.code === 'disk-space' ? 507
      : error.code === 'archive-conflict' ? 409
      : error.code === 'password-required' || error.code === 'password-invalid' || error.code === 'request-invalid' ? 400
        : error.code === 'format-unsupported' ? 415
          : error.code === 'password-or-integrity' || error.code === 'archive-integrity' || error.code === 'zip-invalid' || error.code === 'path-invalid' ? 422
            : error.code === 'archive-invalid' ? 422
              : error.code.endsWith('-failed') ? 500 : 400
  sendJson(res, status, { ok: false, code: error.code, error: error.message })
}

export function registerSyncOfflineRoutes(ctx: Context, archives: SyncOfflineArchiveService): void {
  const uploadTokens = new Map<string, UploadToken>()
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dshb/sync/offline',
      handler: async (req, res) => {
        const segments = pathSegments(req)
        if (segments.length === 5 && segments[4] === 'export' && req.method === 'POST') {
          const body = await readJson(req)
          if (!body || typeof body.password !== 'string' ||
            (body.includeSessions !== undefined && typeof body.includeSessions !== 'boolean')) {
            sendJson(res, 400, { ok: false, code: 'request-invalid', error: 'Export request is invalid' })
            return
          }
          let archive: Awaited<ReturnType<SyncOfflineArchiveService['exportArchive']>> | undefined
          try {
            archive = await archives.exportArchive(body.password, body.includeSessions === true)
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-length': archive.bytes,
              'content-disposition': `attachment; filename="dshb-sync-${new Date().toISOString().slice(0, 10)}.dshb-sync"`,
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            })
            await pipeline(createReadStream(archive.path), res)
          } catch (error) {
            if (!res.headersSent) archiveFailure(res, error)
          } finally {
            archive?.cleanup()
          }
          return
        }

        if (segments.length === 5 && segments[4] === 'import' && req.method === 'POST') {
          const body = await readJson(req)
          if (!body || typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') < 8 ||
            Buffer.byteLength(body.password, 'utf8') > 1024 || body.password.includes('\0')) {
            sendJson(res, 400, { ok: false, code: 'password-invalid', error: 'Package password must be 8-1024 UTF-8 bytes' })
            return
          }
          const token = randomBytes(24).toString('hex')
          const timer = setTimeout(() => uploadTokens.delete(token), UPLOAD_TOKEN_TTL_MS)
          timer.unref()
          uploadTokens.set(token, { password: body.password, timer })
          sendJson(res, 201, { ok: true, uploadToken: token, expiresInMs: UPLOAD_TOKEN_TTL_MS })
          return
        }

        if (segments.length === 6 && segments[4] === 'import' && /^[a-f0-9]{48}$/.test(segments[5] ?? '') && req.method === 'PUT') {
          const token = segments[5]!
          const pending = uploadTokens.get(token)
          if (!pending) {
            req.resume()
            sendJson(res, 404, { ok: false, code: 'upload-token-expired', error: 'Import upload token expired' })
            return
          }
          clearTimeout(pending.timer)
          uploadTokens.delete(token)
          const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
          const contentLength = Number(req.headers['content-length'])
          if (contentType !== 'application/octet-stream' || (Number.isFinite(contentLength) && contentLength > MAX_OFFLINE_ARCHIVE_BYTES)) {
            req.resume()
            sendJson(res, contentLength > MAX_OFFLINE_ARCHIVE_BYTES ? 413 : 415, {
              ok: false,
              code: contentLength > MAX_OFFLINE_ARCHIVE_BYTES ? 'archive-too-large' : 'content-type-invalid',
              error: contentLength > MAX_OFFLINE_ARCHIVE_BYTES ? 'Offline archive exceeds the upload size limit' : 'Expected an encrypted archive body',
            })
            return
          }
          try {
            const result = await archives.importArchive(pending.password, req)
            sendJson(res, 200, { ok: true, result })
          } catch (error) {
            req.resume()
            archiveFailure(res, error)
          }
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    })
    return () => {
      unregister()
      for (const pending of uploadTokens.values()) clearTimeout(pending.timer)
      uploadTokens.clear()
    }
  })
}
