import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncHostKeyChallengeError } from '../../src/core/sync/host-key.js'
import { SyncPeerManager } from '../../src/core/sync/peer-manager.js'
import { registerSyncPeerRoutes } from '../../src/core/sync/routes.js'
import { SyncCoordinatorError } from '../../src/core/sync/coordinator.js'
import { SyncPeerStore, SyncStateStore } from '../../src/core/sync/stores.js'

const homes: string[] = []

function createManager(): { home: string; manager: SyncPeerManager; credentials: MockCredentials; state: SyncStateStore } {
  const home = mkdtempSync(join(tmpdir(), 'dshb-sync-peer-test-'))
  homes.push(home)
  mkdirSync(join(home, 'dshb'), { recursive: true, mode: 0o700 })
  const credentials = new MockCredentials()
  const state = new SyncStateStore(home)
  return { home, credentials, state, manager: new SyncPeerManager(new SyncPeerStore(home), state, credentials) }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const peerDraft = {
  name: 'Backup host',
  host: 'backup.example.com',
  port: 22,
  username: 'sync',
  authKind: 'key',
  direction: 'pull',
  schedule: 'manual',
  syncSessions: false,
  enabled: true,
}

class MockCredentials {
  private readonly records = new Map<string, unknown>()

  async readRecord(key: string): Promise<unknown> {
    return this.records.get(key)
  }

  async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
    const value = await mutate(this.records.get(key))
    if (value !== undefined) this.records.set(key, value)
    return value
  }

  async deleteRecord(key: string): Promise<void> {
    this.records.delete(key)
  }

  values(): unknown[] {
    return [...this.records.values()]
  }
}

describe('sync peer credentials and metadata', () => {
  it('stores SSH secrets separately and only returns existence flags', async () => {
    const { manager, credentials } = createManager()
    const created = await manager.create(peerDraft, { privateKey: 'PRIVATE KEY', passphrase: 'PASS_PHRASE_SECRET' })
    const serialized = JSON.stringify(created)

    expect(created.hasSecret).toEqual({ hasPassword: false, hasKey: true, hasPassphrase: true })
    expect(serialized).not.toContain('PRIVATE KEY')
    expect(serialized).not.toContain('PASS_PHRASE_SECRET')
    expect(JSON.stringify(manager['peers'].list())).not.toContain('PRIVATE KEY')
    expect(credentials.values()).toHaveLength(1)
  })

  it('preserves saved secrets when updates omit them and merges a rotated secret', async () => {
    const { manager, credentials } = createManager()
    const created = await manager.create(peerDraft, { privateKey: 'OLD KEY', passphrase: 'phrase' })
    const updated = await manager.update(created.id, { schedule: 'every-5m' }, { privateKey: 'NEW KEY' })
    const record = credentials.values()[0] as { payload: Record<string, string> }

    expect(updated.schedule).toBe('every-5m')
    expect(updated.hasSecret).toEqual({ hasPassword: false, hasKey: true, hasPassphrase: true })
    expect(record.payload).toEqual({ privateKey: 'NEW KEY', passphrase: 'phrase' })
    expect((await manager.update(created.id, { enabled: false })).enabled).toBe(false)
    expect((await manager.get(created.id))?.hasSecret.hasKey).toBe(true)
  })

  it('drops credentials for the previous auth method when the method changes', async () => {
    const { manager, credentials } = createManager()
    const created = await manager.create(peerDraft, { privateKey: 'OLD KEY', passphrase: 'OLD PHRASE' })
    const updated = await manager.update(created.id, { authKind: 'password' }, { password: 'NEW PASSWORD' })
    const record = credentials.values()[0] as { payload: Record<string, string> }

    expect(updated.authKind).toBe('password')
    expect(updated.hasSecret).toEqual({ hasPassword: true, hasKey: false, hasPassphrase: false })
    expect(record.payload).toEqual({ password: 'NEW PASSWORD' })
  })

  it('rejects invalid peer and secret fields without persisting either', async () => {
    const { manager, credentials } = createManager()

    await expect(manager.create({ ...peerDraft, host: '' }, { privateKey: 'secret' })).rejects.toThrow('host')
    await expect(manager.create(peerDraft, { password: 'secret', unexpected: 'field' })).rejects.toThrow('unsupported secret field')
    await expect(manager.create(peerDraft)).rejects.toThrow('requires a saved private key')
    await expect(manager.create({ ...peerDraft, authKind: 'password' }, { privateKey: 'wrong kind' })).rejects.toThrow('do not match password authentication')
    expect(await manager.list()).toEqual([])
    expect(credentials.values()).toEqual([])
  })

  it('removes peer credentials and progress metadata', async () => {
    const { manager, credentials, state } = createManager()
    const peer = await manager.create(peerDraft, { privateKey: 'PRIVATE KEY' })
    state.update((current) => {
      current.peers[peer.id] = { watermark: 'w1' }
    })

    expect(await manager.remove(peer.id)).toBe(true)
    expect(await manager.remove(peer.id)).toBe(false)
    expect(await manager.list()).toEqual([])
    expect(credentials.values()).toEqual([])
    expect(state.read().peers[peer.id]).toBeUndefined()
  })

  it('persists and exposes the latest safe run status', async () => {
    const { manager } = createManager()
    const peer = await manager.create(peerDraft, { privateKey: 'PRIVATE KEY' })
    manager.updateProgress(peer.id, {
      lastRunAt: '2026-10-26T01:00:00.000Z',
      lastRunStatus: 'failed',
      lastErrorCode: 'ssh-network',
      lastErrorMessage: 'SSH 节点不可达',
    })

    expect(await manager.get(peer.id)).toMatchObject({
      progress: {
        lastRunStatus: 'failed',
        lastErrorCode: 'ssh-network',
        lastErrorMessage: 'SSH 节点不可达',
      },
    })
  })
})

