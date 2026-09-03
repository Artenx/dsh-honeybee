import { Client, type ConnectConfig } from 'ssh2'

export interface SshAuthConfig {
  kind: 'password' | 'key' | 'agent'
  keyPath?: string
}

export interface SshJumpHop {
  host: string
  port?: number
  username?: string
  keyPath?: string
}

export interface SshTarget {
  host: string
  port: number
  username: string
  auth: SshAuthConfig
  jump?: SshJumpHop[]
}

export interface SshSecrets {
  password?: string
  privateKey?: string
  passphrase?: string
}

export type SshErrorCategory = 'auth' | 'network' | 'hostkey' | 'timeout' | 'unknown'

export interface SshConnectionError extends Error {
  category: SshErrorCategory
  cause?: unknown
}

const HANDSHAKE_TIMEOUT_MS = 30_000
const MAX_RETRIES = 5
const BASE_DELAY_MS = 500

export function classifySshError(err: unknown): SshErrorCategory {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  if (msg.includes('all configured authentication methods failed') || msg.includes('auth') || msg.includes('password') || msg.includes('publickey')) return 'auth'
  if (msg.includes('host key') || msg.includes('man-in-the-middle') || msg.includes('fingerprint')) return 'hostkey'
  if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('ready timeout')) return 'timeout'
  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound') || msg.includes('connect') || msg.includes('network')) return 'network'
  return 'unknown'
}

export function toConnectionError(err: unknown): SshConnectionError {
  const category = classifySshError(err)
  const message = err instanceof Error ? err.message : String(err)
  const e = new Error(message) as SshConnectionError
  e.category = category
  e.cause = err
  return e
}

function buildConnectConfig(target: SshTarget, secrets: SshSecrets): ConnectConfig {
  const cfg: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: HANDSHAKE_TIMEOUT_MS,
    keepaliveInterval: 0,
    keepaliveCountMax: 3,
  }
  switch (target.auth.kind) {
    case 'password':
      if (secrets.password) cfg.password = secrets.password
      break
    case 'key':
      if (secrets.privateKey) {
        cfg.privateKey = secrets.privateKey
        if (secrets.passphrase) cfg.passphrase = secrets.passphrase
      }
      break
    case 'agent':
      cfg.agent = process.env.SSH_AUTH_SOCK ?? undefined
      break
  }
  return cfg
}

export class SshConnection {
  private client: Client | null = null
  private connecting: Promise<Client> | null = null
  private closed = false

  constructor(
    private readonly target: SshTarget,
    private readonly secrets: SshSecrets,
  ) {}

  async getClient(): Promise<Client> {
    if (this.closed) throw toConnectionError(new Error('connection closed'))
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = this.connectWithRetry()
    try {
      this.client = await this.connecting
      this.client.on('close', () => {
        this.client = null
      })
      this.client.on('error', () => {
        this.client = null
      })
      return this.client
    } finally {
      this.connecting = null
    }
  }

  private async connectWithRetry(): Promise<Client> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.closed) throw toConnectionError(new Error('connection closed'))
      try {
        return await this.connectOnce()
      } catch (err) {
        lastErr = err
        const cat = classifySshError(err)
        if (cat === 'auth' || cat === 'hostkey') throw toConnectionError(err)
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
      }
    }
    throw toConnectionError(lastErr)
  }

  private connectOnce(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      client.once('ready', () => finish(() => resolve(client)))
      client.once('error', (err: unknown) => finish(() => reject(err)))
      client.connect(buildConnectConfig(this.target, this.secrets))
    })
  }

  close(): void {
    this.closed = true
    this.connecting = null
    if (this.client) {
      try {
        this.client.end()
      } catch {}
      this.client = null
    }
  }
}
