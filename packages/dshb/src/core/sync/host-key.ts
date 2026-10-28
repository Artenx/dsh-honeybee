import type { SyncPeer } from './model.js'

const CHALLENGE_TTL_MS = 5 * 60 * 1000

export type SyncHostKeyDecision = 'trusted' | 'untrusted' | 'changed'

interface PendingHostKey {
  host: string
  port: number
  fingerprint: string
  expiresAt: number
}

export class SyncHostKeyChallengeError extends Error {
  constructor(
    readonly decision: Exclude<SyncHostKeyDecision, 'trusted'>,
    readonly fingerprint: string,
    readonly expected?: string,
  ) {
    super(decision === 'untrusted' ? 'SSH host key requires explicit trust' : 'SSH host key changed')
    this.name = 'SyncHostKeyChallengeError'
  }
}

export class SyncHostKeyChallengeExpiredError extends Error {
  constructor() {
    super('SSH host key challenge expired')
    this.name = 'SyncHostKeyChallengeExpiredError'
  }
}

export function opensshFingerprintFromSha256Hex(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('invalid SSH host-key hash')
  const base64 = Buffer.from(value, 'hex').toString('base64').replace(/=+$/, '')
  return `SHA256:${base64}`
}

export function isOpenSshFingerprint(value: string): boolean {
  return /^SHA256:[A-Za-z0-9+/]{43}$/.test(value)
}

export function inspectSyncHostKey(
  peer: SyncPeer,
  sha256Hex: string,
  challenges: SyncHostKeyChallenges,
): { trusted: true } | { trusted: false; challenge: SyncHostKeyChallengeError } {
  const fingerprint = opensshFingerprintFromSha256Hex(sha256Hex)
  try {
    if (challenges.verify(peer, fingerprint)) return { trusted: true }
  } catch (error) {
    if (error instanceof SyncHostKeyChallengeError) return { trusted: false, challenge: error }
    throw error
  }
  throw new Error('host-key verifier returned an invalid decision')
}

export class SyncHostKeyChallenges {
  private readonly pending = new Map<string, PendingHostKey>()

  constructor(private readonly now: () => number = Date.now) {}

  verify(peer: SyncPeer, fingerprint: string): boolean {
    if (!isOpenSshFingerprint(fingerprint)) throw new Error('invalid SSH host-key fingerprint')
    if (peer.hostKeyFingerprint === fingerprint) {
      this.pending.delete(peer.id)
      return true
    }
    this.pending.set(peer.id, {
      host: peer.host,
      port: peer.port,
      fingerprint,
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    })
    throw new SyncHostKeyChallengeError(
      peer.hostKeyFingerprint ? 'changed' : 'untrusted',
      fingerprint,
      peer.hostKeyFingerprint,
    )
  }

  acceptObserved(peer: SyncPeer): string {
    const challenge = this.pending.get(peer.id)
    this.pending.delete(peer.id)
    if (!challenge || challenge.expiresAt <= this.now() || challenge.host !== peer.host || challenge.port !== peer.port) {
      throw new SyncHostKeyChallengeExpiredError()
    }
    return challenge.fingerprint
  }
}
