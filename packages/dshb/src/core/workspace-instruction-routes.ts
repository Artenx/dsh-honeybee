import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  InstructionConflictError,
  InstructionSizeError,
  INSTRUCTION_MAX_BYTES,
  type WorkspaceInstructionStore,
} from './workspace-instructions.js'

const MAX_BODY = 64 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    if ((req.headers['content-type'] ?? '') !== 'application/json') {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function pathSegments(req: IncomingMessage): string[] {
  return new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean)
}

interface WorkspaceRegistryLike {
  get(workspaceId: string): { id: string; path: string; title: string } | undefined
}

export function registerWorkspaceInstructionRoutes(ctx: Context, store: WorkspaceInstructionStore): void {
  const webServer = ctx.webServer

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/api/dshb/instructions',
      handler: async (req, res) => {
        const segs = pathSegments(req)
        const workspaceId = segs[3]
        if (!workspaceId) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }

        const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
        if (registry) {
          const ws = registry.get(workspaceId)
          if (!ws) {
            sendJson(res, 404, { ok: false, error: 'workspace not found' })
            return
          }
        }

        if (req.method === 'GET') {
          const record = store.get(workspaceId)
          if (!record) {
            sendJson(res, 200, {
              workspaceId,
              text: '',
              revision: 0,
              updatedAt: null,
            })
            return
          }
          sendJson(res, 200, {
            workspaceId: record.workspaceId,
            text: record.text,
            revision: record.revision,
            updatedAt: record.updatedAt,
          })
          return
        }

        if (req.method === 'PUT') {
          const body = await readBody(req)
          if (!body || typeof body.text !== 'string' || typeof body.expectedRevision !== 'number') {
            sendJson(res, 400, { ok: false, error: '需要 text 和 expectedRevision' })
            return
          }
          const text = body.text as string
          const expectedRevision = body.expectedRevision as number
          try {
            if (text.length === 0) {
              store.clear(workspaceId, expectedRevision)
              sendJson(res, 200, {
                workspaceId,
                text: '',
                revision: expectedRevision,
                updatedAt: null,
              })
              return
            }
            const record = store.update({ workspaceId, text, expectedRevision })
            sendJson(res, 200, {
              workspaceId: record.workspaceId,
              text: record.text,
              revision: record.revision,
              updatedAt: record.updatedAt,
            })
            return
          } catch (err) {
            if (err instanceof InstructionConflictError) {
              const current = store.get(workspaceId)
              sendJson(res, 409, {
                ok: false,
                error: 'revision conflict',
                expected: err.expected,
                actual: err.actual,
                currentRevision: current?.revision ?? 0,
                currentText: current?.text ?? '',
                currentUpdatedAt: current?.updatedAt ?? null,
              })
              return
            }
            if (err instanceof InstructionSizeError) {
              sendJson(res, 400, {
                ok: false,
                error: `instruction exceeds ${INSTRUCTION_MAX_BYTES} bytes`,
                bytes: err.bytes,
                limit: INSTRUCTION_MAX_BYTES,
              })
              return
            }
            sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
            return
          }
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}
