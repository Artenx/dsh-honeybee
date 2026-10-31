import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { NodeRegistry, type NodeSecrets } from '../../src/core/node-registry.js'
import { WorkspaceBindingsStore } from '../../src/core/workspace-bindings.js'
import { SyncCoordinator } from '../../src/core/sync/coordinator.js'
import { SyncSessionJournalStore } from '../../src/core/sync/session-journal.js'
import { SyncNodeInUseError, SyncNodeService } from '../../src/core/sync/node-sync.js'
import { SyncSessionService, type WorkspaceRegistryLike } from '../../src/core/sync/session-sync.js'
import { SyncOfflineArchiveService } from '../../src/core/sync/offline-archive.js'
import { SyncStateStore } from '../../src/core/sync/stores.js'
import type { SyncDirection } from '../../src/core/sync/model.js'
import type { SessionInstructionSnapshot } from '../../src/core/workspace-instructions.js'

const homes: string[] = []
const originalDshHome = process.env.DSH_HOME

class MemoryCredentials {
  private readonly records = new Map<string, { kind: 'grant'; payload: NodeSecrets }>()

  async readRecord(key: string): Promise<unknown> { return this.records.get(key) }
  async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
    const value = await mutate(this.records.get(key)) as { kind: 'grant'; payload: NodeSecrets }
    this.records.set(key, value)
    return value
  }
  async deleteRecord(key: string): Promise<void> { this.records.delete(key) }
}

class MemoryPersistence {
  private readonly sessions = new Map<string, { header: SessionHeader; inheritedEventCount: number; events: SessionEvent[]; revision: number }>()
  private readonly owned = new Set<string>()

  add(session: Session): void {
    this.sessions.set(String(session.id), {
      header: session.header,
      inheritedEventCount: Number(session.inheritedEventCount),
      events: [...session.snapshotEvents()],
      revision: 1,
    })
  }

  async flush(): Promise<void> {}
  async list() { return [...this.sessions.values()].map((value) => this.snapshot(value)) }
  async stat(id: SessionId) { const value = this.sessions.get(String(id)); return value ? this.snapshot(value) : undefined }

  async create(header: SessionHeader, options?: { inheritedEventCount?: number }) {
    if (this.sessions.has(String(header.id))) throw new Error('session already exists')
    this.sessions.set(String(header.id), { header, inheritedEventCount: options?.inheritedEventCount ?? 0, events: [], revision: 0 })
    return this.open(header.id, 'write')
  }

  async open(id: SessionId, access: 'read' | 'write') {
    const thisPersistence = this
    const key = String(id)
    const value = this.sessions.get(key)
    if (!value) throw new Error('session not found')
    if (access === 'write' && this.owned.has(key)) throw new Error('session already owned')
    if (access === 'write') this.owned.add(key)
    let closed = false
    return {
      id,
      header: value.header,
      inheritedEventCount: value.inheritedEventCount,
      async read(offset = 0, length = Number.MAX_SAFE_INTEGER) { return { events: value.events.slice(offset, offset + length) } },
      async append(events: readonly SessionEvent[]) {
        if (access !== 'write') throw new Error('read handle cannot append')
        value.events.push(...events)
        value.revision += 1
      },
      async flush() {},
      async close() {
        if (closed) return
        closed = true
        if (access === 'write') thisPersistence.owned.delete(key)
      },
    }
  }

  private snapshot(value: { header: SessionHeader; events: SessionEvent[]; revision: number }) {
    return { header: value.header, revision: `r${value.revision}`, eventCount: value.events.length, formatStatus: 'current' as const }
  }
}

class MemoryWorkspace {
  readonly sessionIds: SessionId[] = []
  constructor(readonly id: string, readonly path: string, public title: string) {}
  async setTitle(title: string): Promise<void> { this.title = title }
  async attachSession(id: SessionId): Promise<void> {
    if (!this.sessionIds.some((item) => String(item) === String(id))) this.sessionIds.unshift(id)
  }
  async insertSessionBefore(id: SessionId, before?: SessionId): Promise<void> {
    const rest = this.sessionIds.filter((item) => String(item) !== String(id))
    const index = before === undefined ? -1 : rest.findIndex((item) => String(item) === String(before))
    if (index < 0) rest.push(id)
    else rest.splice(index, 0, id)
    this.sessionIds.splice(0, this.sessionIds.length, ...rest)
  }
}