class MockRequest extends EventEmitter {
  readonly headers: Record<string, string>

  constructor(readonly method: string, readonly url: string, private readonly body?: unknown) {
    super()
    this.headers = body === undefined ? {} : { 'content-type': 'application/json' }
  }

  emitBody(): void {
    if (this.body === undefined) return
    this.emit('data', Buffer.from(JSON.stringify(this.body)))
    this.emit('end')
  }

  destroy(): this {
    return this
  }
}

interface CapturedRoute {
  handler: (req: never, res: never) => unknown
}

async function callRoute(route: CapturedRoute, method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new MockRequest(method, url, body)
  const response = {
    status: 0,
    body: '',
    writeHead(status: number) { this.status = status },
    end(value?: string) { this.body = value ?? '' },
  }
  const result = Promise.resolve(route.handler(request as never, response as never))
  request.emitBody()
  await result
  return { status: response.status, body: JSON.parse(response.body || '{}') as Record<string, unknown> }
}

describe('sync peer HTTP routes', () => {
  it('creates and lists peers through the authenticated webserver route with redacted secrets', async () => {
    const { manager } = createManager()
    const routes: CapturedRoute[] = []
    const ctx = {
      webServer: { register(route: CapturedRoute) { routes.push(route); return () => {} } },
      effect(register: () => () => void) { register() },
    }
    registerSyncPeerRoutes(ctx as never, manager)

    const created = await callRoute(routes[0], 'POST', '/api/dshb/sync/peers', {
      ...peerDraft,
      secrets: { privateKey: 'DO NOT RETURN THIS' },
    })
    const listed = await callRoute(routes[0], 'GET', '/api/dshb/sync/peers')
    const serialized = JSON.stringify([created.body, listed.body])

    expect(created.status).toBe(201)
    expect(listed.status).toBe(200)
    expect(serialized).not.toContain('DO NOT RETURN THIS')
    expect(serialized).toContain('"hasKey":true')
  })

  it('returns client errors for invalid data and unknown peers', async () => {
    const { manager } = createManager()
    const routes: CapturedRoute[] = []
    const ctx = {
      webServer: { register(route: CapturedRoute) { routes.push(route); return () => {} } },
      effect(register: () => () => void) { register() },
    }
    registerSyncPeerRoutes(ctx as never, manager)

    const invalid = await callRoute(routes[0], 'POST', '/api/dshb/sync/peers', { ...peerDraft, port: 0 })
    const missing = await callRoute(routes[0], 'PATCH', '/api/dshb/sync/peers/p-0123456789abcdef01234567', { enabled: false })

    expect(invalid.status).toBe(400)
    expect(missing.status).toBe(404)
  })

  it('returns host-key challenges and pins only the observed challenge', async () => {
    const { manager } = createManager()
    const peer = await manager.create(peerDraft, { privateKey: 'PRIVATE KEY' })
    const fingerprint = `SHA256:${Buffer.alloc(32, 0x51).toString('base64').replace(/=+$/, '')}`
    const transport = {
      async probe() {
        throw new SyncHostKeyChallengeError('untrusted', fingerprint)
      },
      async trustObservedHostKey(id: string) {
        return manager.pinHostKey(id, fingerprint)
      },
    }
    const routes: CapturedRoute[] = []
    const ctx = {
      webServer: { register(route: CapturedRoute) { routes.push(route); return () => {} } },
      effect(register: () => () => void) { register() },
    }
    registerSyncPeerRoutes(ctx as never, manager, transport as never)

    const probe = await callRoute(routes[0], 'POST', `/api/dshb/sync/peers/${peer.id}/probe`)
    const trust = await callRoute(routes[0], 'POST', `/api/dshb/sync/peers/${peer.id}/trust-host-key`)

    expect(probe.status).toBe(409)
    expect(probe.body).toMatchObject({ code: 'host-key-untrusted', fingerprint })
    expect(trust.status).toBe(200)
    expect((trust.body.peer as { hostKeyFingerprint?: string }).hostKeyFingerprint).toBe(fingerprint)
  })

  it('exposes the manual sync run and maps coordinator errors to stable API codes', async () => {
    const { manager } = createManager()
    const peer = await manager.create(peerDraft, { privateKey: 'PRIVATE KEY' })
    const coordinator = { run: vi.fn(async () => { throw new SyncCoordinatorError('sessions-unavailable', '会话同步尚未启用') }) }
    const transport = { probe: async () => ({}), trustObservedHostKey: async () => ({}) }
    const routes: CapturedRoute[] = []
    const ctx = {
      webServer: { register(route: CapturedRoute) { routes.push(route); return () => {} } },
      effect(register: () => () => void) { register() },
    }
    registerSyncPeerRoutes(ctx as never, manager, transport as never, coordinator as never)

    const response = await callRoute(routes[0], 'POST', `/api/dshb/sync/peers/${peer.id}/run`)

    expect(coordinator.run).toHaveBeenCalledWith(peer.id)
    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ ok: false, code: 'sessions-unavailable' })
  })
})
