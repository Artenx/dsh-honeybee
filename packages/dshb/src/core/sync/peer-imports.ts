import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PEER_ID = /^p-[a-f0-9]{24}$/

interface Data {
  version: 1
  peers: Record<string, string[]>
}

function homePath(home?: string): string {
  return home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Durable ownership index for sessions imported on demand from metadata peers. */
export class SyncPeerImportStore {
  private readonly filePath: string
  private data: Data | undefined

  constructor(home?: string) {
    this.filePath = join(homePath(home), 'dshb', 'sync-peer-imports.json')
  }

  list(peerId: string): string[] {
    this.assertPeerId(peerId)
    return [...(this.load().peers[peerId] ?? [])]
  }

  add(peerId: string, localSessionId: string): void {
    this.assertPeerId(peerId)
    if (!localSessionId || localSessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(localSessionId)) {
      throw new Error('invalid imported session ID')
    }
    const data = this.load()
    const ids = data.peers[peerId] ?? []
    if (!ids.includes(localSessionId)) data.peers[peerId] = [...ids, localSessionId]
    this.save()
  }

  clear(peerId: string): void {
    this.assertPeerId(peerId)
    delete this.load().peers[peerId]
    this.save()
  }

  private assertPeerId(peerId: string): void {
    if (!PEER_ID.test(peerId)) throw new Error('invalid sync peer ID')
  }

  private load(): Data {
    if (this.data) return this.data
    try {
      const value: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (value === null || typeof value !== 'object' || Array.isArray(value) || (value as Data).version !== 1 ||
        (value as Data).peers === null || typeof (value as Data).peers !== 'object' || Array.isArray((value as Data).peers)) {
        throw new Error('invalid sync peer import store')
      }
      const peers: Record<string, string[]> = Object.create(null)
      for (const [id, sessions] of Object.entries((value as Data).peers)) {
        if (!PEER_ID.test(id) || !Array.isArray(sessions) || !sessions.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 512)) {
          throw new Error('invalid sync peer import entry')
        }
        peers[id] = [...new Set(sessions)]
      }
      this.data = { version: 1, peers }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') this.data = { version: 1, peers: Object.create(null) }
      else throw error
    }
    return this.data
  }

  private save(): void {
    const dir = join(this.filePath, '..')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(this.load(), null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.filePath)
      chmodSync(this.filePath, 0o600)
    } catch (error) {
      try { unlinkSync(temporary) } catch {}
      throw error
    }
  }
}
