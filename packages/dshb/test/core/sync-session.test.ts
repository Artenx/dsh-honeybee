import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SyncStateStore } from '../../src/core/sync/stores.js'
import {
  makeSyncSessionBundle,
  planSessionTransfers,
  SyncSessionError,
  SyncSessionService,
  validateSyncSessionBundle,
  type WorkspaceRegistryLike,
} from '../../src/core/sync/session-sync.js'
import { SyncSessionJournalStore } from '../../src/core/sync/session-journal.js'
import type { SyncOrigin } from '../../src/core/sync/model.js'
import type { NodeProfile } from '../../src/core/node-registry.js'
import type { WorkspaceBinding } from '../../src/core/workspace-bindings.js'
import type { SessionInstructionSnapshot } from '../../src/core/workspace-instructions.js'

const homes: string[] = []
const spillMetaKey = '@deepseek-ai/dsh-spill'
const nodeOrigin: SyncOrigin = {
  originInstanceId: 'i-11111111111111111111111111111111',
  originEntityId: 'n-source',
}

function digest(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function toolSession(id: string, cwd: string, image: ImageAttachmentRef, spillRef: { locator: string; bytes: number; retrievalHint: string }): Session {
  const sessionId = SessionId(id)
  const header: SessionHeader = {
    id: sessionId,
    version: SESSION_FORMAT_VERSION,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
  }
  const session = Session.create(sessionId, undefined, header)
  const callId = ToolCallId(`call-${id}`)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'web_fetch', arguments: '{}' })
  const message = createToolResultMessage({
    callId,
    isError: false,
    content: [
      { type: 'text', text: `(Omitted 4 bytes. Full formatted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint})` },
      { type: 'image', attachment: image },
    ],
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message,
    meta: {
      [spillMetaKey]: {
        version: 1,
        references: [{
          owner: { sessionId },
          source: { toolName: 'web_fetch', callId, label: 'result' },
          suggestedName: 'web_fetch.txt',
          ref: spillRef,
        }],
      },
    },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

class MemorySessionPersistence {
  readonly sessions = new Map<string, { header: SessionHeader; inheritedEventCount: number; events: SessionEvent[]; revision: number }>()
  readonly owned = new Set<string>()
  flushCalls = 0
  failAppendOnce = false

  add(session: Session): void {
    this.sessions.set(String(session.id), {
      header: session.header,
      inheritedEventCount: Number(session.inheritedEventCount),
      events: [...session.snapshotEvents()],
      revision: 1,
    })
  }

  async flush(): Promise<void> { this.flushCalls += 1 }

  async list() {
    return [...this.sessions.values()].map((value) => this.snapshot(value))
  }

  async stat(id: SessionId) {
    const value = this.sessions.get(String(id))
    return value ? this.snapshot(value) : undefined
  }

  async create(header: SessionHeader, options?: { inheritedEventCount?: number }) {
    if (this.sessions.has(String(header.id))) throw new Error('session already exists')
    this.sessions.set(String(header.id), {
      header,
      inheritedEventCount: options?.inheritedEventCount ?? 0,
      events: [],
      revision: 0,
    })
    return this.open(header.id, 'write')
  }

  async open(id: SessionId, access: 'read' | 'write') {
    const persistence = this
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
      async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
        return { events: value.events.slice(offset, offset + length) }
      },
      async append(events: readonly SessionEvent[]) {
        if (access !== 'write') throw new Error('read handle cannot append')
        if (persistence.failAppendOnce) {
          persistence.failAppendOnce = false
          value.events.push(...events.slice(0, Math.min(2, events.length)))
          value.revision += 1
          throw new Error('simulated interrupted append')
        }
        value.events.push(...events)
        value.revision += 1
      },
      async flush() {},
      async close() {
        if (closed) return
        closed = true
        if (access === 'write') persistence.owned.delete(key)
      },
    }
  }

  mutateEvent(sessionId: string, mutate: (event: SessionEvent) => SessionEvent): void {
    const value = this.sessions.get(sessionId)
    if (!value) throw new Error('session is missing')
    value.events = value.events.map(mutate)
    value.revision += 1
  }

  private snapshot(value: { header: SessionHeader; events: SessionEvent[]; revision: number }) {
    return {
      header: value.header,
      revision: `r${value.revision}`,
      eventCount: value.events.length,
      formatStatus: 'current' as const,
    }
  }
}