class MemoryWorkspaces implements WorkspaceRegistryLike {
  private readonly values = new Map<string, MemoryWorkspace>()
  private readonly archived = new Set<string>()
  private readonly pinned = new Set<string>()
  private sequence = 1
  createGate?: { started(): void; wait: Promise<void> }

  get archivedSessionIds(): readonly SessionId[] { return [...this.archived].map((id) => SessionId(id)) }
  get pinnedSessionIds(): readonly SessionId[] { return [...this.pinned].map((id) => SessionId(id)) }
  list(): MemoryWorkspace[] { return [...this.values.values()] }
  get(id: string): MemoryWorkspace | undefined { return this.values.get(id) }
  add(id: string, path: string, title: string): MemoryWorkspace {
    const workspace = new MemoryWorkspace(id, path, title)
    this.values.set(id, workspace)
    return workspace
  }
  async create(path: string, title = 'Workspace'): Promise<MemoryWorkspace> {
    const existing = this.list().find((workspace) => workspace.path === path)
    if (existing) return existing
    const workspace = new MemoryWorkspace(`workspace-${this.sequence++}`, path, title)
    this.values.set(workspace.id, workspace)
    if (this.createGate) {
      this.createGate.started()
      await this.createGate.wait
    }
    return workspace
  }
  async archiveSession(id: SessionId): Promise<void> { this.archived.add(String(id)) }
  async unarchiveSession(id: SessionId): Promise<void> { this.archived.delete(String(id)) }
  async pinSession(id: SessionId): Promise<void> { this.pinned.add(String(id)) }
  async unpinSession(id: SessionId): Promise<void> { this.pinned.delete(String(id)) }
}

class MemoryInstructions {
  private readonly values = new Map<string, SessionInstructionSnapshot>()
  get(id: string): SessionInstructionSnapshot | undefined { return this.values.get(id) }
  restore(snapshot: SessionInstructionSnapshot): SessionInstructionSnapshot {
    const current = this.values.get(snapshot.sessionId)
    if (current && JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error('instruction snapshot conflict')
    this.values.set(snapshot.sessionId, snapshot)
    return snapshot
  }
}

interface TestInstance {
  name: string
  home: string
  state: SyncStateStore
  registry: NodeRegistry
  bindings: WorkspaceBindingsStore
  workspaces: MemoryWorkspaces
  persistence: MemoryPersistence
  nodes: SyncNodeService
  sessions: SyncSessionService
  offline: SyncOfflineArchiveService
}

async function withHome<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return await operation() } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

async function createInstance(name: string): Promise<TestInstance> {
  const home = mkdtempSync(join(tmpdir(), `dshb-sync-e2e-${name}-`))
  homes.push(home)
  const state = new SyncStateStore(home)
  const registry = new NodeRegistry({ credentials: new MemoryCredentials() } as never)
  const bindings = new WorkspaceBindingsStore()
  const workspaces = new MemoryWorkspaces()
  const persistence = new MemoryPersistence()
  const nodes = new SyncNodeService(registry, bindings, state, () => workspaces)
  const sessions = new SyncSessionService(
    state,
    nodes,
    registry,
    bindings,
    () => workspaces,
    () => persistence as never,
    () => undefined,
    () => undefined,
    new MemoryInstructions() as never,
    new SyncSessionJournalStore(home),
    () => 1_800_000_000_000,
    home,
  )
  const offline = new SyncOfflineArchiveService(nodes, sessions, home, undefined, state)
  await withHome(home, async () => { await registry.list() })
  return { name, home, state, registry, bindings, workspaces, persistence, nodes, sessions, offline }
}

