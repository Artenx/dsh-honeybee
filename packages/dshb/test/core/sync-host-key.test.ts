import { describe, expect, it } from 'vitest'
import {
  SyncHostKeyChallengeError,
  SyncHostKeyChallengeExpiredError,
  SyncHostKeyChallenges,
  inspectSyncHostKey,
  opensshFingerprintFromSha256Hex,
} from '../../src/core/sync/host-key.js'
import { buildSyncSshConnectConfig } from '../../src/core/sync/ssh-transport.js'
import type { SyncPeer } from '../../src/core/sync/model.js'

const peer: SyncPeer = {
  id: 'p-0123456789abcdef01234567',
  name: 'peer',
  host: 'sync.example.com',
  port: 22,
  username: 'sync',
  authKind: 'password',
  direction: 'pull',
  schedule: 'manual',
  syncSessions: false,
  enabled: true,
}

const hostHashHex = Buffer.alloc(32, 0xab).toString('hex')
const expectedFingerprint = `SHA256:${Buffer.alloc(32, 0xab).toString('base64').replace(/=+$/, '')}`

describe('sync SSH host-key policy', () => {
  it('formats ssh2 SHA256 hex as an OpenSSH fingerprint', () => {
    expect(opensshFingerprintFromSha256Hex(hostHashHex)).toBe(expectedFingerprint)
  })

  it('builds a strict SHA256 verifier and stops at an untrusted key', () => {
    const challenges = new SyncHostKeyChallenges(() => 100)
    let challenge: SyncHostKeyChallengeError | undefined
    const config = buildSyncSshConnectConfig(peer, { password: 'secret' }, challenges, (value) => { challenge = value })
    const verify = config.hostVerifier as (sha256Hex: string) => boolean

    expect(config.hostHash).toBe('sha256')
    expect(config.password).toBe('secret')
    expect(verify(hostHashHex)).toBe(false)
    expect(challenge).toMatchObject({ decision: 'untrusted', fingerprint: expectedFingerprint })
  })

  it('accepts the matching pin before SSH authentication proceeds', () => {
    const challenges = new SyncHostKeyChallenges(() => 100)
    const config = buildSyncSshConnectConfig(
      { ...peer, authKind: 'key', hostKeyFingerprint: expectedFingerprint },
      { privateKey: 'private-key', passphrase: 'passphrase' },
      challenges,
      () => { throw new Error('unexpected challenge') },
    )
    const verify = config.hostVerifier as (sha256Hex: string) => boolean

    expect(verify(hostHashHex)).toBe(true)
    expect(config.privateKey).toBe('private-key')
    expect(config.passphrase).toBe('passphrase')
  })

  it('accepts a matching pin and creates a challenge for first contact', () => {
    const challenges = new SyncHostKeyChallenges(() => 100)
    expect(inspectSyncHostKey({ ...peer, hostKeyFingerprint: expectedFingerprint }, hostHashHex, challenges)).toEqual({ trusted: true })

    const decision = inspectSyncHostKey(peer, hostHashHex, challenges)
    expect(decision.trusted).toBe(false)
    if (!decision.trusted) {
      expect(decision.challenge).toBeInstanceOf(SyncHostKeyChallengeError)
      expect(decision.challenge).toMatchObject({ decision: 'untrusted', fingerprint: expectedFingerprint })
    }
    expect(challenges.acceptObserved(peer)).toBe(expectedFingerprint)
  })

  it('requires explicit acceptance when a pinned host key changes', () => {
    const challenges = new SyncHostKeyChallenges(() => 100)
    const oldFingerprint = `SHA256:${Buffer.alloc(32, 0xcd).toString('base64').replace(/=+$/, '')}`

    const decision = inspectSyncHostKey({ ...peer, hostKeyFingerprint: oldFingerprint }, hostHashHex, challenges)
    expect(decision.trusted).toBe(false)
    if (!decision.trusted) {
      expect(decision.challenge).toMatchObject({ decision: 'changed', expected: oldFingerprint, fingerprint: expectedFingerprint })
    }
    expect(() => challenges.acceptObserved({ ...peer, host: 'other.example.com' })).toThrow(SyncHostKeyChallengeExpiredError)
  })

  it('expires unconfirmed challenges', () => {
    let now = 100
    const challenges = new SyncHostKeyChallenges(() => now)
    const decision = inspectSyncHostKey(peer, hostHashHex, challenges)
    expect(decision.trusted).toBe(false)
    if (!decision.trusted) expect(decision.challenge).toBeInstanceOf(SyncHostKeyChallengeError)
    now += 5 * 60 * 1000
    expect(() => challenges.acceptObserved(peer)).toThrow(SyncHostKeyChallengeExpiredError)
  })
})
