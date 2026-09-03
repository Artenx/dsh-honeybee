import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export interface AuthStoreData {
  username: string
  salt: string
  hash: string
  sessionSecret: string
}

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function authFilePath(): string {
  return join(dshHome(), 'dshb', 'web-auth.json')
}

export function sanitizeUsername(input: string): string {
  return input.replace(/[\x00-\x1f\x7f]/g, '').trim()
}

export class CredentialStore {
  private data: AuthStoreData | null = null
  private loaded = false
  private loadedMtime = 0

  private file(): string {
    return authFilePath()
  }

  private maybeReload(): void {
    if (!this.loaded) {
      this.load()
      return
    }
    try {
      const mtime = statSync(this.file()).mtimeMs
      if (mtime !== this.loadedMtime) this.load()
    } catch {
      this.data = null
    }
  }

  isInitialized(): boolean {
    this.maybeReload()
    return this.data !== null
  }

  get username(): string | null {
    this.maybeReload()
    return this.data?.username ?? null
  }

  get sessionSecret(): Buffer | null {
    this.maybeReload()
    return this.data ? Buffer.from(this.data.sessionSecret, 'base64') : null
  }

  register(username: string, password: string): void {
    this.maybeReload()
    if (this.data) throw new Error('auth: already initialized')
    const salt = randomBytes(16)
    const hash = scryptSync(password, salt, 64)
    this.data = {
      username,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      sessionSecret: randomBytes(32).toString('base64'),
    }
    this.save()
  }

  verify(password: string): boolean {
    this.maybeReload()
    if (!this.data) return false
    const hash = scryptSync(password, Buffer.from(this.data.salt, 'base64'), 64)
    const expected = Buffer.from(this.data.hash, 'base64')
    return timingSafeEqual(hash, expected)
  }

  changePassword(username: string, password: string): void {
    this.maybeReload()
    if (!this.data) throw new Error('auth: not initialized')
    const salt = randomBytes(16)
    this.data = {
      username,
      salt: salt.toString('base64'),
      hash: scryptSync(password, salt, 64).toString('base64'),
      sessionSecret: randomBytes(32).toString('base64'),
    }
    this.save()
  }

  changeUsername(username: string): void {
    this.maybeReload()
    if (!this.data) throw new Error('auth: not initialized')
    this.data = { ...this.data, username, sessionSecret: randomBytes(32).toString('base64') }
    this.save()
  }

  private load(): void {
    this.loaded = true
    const file = this.file()
    try {
      this.loadedMtime = statSync(file).mtimeMs
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as AuthStoreData
      if (parsed.username && parsed.salt && parsed.hash && parsed.sessionSecret) {
        this.data = parsed
      }
    } catch {
      this.data = null
    }
  }

  private save(): void {
    const file = this.file()
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(tmp, file)
    chmodSync(file, 0o600)
    try {
      this.loadedMtime = statSync(file).mtimeMs
    } catch {}
  }
}

let shared: CredentialStore | null = null

export function sharedCredentialStore(): CredentialStore {
  if (!shared) shared = new CredentialStore()
  return shared
}