function findImageBlock(value: unknown): { type: 'image'; attachment: ImageAttachmentRef } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageBlock(item)
      if (found) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.type === 'image' && record.attachment && typeof record.attachment === 'object') {
    return record as unknown as { type: 'image'; attachment: ImageAttachmentRef }
  }
  for (const child of Object.values(record)) {
    const found = findImageBlock(child)
    if (found) return found
  }
  return undefined
}

class MemoryWorkspaceRegistry implements WorkspaceRegistryLike {
  private readonly workspaces = new Map<string, MemoryWorkspace>()
  private readonly archived = new Set<string>()
  private readonly pinned = new Set<string>()
  private nextId = 1
  failNextAttachAfterOnce = false
  failNextInsertBeforeOnce = false

  get archivedSessionIds(): readonly SessionId[] { return [...this.archived].map((id) => SessionId(id)) }
  get pinnedSessionIds(): readonly SessionId[] { return [...this.pinned].map((id) => SessionId(id)) }
  list(): MemoryWorkspace[] { return [...this.workspaces.values()] }
  get(id: string): MemoryWorkspace | undefined { return this.workspaces.get(id) }
  add(id: string, path: string, title: string): MemoryWorkspace {
    const workspace = new MemoryWorkspace(id, path, title)
    this.workspaces.set(id, workspace)
    return workspace
  }
  async create(path: string, title = 'Workspace'): Promise<MemoryWorkspace> {
    const existing = this.list().find((workspace) => workspace.path === path)
    if (existing) return existing
    const workspace = new MemoryWorkspace(`workspace-${this.nextId++}`, path, title)
    workspace.failAttachAfterOnce = this.failNextAttachAfterOnce
    this.failNextAttachAfterOnce = false
    workspace.failInsertBeforeOnce = this.failNextInsertBeforeOnce
    this.failNextInsertBeforeOnce = false
    this.workspaces.set(workspace.id, workspace)
    return workspace
  }
  async archiveSession(id: SessionId): Promise<void> { this.archived.add(String(id)) }
  async unarchiveSession(id: SessionId): Promise<void> { this.archived.delete(String(id)) }
  async pinSession(id: SessionId): Promise<void> { this.pinned.add(String(id)) }
  async unpinSession(id: SessionId): Promise<void> { this.pinned.delete(String(id)) }
}

class MemoryWorkspace {
  readonly sessionIds: SessionId[] = []
  failAttachAfterOnce = false
  failInsertBeforeOnce = false

  constructor(readonly id: string, readonly path: string, public title: string) {}

  async setTitle(title: string): Promise<void> { this.title = title }
  async attachSession(id: SessionId): Promise<void> {
    if (!this.sessionIds.some((sessionId) => String(sessionId) === String(id))) this.sessionIds.unshift(id)
    if (this.failAttachAfterOnce) {
      this.failAttachAfterOnce = false
      throw new Error('simulated interruption after workspace membership commit')
    }
  }
  async insertSessionBefore(id: SessionId, before?: SessionId): Promise<void> {
    if (this.failInsertBeforeOnce) {
      this.failInsertBeforeOnce = false
      throw new Error('simulated interruption during workspace ordering')
    }
    const rest = this.sessionIds.filter((sessionId) => String(sessionId) !== String(id))
    const index = before === undefined ? -1 : rest.findIndex((sessionId) => String(sessionId) === String(before))
    if (index < 0) rest.push(id)
    else rest.splice(index, 0, id)
    this.sessionIds.splice(0, this.sessionIds.length, ...rest)
  }
}

class MemoryBindings {
  readonly values: WorkspaceBinding[] = []
  constructor(private readonly home: string) {}
  list(): WorkspaceBinding[] { return this.values.map((binding) => ({ ...binding })) }
  add(binding: WorkspaceBinding): void {
    const index = this.values.findIndex((entry) => entry.mirrorPath === binding.mirrorPath)
    if (index >= 0) this.values.splice(index, 1)
    this.values.push({ ...binding })
  }
  remove(path: string): void {
    const index = this.values.findIndex((entry) => entry.mirrorPath === path)
    if (index >= 0) this.values.splice(index, 1)
  }
  mirrorRoot(nodeId: string, slug: string): string { return join(this.home, 'mirrors', nodeId, slug) }
}

