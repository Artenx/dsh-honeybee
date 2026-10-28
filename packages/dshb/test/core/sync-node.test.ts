import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeRegistry, type NodeSecrets } from '../../src/core/node-registry.js'
import { WorkspaceBindingsStore } from '../../src/core/workspace-bindings.js'
import { registerWorkspaceRoutes } from '../../src/core/workspaces.js'
import { SyncNodeService, type SyncNodeManifest } from '../../src/core/sync/node-sync.js'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { syncRecordKey, type SyncRecordMetadata } from '../../src/core/sync/model.js'
import { SyncStateStore } from '../../src/core/sync/stores.js'

const homes: string[] = []
const previousDshHome = process.env.DSH_HOME

class MemoryCredentials {
  private readonly records = new Map<string, { kind: 'grant'; payload: NodeSecrets }>()
  failModifyAt: number | undefined
  private modifyCount = 0

  async readRecord(key: CredentialKey): Promise<unknown> {
    return this.records.get(key)
  }

  async modifyRecord(key: CredentialKey, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
    this.modifyCount += 1
    if (this.modifyCount === this.failModifyAt) throw new Error('simulated credential write failure')
    const next = await mutate(this.records.get(key)) as { kind: 'grant'; payload: NodeSecrets }
    this.records.set(key, next)
    return next
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
  }
}

function createNodeService(activeWorkspaces: Array<{ path: string; title: string }> = []) {
  const home = mkdtempSync(join(tmpdir(), 'dshb-sync-node-test-'))
  homes.push(home)
  process.env.DSH_HOME = home
  mkdirSync(join(home, 'dshb'), { recursive: true, mode: 0o700 })
  const credentials = new MemoryCredentials()
  const registry = new NodeRegistry({ credentials } as never)
  const bindings = new WorkspaceBindingsStore()
  const state = new SyncStateStore(home)
  const service = new SyncNodeService(registry, bindings, state, () => ({ list: () => activeWorkspaces }))
  return { home, credentials, registry, bindings, state, service }
}