function coordinator(local: TestInstance, remote: TestInstance, direction: SyncDirection) {
  const peerId = `p-${createHash('sha256').update(`${local.name}-${remote.name}`).digest('hex').slice(0, 24)}`
  const peer = {
    id: peerId,
    name: remote.name,
    host: 'in-memory-peer',
    port: 22,
    username: 'test',
    authKind: 'key' as const,
    direction,
    schedule: 'manual' as const,
    syncSessions: true,
    enabled: true,
  }
  const peers = { get: async () => peer, updateProgress: vi.fn() }
  const transport = {
    async fetchNodeManifest() { return withHome(remote.home, () => remote.nodes.exportManifest()) },
    async applyNodeManifest(_id: string, records: Parameters<SyncNodeService['applyManifest']>[0], sourceName: string) {
      return withHome(remote.home, () => remote.nodes.applyManifest(records, sourceName, 'peer'))
    },
    async fetchSessionBundle() { return withHome(remote.home, () => remote.sessions.exportBundle()) },
    async applySessionBundle(_id: string, bundle: Parameters<SyncSessionService['applyBundle']>[0], sourceName: string) {
      return withHome(remote.home, () => remote.sessions.applyBundle(bundle, sourceName, peerId))
    },
  }
  const run = new SyncCoordinator(peers as never, local.state, local.nodes, transport as never, () => 1_800_000_000_000, local.sessions)
  return { peerId, async runOnce() { return withHome(local.home, () => run.run(peerId)) } }
}

function addSession(instance: TestInstance, sessionIdText: string, workspaceId: string, path: string): void {
  const sessionId = SessionId(sessionIdText)
  const header: SessionHeader = {
    id: sessionId,
    version: SESSION_FORMAT_VERSION,
    createdAt: 1_800_000_000_000,
    cwd: path,
    isSeeded: false,
  }
  const session = Session.create(sessionId, undefined, header)
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  instance.persistence.add(session)
  instance.workspaces.get(workspaceId)!.sessionIds.push(sessionId)
}

