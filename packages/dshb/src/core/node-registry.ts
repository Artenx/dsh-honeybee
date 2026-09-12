import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'

export type NodeType = 'local-host' | 'local-docker' | 'remote-ssh' | 'remote-docker'

export interface NodeSshAuth {
  kind: 'password' | 'key' | 'agent'
  keyPath?: string
}

export interface NodeJumpHop {
  host: string
  port?: number
  username?: string
  keyPath?: string
}

export interface NodeSsh {
  host: string
  port: number
  username: string
  auth: NodeSshAuth
  jump?: NodeJumpHop[]
  hostKeyFingerprint?: string
}

export interface NodeDocker {
  mode: 'existing' | 'managed'
  containerId?: string
  image?: string
  resources?: { cpus?: number; memoryMB?: number }
}

export interface NodeProfile {
  id: string
  name: string
  type: NodeType
  ssh?: NodeSsh
  docker?: NodeDocker
  createdAt: string
  updatedAt: string
}

export interface NodeSecrets {
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface NodeStatus {
  reachable?: boolean
  lastCheckedAt?: string
  error?: string
}

export interface NodeTestReport {
  ok: boolean
  reachable?: boolean
  error?: string
  category?: string
}

export interface NodeCreateInput {
  name: string
  type: NodeType
  ssh?: Omit<NodeSsh, 'hostKeyFingerprint'> & { hostKeyFingerprint?: string }
  docker?: NodeDocker
  secrets?: NodeSecrets
}

export interface NodeUpdateInput {
  name?: string
  ssh?: Partial<Omit<NodeSsh, 'hostKeyFingerprint'>>
  docker?: Partial<NodeDocker>
  secrets?: NodeSecrets
}

export interface CredentialLike {
  readRecord(key: CredentialKey): Promise<unknown>
  modifyRecord(key: CredentialKey, mutate: (current: unknown) => Promise<unknown>): Promise<unknown>
  deleteRecord(key: CredentialKey): Promise<void>
}

function newId(): string {
  return `n${randomBytes(6).toString('hex')}`
}

export function slugifyName(name: string): string {
  return name.trim().slice(0, 64) || 'node'
}

function isLowerHyphenatedId(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value)
}

function sameName(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function join(...parts: string[]): string {
  return parts.join('/')
}

const LOCAL_NODE_ID = 'local'

export class NodeRegistry {
  private profiles: NodeProfile[] = []
  private loaded = false
  private readonly statuses = new Map<string, NodeStatus>()

  constructor(private readonly ctx: Context) {}

  private get creds(): CredentialLike {
    return this.ctx.credentials as unknown as CredentialLike
  }

  private file(): string {
    return `${dshHome()}/dshb/nodes.json`
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      this.profiles = JSON.parse(readFileSync(this.file(), 'utf8')) as NodeProfile[]
    } catch {
      this.profiles = []
    }
    this.ensureLocalHost()
  }

  private ensureLocalHost(): void {
    const existing = this.profiles.find((p) => p.type === 'local-host')
    if (existing) {
      if (existing.name !== '默认环境') {
        existing.name = '默认环境'
        existing.updatedAt = new Date().toISOString()
        this.save()
      }
      return
    }
    const now = new Date().toISOString()
    this.profiles.unshift({
      id: LOCAL_NODE_ID,
      name: '默认环境',
      type: 'local-host',
      createdAt: now,
      updatedAt: now,
    })
    this.save()
  }

  private save(): void {
    const file = this.file()
    const dir = file.slice(0, file.lastIndexOf('/'))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.profiles, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  }

  list(): NodeProfile[] {
    this.load()
    return this.profiles.map((p) => ({ ...p }))
  }

  get(id: string): NodeProfile | undefined {
    this.load()
    const found = this.profiles.find((p) => p.id === id)
    return found ? { ...found } : undefined
  }

  async hasSecret(id: string): Promise<{ hasPassword: boolean; hasKey: boolean; hasPassphrase: boolean }> {
    const key = this.credKey(id)
    if (!key) return { hasPassword: false, hasKey: false, hasPassphrase: false }
    const record = (await this.creds.readRecord(key)) as { payload?: NodeSecrets } | undefined
    const payload = record?.payload
    return {
      hasPassword: Boolean(payload?.password),
      hasKey: Boolean(payload?.privateKey),
      hasPassphrase: Boolean(payload?.passphrase),
    }
  }

  async getSecrets(id: string): Promise<NodeSecrets | undefined> {
    const key = this.credKey(id)
    if (!key) return undefined
    const record = (await this.creds.readRecord(key)) as { payload?: NodeSecrets } | undefined
    return record?.payload
  }

  async create(input: NodeCreateInput): Promise<NodeProfile> {
    this.load()
    const name = slugifyName(input.name)
    if (this.profiles.some((p) => sameName(p.name, name))) {
      throw new Error(`node name "${name}" already exists`)
    }
    const id = newId()
    if (!isLowerHyphenatedId(id)) throw new Error('internal: invalid generated id')
    const now = new Date().toISOString()
    const profile: NodeProfile = {
      id,
      name,
      type: input.type,
      ssh: input.ssh as NodeSsh | undefined,
      docker: input.docker,
      createdAt: now,
      updatedAt: now,
    }
    if (input.secrets && (input.secrets.password || input.secrets.privateKey || input.secrets.passphrase)) {
      await this.writeSecrets(id, input.secrets)
    }
    this.profiles.push(profile)
    this.save()
    return { ...profile }
  }

  async update(id: string, input: NodeUpdateInput): Promise<NodeProfile> {
    this.load()
    const idx = this.profiles.findIndex((p) => p.id === id)
    if (idx < 0) throw new Error(`node ${id} not found`)
    const current = this.profiles[idx]
    const next: NodeProfile = { ...current, updatedAt: new Date().toISOString() }
    if (input.name !== undefined) next.name = slugifyName(input.name)
    if (input.ssh) next.ssh = { ...current.ssh, ...input.ssh } as NodeSsh
    if (input.docker) next.docker = { ...current.docker, ...input.docker } as NodeDocker
    this.profiles[idx] = next
    if (input.secrets && (input.secrets.password || input.secrets.privateKey || input.secrets.passphrase)) {
      await this.writeSecrets(id, input.secrets)
    }
    this.save()
    return { ...next }
  }

  async remove(id: string): Promise<void> {
    if (id === LOCAL_NODE_ID) throw new Error('默认环境节点不可删除')
    this.load()
    const idx = this.profiles.findIndex((p) => p.id === id)
    if (idx < 0) return
    this.profiles.splice(idx, 1)
    this.statuses.delete(id)
    this.save()
    const key = this.credKey(id)
    if (key) await this.creds.deleteRecord(key)
  }

  status(id: string): NodeStatus {
    return this.statuses.get(id) ?? {}
  }

  setStatus(id: string, status: NodeStatus): void {
    this.statuses.set(id, status)
  }

  private credKey(id: string): CredentialKey | undefined {
    try {
      return credentialKey('dshb-core', id)
    } catch {
      return undefined
    }
  }

  private async writeSecrets(id: string, secrets: NodeSecrets): Promise<void> {
    const key = this.credKey(id)
    if (!key) throw new Error('credentials service unavailable')
    await this.creds.modifyRecord(key, async () => ({
      kind: 'grant' as const,
      payload: { ...secrets },
    }))
  }
}
