import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { registerSyncSessionRoutes } from '../../src/core/sync/session-routes.js'
import type { SyncSessionService } from '../../src/core/sync/session-sync.js'

function setup() {
  const routes: Array<{ handler: (req: never, res: never) => unknown }> = []
  const sessions = {
    listArchives: vi.fn(() => [{
      branchId: 'b-0123456789abcdef0123456789abcdef',
      originInstanceId: 'i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      originSessionId: 'session-a',
      localSessionId: 'session-b',
      revision: { physicalTimeMs: 1, logicalCounter: 0, writerInstanceId: 'i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      contentDigest: `sha256:${'a'.repeat(64)}`,
      stateDigest: `sha256:${'b'.repeat(64)}`,
      workspacePosition: 0,
      archivedAt: '2026-10-26T00:00:00.000Z',
    }]),
    restoreArchive: vi.fn(async () => 'session-restored'),
  }
  const ctx = {
    webServer: { register(route: { handler: (req: never, res: never) => unknown }) { routes.push(route); return () => {} } },
    effect(register: () => () => void) { register() },
  }
  registerSyncSessionRoutes(ctx as never, sessions as unknown as SyncSessionService)
  return { route: routes[0]!, sessions }
}

async function call(route: { handler: (req: never, res: never) => unknown }, method: string, url: string) {
  const request = Object.assign(new EventEmitter(), { method, url })
  const response = {
    status: 0,
    body: '',
    writeHead(status: number) { this.status = status },
    end(body?: string) { this.body = body ?? '' },
  }
  await route.handler(request as never, response as never)
  return { status: response.status, body: JSON.parse(response.body || '{}') as Record<string, unknown> }
}

describe('sync session archive routes', () => {
  it('lists recoverable branches and restores a selected branch', async () => {
    const { route, sessions } = setup()
    const listed = await call(route, 'GET', '/api/dshb/sync/archives')
    const restored = await call(route, 'POST', '/api/dshb/sync/archives/b-0123456789abcdef0123456789abcdef/restore')

    expect(listed.status).toBe(200)
    expect(listed.body.archives).toHaveLength(1)
    expect(restored).toEqual({ status: 200, body: { ok: true, sessionId: 'session-restored' } })
    expect(sessions.restoreArchive).toHaveBeenCalledWith('b-0123456789abcdef0123456789abcdef')
  })

  it('rejects malformed branch IDs before reaching the session service', async () => {
    const { route, sessions } = setup()
    const response = await call(route, 'POST', '/api/dshb/sync/archives/not-valid/restore')
    expect(response.status).toBe(400)
    expect(sessions.restoreArchive).not.toHaveBeenCalled()
  })
})
