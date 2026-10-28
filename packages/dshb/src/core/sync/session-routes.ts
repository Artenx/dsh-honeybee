import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SyncSessionError, SyncSessionService } from './session-sync.js'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function pathSegments(req: IncomingMessage): string[] {
  return new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean)
}

export function registerSyncSessionRoutes(ctx: Context, sessions: SyncSessionService): void {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dshb/sync/archives',
      handler: async (req, res) => {
        const segments = pathSegments(req)
        if (req.method === 'GET' && segments.length === 4) {
          try {
            sendJson(res, 200, { ok: true, archives: sessions.listArchives() })
          } catch {
            sendJson(res, 500, { ok: false, error: 'session archive list unavailable' })
          }
          return
        }
        if (req.method === 'POST' && segments.length === 6 && segments[5] === 'restore') {
          const branchId = segments[4]
          if (!/^b-[a-f0-9]{32}$/.test(branchId)) {
            sendJson(res, 400, { ok: false, error: 'invalid session branch ID' })
            return
          }
          try {
            const sessionId = await sessions.restoreArchive(branchId)
            sendJson(res, 200, { ok: true, sessionId })
          } catch (error) {
            const code = error instanceof SyncSessionError ? error.code : 'session-restore-failed'
            sendJson(res, code === 'archive-not-found' ? 404 : 409, {
              ok: false,
              code,
              error: error instanceof SyncSessionError ? error.message : 'session archive restore failed',
            })
          }
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}
