import { describe, expect, it } from 'vitest'
import { validateSyncCatalog } from '../../src/core/sync/catalog.js'

describe('sync catalog validation', () => {
  it('preserves the remote blank-session marker', () => {
    const catalog = validateSyncCatalog({
      protocolVersion: 1,
      instanceId: 'i-' + 'a'.repeat(32),
      nodes: [],
      workspaces: [],
      sessions: [{
        origin: { originInstanceId: 'i-' + 'a'.repeat(32), originEntityId: 'session-blank' },
        sessionId: 'session-blank',
        blank: true,
      }],
    })

    expect(catalog.sessions[0]?.blank).toBe(true)
  })

  it('rejects malformed blank markers', () => {
    expect(() => validateSyncCatalog({
      protocolVersion: 1,
      instanceId: 'i-' + 'a'.repeat(32),
      nodes: [],
      workspaces: [],
      sessions: [{
        origin: { originInstanceId: 'i-' + 'a'.repeat(32), originEntityId: 'session-blank' },
        sessionId: 'session-blank',
        blank: 'true',
      }],
    })).toThrow('sync catalog session is invalid')
  })
})
