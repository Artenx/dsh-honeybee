import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const INSTRUCTION_MAX_BYTES = 32768

export interface WorkspaceInstructionRecord {
  workspaceId: string
  text: string
  revision: number
  digest: string
  createdAt: string
  updatedAt: string
}

export interface SessionInstructionSnapshot {
  sessionId: string
  workspaceId?: string
  workspaceRevision?: number
  digest?: string
  text: string
  capturedAt: string
  inheritedFromSessionId?: string
}

export class InstructionConflictError extends Error {
  readonly expected: number
  readonly actual: number
  constructor(expected: number, actual: number) {
    super(`revision conflict: expected ${expected}, current ${actual}`)
    this.name = 'InstructionConflictError'
    this.expected = expected
    this.actual = actual
  }
}

export class InstructionSizeError extends Error {
  readonly bytes: number
  constructor(bytes: number) {
    super(`instruction exceeds ${INSTRUCTION_MAX_BYTES} bytes (got ${bytes})`)
    this.name = 'InstructionSizeError'
    this.bytes = bytes
  }
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function computeDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

interface WorkspaceStoreData {
  records: Record<string, WorkspaceInstructionRecord>
}

interface SnapshotStoreData {
  records: Record<string, SessionInstructionSnapshot>
}

export class WorkspaceInstructionStore {
  private data: WorkspaceStoreData = { records: {} }
  private loaded = false

  private file(): string {
    return join(dshHome(), 'dshb', 'workspace-instructions.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = readFileSync(this.file(), 'utf8')
      this.data = JSON.parse(raw) as WorkspaceStoreData
      if (!this.data.records || typeof this.data.records !== 'object') {
        this.data = { records: {} }
      }
    } catch {
      this.data = { records: {} }
    }
  }

  private save(): void {
    this.load()
    const file = this.file()
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  }

  get(workspaceId: string): WorkspaceInstructionRecord | undefined {
    this.load()
    const r = this.data.records[workspaceId]
    return r ? { ...r } : undefined
  }

  update(input: {
    workspaceId: string
    text: string
    expectedRevision: number
  }): WorkspaceInstructionRecord {
    this.load()
    const bytes = utf8Bytes(input.text)
    if (bytes > INSTRUCTION_MAX_BYTES) throw new InstructionSizeError(bytes)
    const existing = this.data.records[input.workspaceId]
    if (existing && existing.revision !== input.expectedRevision) {
      throw new InstructionConflictError(input.expectedRevision, existing.revision)
    }
    const now = new Date().toISOString()
    const record: WorkspaceInstructionRecord = {
      workspaceId: input.workspaceId,
      text: input.text,
      revision: (existing?.revision ?? 0) + 1,
      digest: computeDigest(input.text),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.data.records[input.workspaceId] = record
    this.save()
    return { ...record }
  }

  clear(workspaceId: string, expectedRevision: number): void {
    this.load()
    const existing = this.data.records[workspaceId]
    if (existing && existing.revision !== expectedRevision) {
      throw new InstructionConflictError(expectedRevision, existing.revision)
    }
    if (!existing) return
    delete this.data.records[workspaceId]
    this.save()
  }

  removeByWorkspace(workspaceId: string): void {
    this.load()
    if (!this.data.records[workspaceId]) return
    delete this.data.records[workspaceId]
    this.save()
  }
}

export class SessionInstructionSnapshotStore {
  private data: SnapshotStoreData = { records: {} }
  private loaded = false

  private file(): string {
    return join(dshHome(), 'dshb', 'session-instruction-snapshots.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = readFileSync(this.file(), 'utf8')
      this.data = JSON.parse(raw) as SnapshotStoreData
      if (!this.data.records || typeof this.data.records !== 'object') {
        this.data = { records: {} }
      }
    } catch {
      this.data = { records: {} }
    }
  }

  private save(): void {
    this.load()
    const file = this.file()
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  }

  get(sessionId: string): SessionInstructionSnapshot | undefined {
    this.load()
    const r = this.data.records[sessionId]
    return r ? { ...r } : undefined
  }

  createIfAbsent(
    sessionId: string,
    source:
      | { kind: 'workspace'; record: WorkspaceInstructionRecord; workspaceId: string }
      | { kind: 'empty'; workspaceId?: string }
      | { kind: 'inherit'; parentSnapshot: SessionInstructionSnapshot },
  ): SessionInstructionSnapshot {
    this.load()
    const existing = this.data.records[sessionId]
    if (existing) return { ...existing }
    let snapshot: SessionInstructionSnapshot
    const now = new Date().toISOString()
    if (source.kind === 'workspace') {
      snapshot = {
        sessionId,
        workspaceId: source.workspaceId,
        workspaceRevision: source.record.revision,
        digest: source.record.digest,
        text: source.record.text,
        capturedAt: now,
      }
    } else if (source.kind === 'inherit') {
      const parent = source.parentSnapshot
      snapshot = {
        sessionId,
        workspaceId: parent.workspaceId,
        workspaceRevision: parent.workspaceRevision,
        digest: parent.digest,
        text: parent.text,
        capturedAt: now,
        inheritedFromSessionId: parent.sessionId,
      }
    } else {
      snapshot = {
        sessionId,
        workspaceId: source.workspaceId,
        text: '',
        capturedAt: now,
      }
    }
    this.data.records[sessionId] = snapshot
    this.save()
    return { ...snapshot }
  }

  remove(sessionId: string): void {
    this.load()
    if (!this.data.records[sessionId]) return
    delete this.data.records[sessionId]
    this.save()
  }
}

let sharedWorkspaceStore: WorkspaceInstructionStore | null = null
let sharedSnapshotStore: SessionInstructionSnapshotStore | null = null

export function sharedWorkspaceInstructionStore(): WorkspaceInstructionStore {
  if (!sharedWorkspaceStore) sharedWorkspaceStore = new WorkspaceInstructionStore()
  return sharedWorkspaceStore
}

export function sharedSessionInstructionSnapshotStore(): SessionInstructionSnapshotStore {
  if (!sharedSnapshotStore) sharedSnapshotStore = new SessionInstructionSnapshotStore()
  return sharedSnapshotStore
}