afterEach(() => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('cross-instance sync integration', () => {
  it('forwards a node and session A to B to C, then deduplicates the return loop', async () => {
    const a = await createInstance('a')
    const b = await createInstance('b')
    const c = await createInstance('c')
    let sourceNodeId = ''
    let sourceWorkspace: MemoryWorkspace | undefined
    await withHome(a.home, async () => {
      const sourceNode = await a.registry.create({
        name: 'Build host A',
        type: 'remote-ssh',
        ssh: { host: 'a.example.test', port: 22, username: 'build', auth: { kind: 'agent' } },
      })
      sourceNodeId = sourceNode.id
      sourceWorkspace = a.workspaces.add('workspace-a', `${a.home}/mirror/project`, 'Project A')
      a.bindings.add({ mirrorPath: sourceWorkspace.path, nodeId: sourceNodeId, remotePath: '/srv/project', workspaceId: sourceWorkspace.id })
      addSession(a, 'session-a', sourceWorkspace.id, sourceWorkspace.path)
    })

    const bPullsA = coordinator(b, a, 'pull')
    const first = await bPullsA.runOnce()
    expect(first).toMatchObject({ imported: 1, importedSessions: 1, exported: 0, exportedSessions: 0 })
    expect(b.registry.list().filter((node) => node.type === 'remote-ssh')).toHaveLength(1)
    expect(b.persistence.sessions.size).toBe(1)

    const cPullsB = coordinator(c, b, 'pull')
    const second = await cPullsB.runOnce()
    expect(second).toMatchObject({ imported: 1, importedSessions: 1, exported: 0, exportedSessions: 0 })
    expect(c.registry.list().filter((node) => node.type === 'remote-ssh')).toHaveLength(1)
    expect(c.persistence.sessions.size).toBe(1)

    const originalNodeRecord = Object.values(a.state.read().records).find((record) =>
      record.kind === 'node' && record.originEntityId === sourceNodeId,
    )
    const cNodeRecord = Object.values(c.state.read().records).find((record) =>
      record.kind === 'node' && record.originEntityId === sourceNodeId,
    )
    expect(cNodeRecord?.originInstanceId).toBe(a.state.instanceId())
    expect(cNodeRecord?.contentDigest).toBe(originalNodeRecord?.contentDigest)
    expect(c.workspaces.list()[0]?.sessionIds).toHaveLength(1)

    const aSyncsC = coordinator(a, c, 'bidirectional')
    const loop = await aSyncsC.runOnce()
    expect(loop.imported).toBe(0)
    expect(loop.importedSessions).toBe(0)
    expect(loop.exportedSessions).toBe(0)
    expect(loop.skippedSessions).toBe(1)
    expect(a.registry.list().filter((node) => node.type === 'remote-ssh')).toHaveLength(1)
    expect(a.persistence.sessions.size).toBe(1)
  })

  it('serializes workspace creation against removal of its mapped node', async () => {
    const source = await createInstance('workspace-source')
    const target = await createInstance('workspace-target')
    let sourceNodeId = ''
    await withHome(source.home, async () => {
      const node = await source.registry.create({
        name: 'Workspace source node',
        type: 'remote-ssh',
        ssh: { host: 'workspace-source.example.test', port: 22, username: 'build', auth: { kind: 'agent' } },
      })
      sourceNodeId = node.id
      const workspace = source.workspaces.add('workspace-source', `${source.home}/mirror/project`, 'Source project')
      source.bindings.add({ mirrorPath: workspace.path, nodeId: sourceNodeId, remotePath: '/srv/project', workspaceId: workspace.id })
      addSession(source, 'workspace-session', workspace.id, workspace.path)
    })
    const sourceManifest = await withHome(source.home, () => source.nodes.exportManifest())
    const sourceBundle = await withHome(source.home, () => source.sessions.exportBundle())
    let targetNodeId = ''
    await withHome(target.home, async () => {
      await target.nodes.applyManifest(sourceManifest.records, 'source peer', 'peer')
      targetNodeId = target.nodes.localNodeIdForOrigin({
        originInstanceId: sourceManifest.instanceId,
        originEntityId: sourceNodeId,
      })!
    })

    let markCreateStarted!: () => void
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve })
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    target.workspaces.createGate = { started: markCreateStarted, wait: createGate }
    const importSession = withHome(target.home, () => target.sessions.applyBundle(sourceBundle, 'source peer', 'p-0123456789abcdef01234567'))
    await createStarted
    const removeNode = withHome(target.home, () => target.nodes.removeLocalNode(targetNodeId, () => target.registry.remove(targetNodeId)))

    releaseCreate()
    await expect(removeNode).rejects.toBeInstanceOf(SyncNodeInUseError)
    const result = await importSession

    expect(result.created).toBe(1)
    expect(target.registry.get(targetNodeId)).toBeDefined()
    expect(target.bindings.list()).toHaveLength(1)
    expect(target.workspaces.list()[0]?.sessionIds).toHaveLength(1)
  })

  it('imports a real encrypted archive twice without duplicating nodes or sessions', async () => {
    const source = await createInstance('offline-source')
    const target = await createInstance('offline-target')
    await withHome(source.home, async () => {
      const node = await source.registry.create({
        name: 'Offline build host',
        type: 'remote-ssh',
        ssh: { host: 'offline.example.test', port: 22, username: 'build', auth: { kind: 'agent' } },
      })
      const workspace = source.workspaces.add('offline-workspace', `${source.home}/mirror/project`, 'Offline project')
      source.bindings.add({ mirrorPath: workspace.path, nodeId: node.id, remotePath: '/srv/offline-project', workspaceId: workspace.id })
      addSession(source, 'offline-session', workspace.id, workspace.path)
    })

    const archive = await withHome(source.home, () => source.offline.exportArchive('a sufficiently long package password', true))
    try {
      const first = await withHome(target.home, () => target.offline.importArchive(
        'a sufficiently long package password',
        createReadStream(archive.path),
      ))
      expect(first.nodes.created).toBe(1)
      expect(first.sessions?.created).toBe(1)
      expect(target.registry.list().filter((node) => node.type === 'remote-ssh')).toHaveLength(1)
      expect(target.persistence.sessions.size).toBe(1)

      const second = await withHome(target.home, () => target.offline.importArchive(
        'a sufficiently long package password',
        createReadStream(archive.path),
      ))
      expect(second.nodes.skipped).toBe(1)
      expect(second.sessions?.skipped).toBe(1)
      expect(target.registry.list().filter((node) => node.type === 'remote-ssh')).toHaveLength(1)
      expect(target.persistence.sessions.size).toBe(1)
    } finally {
      archive.cleanup()
    }
  })
})