class MemoryAttachments {
  readonly objects = new Map<string, Uint8Array>()
  saves = 0
  addImage(ref: ImageAttachmentRef, data: Uint8Array): void { this.objects.set(ref.attachmentId, data) }
  async readImage(ref: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }> {
    const data = this.objects.get(ref.attachmentId)
    if (!data) throw new Error('image is missing')
    return { ref, data }
  }
  async saveImage(input: { data: Uint8Array; mediaType: ImageAttachmentRef['mediaType']; name?: string }): Promise<ImageAttachmentRef> {
    const ref: ImageAttachmentRef = {
      attachmentId: `image-${digest(input.data)}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...(input.name === undefined ? {} : { name: input.name }),
    }
    this.objects.set(ref.attachmentId, input.data)
    this.saves += 1
    return ref
  }
  async *readFileStream(ref: FileAttachmentRef): AsyncIterable<Uint8Array> {
    const data = this.objects.get(ref.attachmentId)
    if (!data) throw new Error('file is missing')
    yield data
  }
  async saveFileStream(input: { data: AsyncIterable<Uint8Array>; name?: string }): Promise<FileAttachmentRef> {
    const chunks: Uint8Array[] = []
    for await (const chunk of input.data) chunks.push(chunk)
    const data = Buffer.concat(chunks)
    const ref: FileAttachmentRef = {
      attachmentId: `file-${digest(data)}` as FileAttachmentRef['attachmentId'],
      name: input.name ?? 'file.bin',
      bytes: data.byteLength,
    }
    this.objects.set(ref.attachmentId, data)
    this.saves += 1
    return ref
  }
}

class MemorySpills {
  readonly objects = new Map<string, { owner: string; data: Buffer; ref: { locator: string; bytes: number; retrievalHint: string } }>()
  readonly transfers = new Map<string, { digest: string; ref: { locator: string; bytes: number; retrievalHint: string } }>()
  saves = 0
  add(owner: string, ref: { locator: string; bytes: number; retrievalHint: string }, text: string): void {
    this.objects.set(`${owner}\0${ref.locator}`, { owner, data: Buffer.from(text), ref })
  }
  async *readTextStream(input: { owner: { sessionId: string }; ref: { locator: string; bytes?: number } }): AsyncIterable<Uint8Array> {
    const entry = this.objects.get(`${input.owner.sessionId}\0${input.ref.locator}`)
    if (!entry || (input.ref.bytes !== undefined && entry.ref.bytes !== input.ref.bytes)) throw new Error('spill owner/reference mismatch')
    yield entry.data
  }
  async saveTextStream(input: {
    owner: { sessionId: SessionId }
    source: { toolName: string; callId: string; label: string }
    suggestedName: string
    transferId: string
    bytes: number
    digest: string
    content: AsyncIterable<Uint8Array>
  }): Promise<{ locator: string; bytes: number; retrievalHint: string }> {
    const chunks: Uint8Array[] = []
    for await (const chunk of input.content) chunks.push(chunk)
    const data = Buffer.concat(chunks)
    if (data.byteLength !== input.bytes || digest(data) !== input.digest) throw new Error('spill data checksum mismatch')
    const key = `${input.owner.sessionId}\0${input.transferId}`
    const previous = this.transfers.get(key)
    if (previous) {
      if (previous.digest !== input.digest) throw new Error('spill transfer conflict')
      return previous.ref
    }
    const ref = {
      locator: `/spill/${input.owner.sessionId}/${createHash('sha256').update(input.transferId).digest('hex')}`,
      bytes: data.byteLength,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
    this.transfers.set(key, { digest: input.digest, ref })
    this.objects.set(`${input.owner.sessionId}\0${ref.locator}`, { owner: String(input.owner.sessionId), data, ref })
    this.saves += 1
    return ref
  }
}

class MemoryInstructions {
  readonly values = new Map<string, SessionInstructionSnapshot>()
  get(id: string): SessionInstructionSnapshot | undefined { return this.values.get(id) }
  restore(snapshot: SessionInstructionSnapshot): SessionInstructionSnapshot {
    const current = this.values.get(snapshot.sessionId)
    if (current && JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error('instruction snapshot mismatch')
    this.values.set(snapshot.sessionId, snapshot)
    return snapshot
  }
}

interface TestEnvironment {
  home: string
  state: SyncStateStore
  persistence: MemorySessionPersistence
  workspaces: MemoryWorkspaceRegistry
  bindings: MemoryBindings
  attachments: MemoryAttachments
  spills: MemorySpills
  instructions: MemoryInstructions
  journal: SyncSessionJournalStore
  service: SyncSessionService
}

interface EnvironmentOptions {
  mapNode?: boolean
  omitPinning?: boolean
}

function createEnvironment(kind: 'source' | 'target', options: EnvironmentOptions = {}): TestEnvironment {
  const home = mkdtempSync(join(tmpdir(), `dshb-sync-session-${kind}-`))
  homes.push(home)
  const state = new SyncStateStore(home)
  const persistence = new MemorySessionPersistence()
  const workspaces = new MemoryWorkspaceRegistry()
  const bindings = new MemoryBindings(home)
  const attachments = new MemoryAttachments()
  const spills = new MemorySpills()
  const instructions = new MemoryInstructions()
  const journal = new SyncSessionJournalStore(home)
  const workspaceRegistry: WorkspaceRegistryLike = options.omitPinning
    ? {
        list: () => workspaces.list(),
        get: (id) => workspaces.get(id),
        create: (path, title) => workspaces.create(path, title),
        archiveSession: (id) => workspaces.archiveSession(id),
        unarchiveSession: (id) => workspaces.unarchiveSession(id),
        get archivedSessionIds() { return workspaces.archivedSessionIds },
      }
    : workspaces
  const nodeId = kind === 'source' ? 'node-source' : 'node-target'
  const node = { id: nodeId, name: nodeId, type: 'remote-ssh', createdAt: '', updatedAt: '' } satisfies NodeProfile
  const registry = { get: (id: string) => id === nodeId ? node : undefined }
  const nodeMapping = options.mapNode ?? true
  const localNodeIdForOrigin = (origin: SyncOrigin): string | undefined =>
    nodeMapping && origin.originInstanceId === nodeOrigin.originInstanceId && origin.originEntityId === nodeOrigin.originEntityId
      ? nodeId
      : undefined
  const syncNodes = {
    originForLocalNode: (id: string) => id === nodeId ? nodeOrigin : undefined,
    localNodeIdForOrigin,
    isPendingRemoval: () => false,
    withAvailableRemoteNode: async (origin: SyncOrigin, operation: (id: string) => Promise<unknown>) => {
      const id = localNodeIdForOrigin(origin)
      const mappedNode = id ? registry.get(id) : undefined
      if (!mappedNode || (mappedNode.type !== 'remote-ssh' && mappedNode.type !== 'remote-docker')) return undefined
      return operation(id!)
    },
  }
  const service = new SyncSessionService(
    state,
    syncNodes as never,
    registry as never,
    bindings as never,
    () => workspaceRegistry,
    () => persistence as never,
    () => attachments as never,
    () => spills as never,
    instructions as never,
    journal,
    () => 1_800_000_000_000,
  )
  return { home, state, persistence, workspaces, bindings, attachments, spills, instructions, journal, service }
}

function addSourceSession(env: TestEnvironment, options: { id?: string; title?: string; spillLocator?: string } = {}): SessionId {
  const id = SessionId(options.id ?? 'session-source')
  const workspace = env.workspaces.add('workspace-source', `${env.home}/mirror/source`, options.title ?? 'Source project')
  const remotePath = '/remote/project'
  env.bindings.add({ mirrorPath: workspace.path, nodeId: 'node-source', remotePath, workspaceId: workspace.id })
  const imageData = Buffer.from('normalized image bytes')
  const image: ImageAttachmentRef = {
    attachmentId: 'source-image' as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: imageData.byteLength,
    width: 1,
    height: 1,
    name: 'screen.png',
  }
  env.attachments.addImage(image, imageData)
  const spillText = 'full spilled tool output\n'
  const spillRef = {
    locator: options.spillLocator ?? `/source-spill/${String(id)}/web_fetch.txt`,
    bytes: Buffer.byteLength(spillText, 'utf8'),
    retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
  }
  env.spills.add(String(id), spillRef, spillText)
  const session = toolSession(String(id), workspace.path, image, spillRef)
  env.persistence.add(session)
  workspace.sessionIds.push(id)
  return id
}

function addPlainSession(env: TestEnvironment, workspaceId: string, idText: string): SessionId {
  const workspace = env.workspaces.get(workspaceId)
  if (!workspace) throw new Error('workspace is missing')
  const id = SessionId(idText)
  const header: SessionHeader = {
    id,
    version: SESSION_FORMAT_VERSION,
    createdAt: Date.now(),
    cwd: workspace.path,
    isSeeded: false,
  }
  const session = Session.create(id, undefined, header)
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  env.persistence.add(session)
  workspace.sessionIds.push(id)
  return id
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('session sync', () => {
  it('transfers spill content when the local provider lacks stream methods', async () => {
    const source = createEnvironment('source')
    const target = createEnvironment('target')
    const sourceSpillRoot = mkdtempSync(join(tmpdir(), 'dsh-spill-sync-source-'))
    const targetSpillRoot = mkdtempSync(join(tmpdir(), 'dsh-spill-sync-target-'))
    homes.push(sourceSpillRoot, targetSpillRoot)
    const sessionId = 'session-source'
    const ownerDir = join(sourceSpillRoot, `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`)
    mkdirSync(ownerDir, { recursive: true, mode: 0o700 })
    const spillText = 'full spilled tool output\n'
    const spillLocator = join(ownerDir, '0123456789ab-web_fetch.txt')
    writeFileSync(spillLocator, spillText, { mode: 0o600 })
    Object.assign(source.spills, { root: sourceSpillRoot })
    Object.defineProperty(source.spills, 'readTextStream', { value: undefined, configurable: true })
    Object.assign(target.spills, { root: targetSpillRoot })
    Object.defineProperty(target.spills, 'readTextStream', { value: undefined, configurable: true })
    Object.defineProperty(target.spills, 'saveTextStream', { value: undefined, configurable: true })

    addSourceSession(source, { spillLocator })
    const bundle = await source.service.exportBundle()
    const applied = await target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567')
    const forwarded = await target.service.exportBundle()
    const spill = forwarded.entries[0]?.objects.find((object) => object.kind === 'spill')

    expect(applied.created).toBe(1)
    expect(spill?.kind === 'spill' ? Buffer.from(spill.data, 'base64').toString('utf8') : undefined).toBe(spillText)
    await expect(target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567')).resolves.toMatchObject({ skipped: 1 })
  })

  it('exports and imports sessions when the workspace registry has no pin API', async () => {
    const source = createEnvironment('source', { omitPinning: true })
    addSourceSession(source)
    const bundle = await source.service.exportBundle()
    const target = createEnvironment('target', { omitPinning: true })

    await expect(target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567'))
      .resolves.toMatchObject({ created: 1 })
  })

  it('flushes remote-workspace sessions and includes referenced image and spill objects', async () => {
    const source = createEnvironment('source')
    const sessionId = addSourceSession(source)
    source.workspaces.add('workspace-local', `${source.home}/local`, 'Local')
    const localImage: ImageAttachmentRef = {
      attachmentId: 'unused-local-image' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }
    const local = toolSession('session-local', `${source.home}/local`, localImage, {
      locator: '/local-spill/no-transfer', bytes: 4, retrievalHint: 'Use the local reader.',
    })
    source.persistence.add(local)
    source.workspaces.get('workspace-local')!.sessionIds.push(local.id)

    const bundle = await source.service.exportBundle()

    expect(source.persistence.flushCalls).toBe(1)
    expect(bundle.entries).toHaveLength(1)
    expect(bundle.entries[0]?.sourceLocalSessionId).toBe(sessionId)
    expect(bundle.entries[0]?.workspace?.remotePath).toBe('/remote/project')
    expect(bundle.entries[0]?.objects.map((object) => object.kind).sort()).toEqual(['image', 'spill'])
    expect(bundle.entries[0]?.metadata.workspaceOrigin).toEqual({
      originInstanceId: bundle.instanceId,
      originEntityId: 'workspace-source',
    })
  })

  it('imports owner-scoped objects with rewritten references and replays idempotently', async () => {
    const source = createEnvironment('source')
    addSourceSession(source)
    const bundle = await source.service.exportBundle()
    const target = createEnvironment('target')

    const applied = await target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567')
    const targetSessionId = target.workspaces.list()[0]?.sessionIds[0]
    expect(applied.created).toBe(1)
    expect(targetSessionId).toBeDefined()
    expect(target.attachments.saves).toBe(1)
    expect(target.spills.saves).toBe(1)

    const stored = target.persistence.sessions.get(String(targetSessionId))
    const toolResult = stored?.events.find((event) => event.type === 'tool/result')
    expect(toolResult?.type === 'tool/result' && toolResult.data.meta).toMatchObject({
      [spillMetaKey]: {
        references: [{
          owner: { sessionId: targetSessionId },
          ref: { locator: expect.stringContaining(`/spill/${String(targetSessionId)}/`) },
        }],
      },
    })
    const imageBlock = findImageBlock(toolResult)
    expect(imageBlock?.attachment.attachmentId).not.toBe('source-image')

    await source.workspaces.get('workspace-source')!.setTitle('Renamed project')
    const renamedBundle = await source.service.exportBundle()
    const renamed = await target.service.applyBundle(renamedBundle, 'source peer', 'p-0123456789abcdef01234567')
    expect(renamed.updated).toBe(1)
    expect(target.workspaces.list()[0]?.title).toBe('Renamed project')
    expect(target.workspaces.list()[0]?.sessionIds[0]).toBe(targetSessionId)
    expect(target.service.listArchives()).toHaveLength(0)

    const duplicate = await target.service.applyBundle(renamedBundle, 'source peer', 'p-0123456789abcdef01234567')
    expect(duplicate.skipped).toBe(1)
    expect(target.spills.saves).toBe(1)
    expect(target.attachments.saves).toBe(1)
    const forwarded = await target.service.exportBundle()
    expect(forwarded.entries[0]?.metadata.contentDigest).toBe(renamedBundle.entries[0]?.metadata.contentDigest)
    expect(forwarded.entries[0]?.metadata.stateDigest).toBe(renamedBundle.entries[0]?.metadata.stateDigest)
  })

  it('archives an older branch and restores it as the active session', async () => {
    const source = createEnvironment('source')
    const sourceId = addSourceSession(source)
    const target = createEnvironment('target')
    const firstBundle = await source.service.exportBundle()
    await target.service.applyBundle(firstBundle, 'source peer', 'p-0123456789abcdef01234567')
    const oldLocalId = target.state.read().records[JSON.stringify(['session', firstBundle.entries[0]!.metadata.originInstanceId, firstBundle.entries[0]!.metadata.originEntityId])]?.localEntityId

    source.persistence.mutateEvent(String(sourceId), (event) => event.type === 'turn/start'
      ? { ...event, time: event.time + 1 }
      : event)
    const newerBundle = await source.service.exportBundle()
    await target.service.applyBundle(newerBundle, 'source peer', 'p-0123456789abcdef01234567')

    const [losingBranch] = target.service.listArchives()
    expect(losingBranch?.localSessionId).toBe(oldLocalId)
    const restoredId = await target.service.restoreArchive(losingBranch!.branchId)
    expect(String(restoredId)).toBe(oldLocalId)
    expect(target.state.read().records[JSON.stringify(['session', newerBundle.entries[0]!.metadata.originInstanceId, newerBundle.entries[0]!.metadata.originEntityId])]?.localEntityId)
      .toBe(oldLocalId)
    expect(target.workspaces.archivedSessionIds.map(String)).not.toContain(oldLocalId)
  })

  it('recovers a prepared bundle after a partial append without duplicating transferred objects', async () => {
    const source = createEnvironment('source')
    addSourceSession(source)
    const bundle = await source.service.exportBundle()
    const target = createEnvironment('target')
    target.persistence.failAppendOnce = true

    await expect(target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567')).rejects.toThrow()
    await target.service.recoverPending()

    expect(target.workspaces.list()[0]?.sessionIds).toHaveLength(1)
    expect(target.attachments.saves).toBe(1)
    expect(target.spills.saves).toBe(1)
    expect(target.service.pendingPeerIds()).toEqual([])
  })

  it('replays pending membership before exporting an attached session as local-origin', async () => {
    const source = createEnvironment('source')
    addSourceSession(source)
    const bundle = await source.service.exportBundle()
    const target = createEnvironment('target')
    target.workspaces.failNextAttachAfterOnce = true

    await expect(target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567')).rejects.toThrow()
    const attachedId = target.workspaces.list()[0]?.sessionIds[0]
    expect(attachedId).toBeDefined()
    await target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567')

    const records = Object.values(target.state.read().records).filter((record) =>
      record.kind === 'session' && record.localEntityId === String(attachedId),
    )
    expect(records).toHaveLength(1)
    expect(records[0]?.originInstanceId).toBe(bundle.instanceId)
    expect(target.service.pendingPeerIds()).toEqual([])
  })

  it('reapplies workspace ordering when a journal batch crashed before its final reorder', async () => {
    const source = createEnvironment('source')
    addSourceSession(source)
    const target = createEnvironment('target')
    await target.service.applyBundle(await source.service.exportBundle(), 'source peer', 'p-0123456789abcdef01234567')

    addPlainSession(source, 'workspace-source', 'session-second')
    const bundle = await source.service.exportBundle()
    const targetWorkspace = target.workspaces.list()[0]!
    targetWorkspace.failInsertBeforeOnce = true
    await expect(target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567')).rejects.toThrow()

    await target.service.recoverPending()

    const expectedOrder = [...bundle.entries]
      .sort((a, b) => (a.workspacePosition ?? 0) - (b.workspacePosition ?? 0))
      .map((entry) => target.state.read().records[JSON.stringify([
        'session', entry.metadata.originInstanceId, entry.metadata.originEntityId,
      ])]!.localEntityId)
    expect(targetWorkspace.sessionIds.map(String)).toEqual(expectedOrder)
    expect(target.service.pendingPeerIds()).toEqual([])
  })

  it('continues recovering other journal batches when one batch has no bundle', async () => {
    const source = createEnvironment('source')
    addSourceSession(source)
    const bundle = await source.service.exportBundle()
    const target = createEnvironment('target')
    target.persistence.failAppendOnce = true
    await expect(target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567')).rejects.toThrow()
    target.journal.begin('p-aaaaaaaaaaaaaaaaaaaaaaaa', 'missing bundle', `sha256:${'c'.repeat(64)}`, ['missing-record'])

    await expect(target.service.recoverPending()).rejects.toThrow(/One or more sync session batches remain pending/)

    expect(target.workspaces.list()[0]?.sessionIds).toHaveLength(1)
    expect(target.attachments.saves).toBe(1)
    expect(target.spills.saves).toBe(1)
  })

  it('removes orphaned journal staging while preserving registered recovery batches', () => {
    const home = mkdtempSync(join(tmpdir(), 'dshb-sync-journal-cleanup-'))
    homes.push(home)
    const journal = new SyncSessionJournalStore(home)
    const orphanId = `b-${'a'.repeat(32)}`
    const orphanPath = join(home, 'dshb', 'sync-session-staging', orphanId)
    mkdirSync(orphanPath, { recursive: true })
    const activeId = journal.beginWithBundle(
      'p-0123456789abcdef01234567',
      'source peer',
      `sha256:${'b'.repeat(64)}`,
      [],
      { protocolVersion: 1 },
    )
    const activePath = join(home, 'dshb', 'sync-session-staging', activeId)

    journal.cleanupOrphanedStaging()

    expect(existsSync(orphanPath)).toBe(false)
    expect(existsSync(activePath)).toBe(true)
  })

  it('preserves offline provenance across journal recovery and allows same-instance replay', async () => {
    const source = createEnvironment('source')
    addSourceSession(source)
    const bundle = await source.service.exportBundle()
    const target = createEnvironment('target')
    target.persistence.failAppendOnce = true

    await expect(target.service.applyBundle(bundle, 'offline archive', 'p-000000000000000000000000', {
      importedVia: 'offline',
      allowSameInstance: true,
    })).rejects.toThrow()
    await target.service.recoverPending()

    const sourceEntry = bundle.entries[0]!
    const stateKey = JSON.stringify(['session', sourceEntry.metadata.originInstanceId, sourceEntry.metadata.originEntityId])
    expect(target.state.read().records[stateKey]?.importedVia).toBe('offline')
    expect(target.service.pendingPeerIds()).toEqual([])

    const localBundle = await target.service.exportBundle()
    const replay = await target.service.applyBundle(localBundle, 'offline archive', 'p-000000000000000000000000', {
      importedVia: 'offline',
      allowSameInstance: true,
    })
    expect(replay.skipped).toBe(1)
  })

  it('skips sessions whose remote workspace has no local node mapping', async () => {
    const source = createEnvironment('source')
    addSourceSession(source)
    const bundle = await source.service.exportBundle()
    const target = createEnvironment('target', { mapNode: false })

    const applied = await target.service.applyBundle(bundle, 'source peer', 'p-0123456789abcdef01234567')

    expect(applied.created).toBe(0)
    expect(applied.skipped).toBe(1)
    expect(applied.unmapped).toBe(1)
    expect(target.workspaces.list()).toHaveLength(0)
    expect(target.service.pendingPeerIds()).toEqual([])
  })

  it('rejects tampered, duplicated, oversized and self-origin bundles', async () => {
    const source = createEnvironment('source')
    addSourceSession(source)
    const bundle = await source.service.exportBundle()

    const tampered = { ...bundle, digest: `sha256:${'0'.repeat(64)}` }
    expect(() => validateSyncSessionBundle(tampered)).toThrow(SyncSessionError)
    try {
      validateSyncSessionBundle(tampered)
    } catch (error) {
      expect((error as SyncSessionError).code).toBe('manifest-digest')
    }

    const duplicated = makeSyncSessionBundle(bundle.instanceId, [bundle.entries[0]!, bundle.entries[0]!])
    expect(() => validateSyncSessionBundle(duplicated)).toThrow(/duplicate/)

    const oversized = {
      protocolVersion: 1,
      instanceId: bundle.instanceId,
      entries: new Array(10_001).fill(null),
      digest: `sha256:${'0'.repeat(64)}`,
    }
    expect(() => validateSyncSessionBundle(oversized)).toThrow(/too many records/)

    const target = createEnvironment('target')
    const selfBundle = makeSyncSessionBundle(target.state.instanceId(), bundle.entries, bundle.skipped)
    await expect(target.service.applyBundle(selfBundle, 'source peer')).rejects.toThrow(/this instance/)
  })

  it('derives deterministic conflict-free transfers from revisions', () => {
    const base = { originInstanceId: 'i-11111111111111111111111111111111', originEntityId: 'session-x' }
    const local = {
      metadata: { kind: 'session' as const, ...base, localEntityId: 'a', revision: { physicalTimeMs: 1, logicalCounter: 0, writerInstanceId: 'w' }, contentDigest: `sha256:${'1'.repeat(64)}` },
    }
    const remote = {
      metadata: { kind: 'session' as const, ...base, localEntityId: 'b', revision: { physicalTimeMs: 2, logicalCounter: 0, writerInstanceId: 'w' }, contentDigest: `sha256:${'2'.repeat(64)}` },
    }
    expect(planSessionTransfers('bidirectional', [local], [remote]).toLocal).toHaveLength(1)
    expect(planSessionTransfers('pull', [local], [remote]).toLocal).toHaveLength(1)
    expect(planSessionTransfers('pull', [local], []).toLocal).toHaveLength(0)

    const equalRevision = { metadata: { ...local.metadata, localEntityId: 'c', contentDigest: `sha256:${'3'.repeat(64)}` } }
    expect(() => planSessionTransfers('bidirectional', [local], [equalRevision])).toThrow(/Equal session revisions/)
  })
})
