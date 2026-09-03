import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface WorkspaceBinding {
  mirrorPath: string
  nodeId: string
  remotePath: string
  workspaceId?: string
}

export interface BindingHit {
  nodeId: string
  remotePath: string
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function normalize(p: string): string {
  return p.replace(/\/+$/, '') || '/'
}

export class WorkspaceBindingsStore {
  private bindings: WorkspaceBinding[] = []
  private loaded = false

  private file(): string {
    return join(dshHome(), 'dshb', 'workspace-bindings.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      this.bindings = (JSON.parse(readFileSync(this.file(), 'utf8')) as WorkspaceBinding[]).map((b) => ({
        ...b,
        mirrorPath: normalize(b.mirrorPath),
      }))
    } catch {
      this.bindings = []
    }
  }

  private save(): void {
    const file = this.file()
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.bindings, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  }

  add(binding: Omit<WorkspaceBinding, 'mirrorPath'> & { mirrorPath: string }): void {
    this.load()
    const mirrorPath = normalize(binding.mirrorPath)
    this.bindings = this.bindings.filter((b) => normalize(b.mirrorPath) !== mirrorPath)
    this.bindings.push({ ...binding, mirrorPath })
    this.save()
  }

  remove(mirrorPath: string): void {
    this.load()
    const target = normalize(mirrorPath)
    this.bindings = this.bindings.filter((b) => normalize(b.mirrorPath) !== target)
    this.save()
  }

  list(): WorkspaceBinding[] {
    this.load()
    return this.bindings.map((b) => ({ ...b }))
  }

  resolve(path: string): BindingHit | undefined {
    this.load()
    const target = normalize(path)
    let best: WorkspaceBinding | undefined
    for (const b of this.bindings) {
      const root = normalize(b.mirrorPath)
      if (target === root || target.startsWith(`${root}/`)) {
        if (!best || root.length > normalize(best.mirrorPath).length) best = b
      }
    }
    if (!best) return undefined
    const root = normalize(best.mirrorPath)
    const remoteRoot = normalize(best.remotePath)
    const suffix = target === root ? '' : target.slice(root.length)
    return { nodeId: best.nodeId, remotePath: `${remoteRoot}${suffix}` }
  }

  mirrorRoot(nodeId: string, slug: string): string {
    return join(dshHome(), 'dshb', 'mirrors', nodeId, slug)
  }
}
