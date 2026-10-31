import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerSyncInternalRoutes } from '../../src/core/sync/internal-routes.js'
import { SyncStateStore } from '../../src/core/sync/stores.js'
import { NodeRegistry } from '../../src/core/node-registry.js'
import { WorkspaceBindingsStore } from '../../src/core/workspace-bindings.js'
import { SyncNodeService } from '../../src/core/sync/node-sync.js'
import { makeSyncSessionBundle, makeSyncSessionManifest } from '../../src/core/sync/session-sync.js'
import type { SyncSessionService } from '../../src/core/sync/session-sync.js'

const homes: string[] = []
const previousDshHome = process.env.DSH_HOME

function createRoute(nodeSync?: SyncNodeService, sessionSync?: SyncSessionService): { routes: Array<{ handler: (req: never, res: never) => unknown }>; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'dshb-sync-internal-test-'))
  homes.push(home)
  mkdirSync(join(home, 'dshb'), { recursive: true, mode: 0o700 })
  const routes: Array<{ handler: (req: never, res: never) => unknown }> = []
  const ctx = {
    webServer: { register(route: { handler: (req: never, res: never) => unknown }) { routes.push(route); return () => {} } },
    effect(register: () => () => void) { register() },
  }
  registerSyncInternalRoutes(ctx as never, new SyncStateStore(home), nodeSync, sessionSync)
  return { routes, home }
}

