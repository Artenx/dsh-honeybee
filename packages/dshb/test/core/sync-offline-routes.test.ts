import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { registerSyncOfflineRoutes } from '../../src/core/sync/offline-routes.js'
import type { SyncOfflineArchiveService } from '../../src/core/sync/offline-archive.js'

function setup() {
  const routes: Array<{ handler: (req: never, res: never) => Promise<void> }> = []
  const disposers: Array<() => void> = []
  const imports: Array<{ password: string; bytes: Buffer }> = []
  const archives = {
    async importArchive(password: string, input: AsyncIterable<Uint8Array>) {
      const chunks: Uint8Array[] = []
      for await (const chunk of input) chunks.push(chunk)
      imports.push({ password, bytes: Buffer.concat(chunks) })
      return { nodes: { created: 1, updated: 0, deleted: 0, pendingRemoval: 0, skipped: 0 } }
    },
  }
  const ctx = {
    webServer: { register(route: { handler: (req: never, res: never) => Promise<void> }) { routes.push(route); return () => {} } },
    effect(register: () => () => void) { disposers.push(register()) },
  }
  registerSyncOfflineRoutes(ctx as never, archives as unknown as SyncOfflineArchiveService)
  return { route: routes[0]!, imports, dispose: () => disposers.forEach((dispose) => dispose()) }
}

async function call(
  route: { handler: (req: never, res: never) => Promise<void> },
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | Buffer,
) {
  const request = Object.assign(new PassThrough(), { method, url, headers })
  const response = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, values: Record<string, string>) { this.status = status; this.headers = values },
    end(value?: string) { this.body = value ?? '' },
  }
  const pending = route.handler(request as never, response as never)
  request.end(body)
  await pending
  return { status: response.status, headers: response.headers, body: JSON.parse(response.body || '{}') as Record<string, unknown> }
}

describe('offline sync routes', () => {
  it('keeps the password out of the upload token response and consumes the token once', async () => {
    const { route, imports, dispose } = setup()
    try {
      const prepared = await call(
        route,
        'POST',
        '/api/dshb/sync/offline/import',
        { 'content-type': 'application/json' },
        JSON.stringify({ password: 'a secure package password' }),
      )
      const token = prepared.body.uploadToken as string
      expect(prepared.status).toBe(201)
      expect(JSON.stringify(prepared.body)).not.toContain('a secure package password')
      expect(token).toMatch(/^[a-f0-9]{48}$/)

      const uploaded = await call(
        route,
        'PUT',
        `/api/dshb/sync/offline/import/${token}`,
        { 'content-type': 'application/octet-stream' },
        Buffer.from('encrypted archive bytes'),
      )
      expect(uploaded.status).toBe(200)
      expect(imports).toEqual([{ password: 'a secure package password', bytes: Buffer.from('encrypted archive bytes') }])

      const repeated = await call(
        route,
        'PUT',
        `/api/dshb/sync/offline/import/${token}`,
        { 'content-type': 'application/octet-stream' },
        Buffer.from('second attempt'),
      )
      expect(repeated.status).toBe(404)
      expect(imports).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('rejects malformed passwords before creating an upload token', async () => {
    const { route, dispose } = setup()
    try {
      const response = await call(
        route,
        'POST',
        '/api/dshb/sync/offline/import',
        { 'content-type': 'application/json' },
        JSON.stringify({ password: 'short' }),
      )
      expect(response.status).toBe(400)
      expect(response.body.code).toBe('password-invalid')
    } finally {
      dispose()
    }
  })
})
