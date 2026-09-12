import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type HostKeyDecision = 'accept-new' | 'verify' | 'reject'

export interface KnownHostEntry {
  fingerprint: string
  recordedAt: string
}

export class KnownHostsStore {
  private entries: Record<string, KnownHostEntry> = {}
  private loaded = false

  private file(): string {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(home, 'dshb', 'known_hosts.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      this.entries = JSON.parse(readFileSync(this.file(), 'utf8')) as Record<string, KnownHostEntry>
    } catch {
      this.entries = {}
    }
  }

  private save(): void {
    const file = this.file()
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  }

  key(host: string, port: number): string {
    return `${host}:${port}`
  }

  get(host: string, port: number): KnownHostEntry | undefined {
    this.load()
    return this.entries[this.key(host, port)]
  }

  record(host: string, port: number, fingerprint: string): void {
    this.load()
    this.entries[this.key(host, port)] = { fingerprint, recordedAt: new Date().toISOString() }
    this.save()
  }

  forget(host: string, port: number): void {
    this.load()
    delete this.entries[this.key(host, port)]
    this.save()
  }

  exists(): boolean {
    return existsSync(this.file())
  }

  check(host: string, port: number, fingerprint: string, mode: HostKeyDecision = 'accept-new'): HostKeyDecision {
    this.load()
    const entry = this.entries[this.key(host, port)]
    if (!entry) {
      if (mode === 'accept-new') {
        this.record(host, port, fingerprint)
        return 'accept-new'
      }
      return 'reject'
    }
    if (entry.fingerprint === fingerprint) return 'verify'
    return 'reject'
  }

  list(): Record<string, KnownHostEntry> {
    this.load()
    return { ...this.entries }
  }
}