afterEach(() => {
  process.env.DSH_HOME = previousDshHome
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

class MockRequest extends EventEmitter {
  readonly headers: Record<string, string>
  readonly socket: { remoteAddress: string }

  constructor(readonly method: string, remoteAddress: string, host: string, readonly url = '/') {
    super()
    this.socket = { remoteAddress }
    this.headers = { host }
  }

  destroy(): this { return this }
}

async function call(
  route: { handler: (req: never, res: never) => unknown },
  method: string,
  remoteAddress: string,
  host: string,
  url = '/',
  body?: unknown,
) {
  const request = new MockRequest(method, remoteAddress, host, url)
  if (body !== undefined) request.headers['content-type'] = 'application/json'
  const response = {
    status: 0,
    body: '',
    writeHead(status: number) { this.status = status },
    end(value?: string) { this.body = value ?? '' },
  }
  const pending = Promise.resolve(route.handler(request as never, response as never))
  if (body !== undefined) {
    request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
  }
  await pending
  return { status: response.status, body: JSON.parse(response.body || '{}') as Record<string, unknown> }
}

describe('loopback sync handshake route', () => {
  it('returns a stable protocol handshake only to loopback callers', async () => {
    const { routes } = createRoute()
    const route = routes[0]
    const first = await call(route, 'GET', '::ffff:127.0.0.1', '127.0.0.1:3080')
    const second = await call(route, 'GET', '127.0.0.1', 'localhost:3080')

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body).toMatchObject({ ok: true, protocolVersion: 1, capabilities: ['peer-handshake'] })
    expect(second.body.instanceId).toBe(first.body.instanceId)
  })

  it('rejects remote callers and methods other than GET', async () => {
    const { routes, home } = createRoute()
    const route = routes[0]
    const remote = await call(route, 'GET', '10.1.2.3', '127.0.0.1:3080')
    const method = await call(route, 'POST', '127.0.0.1', '127.0.0.1:3080')

    expect(remote.status).toBe(403)
    expect(method.status).toBe(405)
    expect(() => readFileSync(join(home, 'dshb', 'instance-id'))).toThrow()
  })

  it('exports and applies node manifests only through loopback endpoints', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dshb-sync-node-api-test-'))
    homes.push(home)
    mkdirSync(join(home, 'dshb'), { recursive: true, mode: 0o700 })
    process.env.DSH_HOME = home
    const credentials = {
      readRecord: async () => undefined,
      modifyRecord: async () => undefined,
      deleteRecord: async () => {},
    }
    const registry = new NodeRegistry({ credentials } as never)
    const state = new SyncStateStore(home)
    const syncNodes = new SyncNodeService(registry, new WorkspaceBindingsStore(), state)
    await registry.create({
      name: 'Node API source',
      type: 'remote-ssh',
      ssh: { host: 'sync.example', port: 22, username: 'sync', auth: { kind: 'agent' } },
    })
    const sessionBundle = makeSyncSessionBundle(state.instanceId(), [])
    const sessionSync = {
      exportBundle: async () => sessionBundle,
      exportManifest: async () => makeSyncSessionManifest(sessionBundle.instanceId, []),
      exportEntries: async () => sessionBundle,
      applyBundle: async () => ({ created: 0, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }),
    }
    const { routes } = createRoute(syncNodes, sessionSync as unknown as SyncSessionService)
    const nodeRoutes = routes[1]

    const manifestResponse = await call(nodeRoutes, 'GET', '127.0.0.1', '127.0.0.1:3080', '/api/dshb/sync/internal/nodes/manifest')
    const manifest = (manifestResponse.body.manifest as { records: unknown[] })
    const applyResponse = await call(nodeRoutes, 'POST', '127.0.0.1', 'localhost:3080', '/api/dshb/sync/internal/nodes/apply', {
      records: manifest.records,
      sourceName: 'self',
    })
    const remoteResponse = await call(nodeRoutes, 'GET', '10.0.0.5', '127.0.0.1:3080', '/api/dshb/sync/internal/nodes/manifest')

    expect(manifestResponse.status).toBe(200)
    expect(manifest.records).toHaveLength(1)
    expect(manifestResponse.body.capabilities).toContain('session-manifest-v1')
    expect(applyResponse.status).toBe(200)
    expect(remoteResponse.status).toBe(403)
    expect(remoteResponse.body).not.toHaveProperty('manifest')
  })

  it('exports and applies session bundles only through loopback endpoints', async () => {
    const bundle = makeSyncSessionBundle('i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [])
    const sessionSync = {
      exportBundle: async () => bundle,
      exportManifest: async () => makeSyncSessionManifest(bundle.instanceId, bundle.entries, bundle.skipped),
      exportEntries: async () => bundle,
      applyBundle: async () => ({ created: 1, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }),
    }
    const { routes } = createRoute(undefined, sessionSync as unknown as SyncSessionService)
    const sessionRoutes = routes[1]

    const exported = await call(sessionRoutes, 'GET', '127.0.0.1', '127.0.0.1:3080', '/api/dshb/sync/internal/sessions/bundle')
    const applied = await call(sessionRoutes, 'POST', '127.0.0.1', 'localhost:3080', '/api/dshb/sync/internal/sessions/apply', {
      bundle,
      sourceName: 'source peer',
      peerId: 'p-0123456789abcdef01234567',
    })
    const remote = await call(sessionRoutes, 'GET', '10.0.0.5', '127.0.0.1:3080', '/api/dshb/sync/internal/sessions/bundle')

    expect(exported.status).toBe(200)
    expect(exported.body.bundle).toEqual(bundle)
    expect(applied.status).toBe(200)
    expect(applied.body.result).toMatchObject({ created: 1 })
    expect(remote.status).toBe(403)
  })

  it('serves session manifests and selected entries to loopback callers', async () => {
    const bundle = makeSyncSessionBundle('i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [])
    const manifest = makeSyncSessionManifest(bundle.instanceId, bundle.entries, bundle.skipped)
    const sessionSync = {
      exportBundle: async () => bundle,
      exportManifest: async () => manifest,
      exportEntries: async (keys: string[], manifestDigest: string) => {
        expect(keys).toEqual(['entry-key'])
        expect(manifestDigest).toBe(manifest.digest)
        return bundle
      },
      applyBundle: async () => ({ created: 0, updated: 0, archived: 0, deleted: 0, skipped: 0, unmapped: 0 }),
    }
    const { routes } = createRoute(undefined, sessionSync as unknown as SyncSessionService)
    const handshake = await call(routes[0]!, 'GET', '127.0.0.1', '127.0.0.1:3080', '/api/dshb/sync/internal/handshake')
    const sessionRoutes = routes[1]!
    const manifestResponse = await call(sessionRoutes, 'GET', '127.0.0.1', '127.0.0.1:3080', '/api/dshb/sync/internal/sessions/manifest')
    const entriesResponse = await call(sessionRoutes, 'POST', '127.0.0.1', '127.0.0.1:3080', '/api/dshb/sync/internal/sessions/entries', {
      keys: ['entry-key'],
      manifestDigest: manifest.digest,
    })

    expect(handshake.body.capabilities).toContain('session-manifest-v1')
    expect(handshake.body.capabilities).toContain('session-event-tail-delta-v1')
    expect(manifestResponse.body.manifest).toEqual(manifest)
    expect(entriesResponse.body.bundle).toEqual(bundle)
  })
})