afterEach(() => {
  process.env.DSH_HOME = previousDshHome
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function sourceManifest(name = 'Shared node'): Promise<{ env: ReturnType<typeof createNodeService>; manifest: SyncNodeManifest }> {
  const env = createNodeService()
  await env.registry.create({
    name: 'Local Docker',
    type: 'local-docker',
    docker: { mode: 'existing', containerId: 'local-container' },
  })
  await env.registry.create({
    name,
    type: 'remote-ssh',
    ssh: { host: 'build.example.com', port: 22, username: 'sync', auth: { kind: 'password' } },
    secrets: { password: 'node-password' },
  })
  const manifest = await env.service.exportManifest()
  return { env, manifest }
}

function duplicateAsSecondOrigin(entry: SyncNodeManifest['records'][number]): SyncNodeManifest['records'][number] {
  const metadata: SyncRecordMetadata = {
    ...entry.metadata,
    originInstanceId: 'i-22222222222222222222222222222222',
    originEntityId: 'n222222222222',
    localEntityId: 'n222222222222',
    revision: { physicalTimeMs: entry.metadata.revision.physicalTimeMs + 1, logicalCounter: 0, writerInstanceId: 'i-22222222222222222222222222222222' },
  }
  return { ...entry, metadata }
}

async function requestWorkspaceBind(registry: NodeRegistry, bindings: WorkspaceBindingsStore, service: SyncNodeService, nodeId: string) {
  const routes: Array<{ handler: (req: never, res: never) => unknown }> = []
  const ctx = {
    webServer: { register(route: { handler: (req: never, res: never) => unknown }) { routes.push(route); return () => {} } },
    effect(register: () => () => void) { register() },
    get() { return undefined },
  }
  registerWorkspaceRoutes(ctx as never, registry, bindings, service)
  const request = new (class extends EventEmitter {
    readonly headers = { 'content-type': 'application/json' }
    readonly method = 'POST'
    readonly url = '/api/dshb/workspaces/bind'
  })()
  const response = {
    status: 0,
    body: '',
    writeHead(status: number) { this.status = status },
    end(value?: string) { this.body = value ?? '' },
  }
  const result = Promise.resolve(routes[0].handler(request as never, response as never))
  request.emit('data', Buffer.from(JSON.stringify({ nodeId, remotePath: '/workspace' })))
  request.emit('end')
  await result
  return { status: response.status, body: JSON.parse(response.body || '{}') as Record<string, unknown> }
}

describe('node sync manifest', () => {
  it('exports remote nodes with secrets and stable origin while excluding local node types', async () => {
    const { env, manifest } = await sourceManifest()
    const second = await env.service.exportManifest()

    expect(manifest.records).toHaveLength(1)
    expect(manifest.records[0].profile?.type).toBe('remote-ssh')
    expect(manifest.records[0].secrets?.password).toBe('node-password')
    expect(second.records[0].metadata.revision).toEqual(manifest.records[0].metadata.revision)
    expect(manifest.records[0].metadata.originInstanceId).toBe(manifest.instanceId)
    expect(env.registry.list().some((node) => node.type === 'local-host')).toBe(true)
  })

  it('imports remote Docker profiles while excluding local Docker profiles', async () => {
    const source = createNodeService()
    await source.registry.create({
      name: 'Remote container',
      type: 'remote-docker',
      ssh: { host: 'docker.example.com', port: 22, username: 'sync', auth: { kind: 'agent' } },
      docker: { mode: 'existing', containerId: 'remote-container-id' },
    })
    const manifest = await source.service.exportManifest()
    const target = createNodeService()
    const result = await target.service.applyManifest(manifest.records, 'Docker peer')
    const imported = target.registry.list().find((node) => node.name === 'Remote container')

    expect(result.created).toBe(1)
    expect(imported?.type).toBe('remote-docker')
    expect(imported?.docker?.containerId).toBe('remote-container-id')
    expect(target.registry.list().some((node) => node.type === 'local-docker')).toBe(false)
  })

  it('does not export host-local SSH key paths as portable node credentials', async () => {
    const env = createNodeService()
    await env.registry.create({
      name: 'Key-path node',
      type: 'remote-ssh',
      ssh: {
        host: 'key.example.com',
        port: 22,
        username: 'sync',
        auth: { kind: 'key', keyPath: '/home/source/.ssh/id_ed25519' },
      },
    })
    const manifest = await env.service.exportManifest()
    const entry = manifest.records[0]

    expect(entry.profile?.ssh.auth).toEqual({ kind: 'key' })
    expect(entry.metadata.credentialsRequired).toBe(true)
    expect(JSON.stringify(entry)).not.toContain('/home/source')
  })

  it('imports idempotently, preserves credentials and isolates same-name origins', async () => {
    const { manifest } = await sourceManifest()
    const target = createNodeService()
    const first = await target.service.applyManifest(manifest.records, 'Peer A')
    const imported = target.registry.list().find((node) => node.name === 'Shared node')!
    const duplicate = duplicateAsSecondOrigin(manifest.records[0])
    const second = await target.service.applyManifest([duplicate], 'Peer B')

    expect(first.created).toBe(1)
    expect(second.created).toBe(1)
    expect(target.registry.list().filter((node) => node.name === 'Shared node')).toHaveLength(2)
    expect((await target.registry.getSecrets(imported.id))?.password).toBe('node-password')
    expect(target.service.view(imported.id)).toMatchObject({ importedVia: 'peer', sourceName: 'Peer A' })
    expect((await target.service.applyManifest(manifest.records, 'Peer A')).skipped).toBe(1)
  })

  it('preflights equal-revision conflicts before applying earlier manifest records', async () => {
    const source = await sourceManifest()
    const target = createNodeService()
    const original = source.manifest.records[0]!
    await target.service.applyManifest([original], 'Peer A')

    const sourceNode = source.env.registry.list().find((node) => node.name === 'Shared node')!
    await source.env.registry.update(sourceNode.id, { name: 'Changed shared node' })
    const changed = (await source.env.service.exportManifest()).records[0]!
    const conflict = {
      ...changed,
      metadata: { ...changed.metadata, revision: original.metadata.revision },
    }
    const additionalOrigin = duplicateAsSecondOrigin(original)

    await expect(target.service.applyManifest([additionalOrigin, conflict], 'Peer B'))
      .rejects.toThrow(/same revision/)
    expect(target.registry.list().filter((node) => node.name === 'Shared node')).toHaveLength(1)
  })

  it('persists provenance after each node so a later record failure preserves earlier identity', async () => {
    const source = createNodeService()
    await source.registry.create({
      name: 'First imported node',
      type: 'remote-ssh',
      ssh: { host: 'first.example.com', port: 22, username: 'sync', auth: { kind: 'password' } },
      secrets: { password: 'first-secret' },
    })
    await source.registry.create({
      name: 'Second imported node',
      type: 'remote-ssh',
      ssh: { host: 'second.example.com', port: 22, username: 'sync', auth: { kind: 'password' } },
      secrets: { password: 'second-secret' },
    })
    const manifest = await source.service.exportManifest()
    const target = createNodeService()
    target.credentials.failModifyAt = 2

    await expect(target.service.applyManifest(manifest.records, 'Peer A')).rejects.toThrow('simulated credential write failure')

    const firstOrigin = manifest.records[0]!.metadata
    expect(target.registry.list().some((node) => node.name === 'First imported node')).toBe(true)
    expect(target.state.read().records[syncRecordKey('node', firstOrigin)]?.originInstanceId).toBe(firstOrigin.originInstanceId)
  })

  it('updates a mapped node in place when the source revision advances', async () => {
    const source = await sourceManifest()
    const target = createNodeService()
    await target.service.applyManifest(source.manifest.records, 'Peer A')
    const imported = target.registry.list().find((node) => node.name === 'Shared node')!
    const sourceNode = source.env.registry.list().find((node) => node.name === 'Shared node')!
    process.env.DSH_HOME = source.env.home
    await source.env.registry.update(sourceNode.id, { name: 'Renamed node' })
    const updatedManifest = await source.env.service.exportManifest()

    process.env.DSH_HOME = target.home
    const result = await target.service.applyManifest(updatedManifest.records, 'Peer A')
    const staleResult = await target.service.applyManifest(source.manifest.records, 'Peer A')

    expect(result.updated).toBe(1)
    expect(staleResult.skipped).toBe(1)
    expect(target.registry.get(imported.id)?.name).toBe('Renamed node')
    expect(target.registry.list().filter((node) => node.name === 'Renamed node')).toHaveLength(1)
  })

  it('applies a tombstone as pending removal until the last active workspace is gone', async () => {
    const source = await sourceManifest()
    const activeWorkspaces: Array<{ path: string; title: string }> = []
    const target = createNodeService(activeWorkspaces)
    await target.service.applyManifest(source.manifest.records, 'Peer A')
    const imported = target.registry.list().find((node) => node.name === 'Shared node')!
    const binding = { mirrorPath: '/mirror/shared', nodeId: imported.id, remotePath: '/workspace', workspaceId: 'ws-1' }
    target.bindings.add(binding)
    activeWorkspaces.push({ path: binding.mirrorPath, title: 'Project' })

    process.env.DSH_HOME = source.env.home
    await source.env.service.removeLocalNode(source.env.registry.list().find((node) => node.name === 'Shared node')!.id, async () => {
      await source.env.registry.remove(source.env.registry.list().find((node) => node.name === 'Shared node')!.id)
    })
    const tombstones = (await source.env.service.exportManifest()).records
    process.env.DSH_HOME = target.home
    const applied = await target.service.applyManifest(tombstones, 'Peer A')

    expect(applied.pendingRemoval).toBe(1)
    expect(target.registry.get(imported.id)).toBeDefined()
    expect(target.service.isPendingRemoval(imported.id)).toBe(true)
    const bindResponse = await requestWorkspaceBind(target.registry, target.bindings, target.service, imported.id)
    expect(bindResponse.status).toBe(409)
    expect(bindResponse.body.code).toBe('node/pending-removal')
    await target.service.reconcilePendingRemovals()
    expect(target.registry.get(imported.id)).toBeDefined()

    activeWorkspaces.length = 0
    await target.service.reconcilePendingRemovals()
    expect(target.registry.get(imported.id)).toBeUndefined()
    expect(target.bindings.list()).toEqual([])
    expect(target.service.view(imported.id)?.pendingRemoval).toBe(false)
  })

  it('records local remote-node deletion as a propagatable tombstone', async () => {
    const env = createNodeService()
    const node = await env.registry.create({
      name: 'Remote',
      type: 'remote-ssh',
      ssh: { host: 'remote.example', port: 22, username: 'sync', auth: { kind: 'agent' } },
    })
    await env.service.removeLocalNode(node.id, () => env.registry.remove(node.id))
    const manifest = await env.service.exportManifest()

    expect(env.registry.get(node.id)).toBeUndefined()
    expect(manifest.records).toHaveLength(1)
    expect(manifest.records[0].metadata).toMatchObject({ originEntityId: node.id, deleted: true, pendingRemoval: false })
    expect(manifest.records[0].profile).toBeUndefined()
  })
})
