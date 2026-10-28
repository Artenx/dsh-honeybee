import { describe, expect, it } from 'vitest'
import {
  buildSyncPeerFormRequest,
  EMPTY_SYNC_PEER_FORM,
  syncPeerFormError,
  toSyncPeerForm,
  type SyncPeerFormView,
} from '../../src/client/sync-peer-form.js'

describe('sync peer form model', () => {
  it('defaults to manual pull with session sync disabled', () => {
    expect(EMPTY_SYNC_PEER_FORM).toMatchObject({
      direction: 'pull',
      schedule: 'manual',
      syncSessions: false,
      enabled: true,
    })
  })

  it('requires valid SSH fields and credentials for the selected auth method', () => {
    expect(syncPeerFormError(EMPTY_SYNC_PEER_FORM)).toBe('请填写名称、SSH 主机和系统账号')
    expect(syncPeerFormError({ ...EMPTY_SYNC_PEER_FORM, name: 'Peer', host: 'peer.example', username: 'sync', port: '22' })).toBe('请填写 SSH 密码')
    expect(syncPeerFormError({
      ...EMPTY_SYNC_PEER_FORM,
      name: 'Peer',
      host: 'peer.example',
      username: 'sync',
      authKind: 'key',
      port: '22',
    })).toBe('请填写 SSH 私钥内容')
    expect(syncPeerFormError({
      ...EMPTY_SYNC_PEER_FORM,
      name: 'Peer',
      host: 'peer.example',
      username: 'sync',
      port: '22',
    }, { hasPassword: true, hasKey: false, hasPassphrase: false })).toBeUndefined()
  })

  it('does not hydrate secret values into an edit form', () => {
    const peer: SyncPeerFormView = {
      name: 'Peer',
      host: 'peer.example',
      port: 2222,
      username: 'sync',
      authKind: 'key',
      remoteDshHome: '/home/sync/.dsh',
      remoteProfile: 'web',
      remoteWebPort: 3090,
      direction: 'bidirectional',
      schedule: 'every-5m',
      syncSessions: true,
      enabled: false,
      hasSecret: { hasPassword: false, hasKey: true, hasPassphrase: true },
    }
    const form = toSyncPeerForm(peer)

    expect(form).toMatchObject({
      name: 'Peer',
      port: '2222',
      remoteWebPort: '3090',
      direction: 'bidirectional',
      schedule: 'every-5m',
      syncSessions: true,
      enabled: false,
    })
    expect(form.password).toBe('')
    expect(form.privateKey).toBe('')
    expect(form.passphrase).toBe('')
  })

  it('serializes only the selected authentication secret and omits blank optional fields', () => {
    const request = buildSyncPeerFormRequest({
      ...EMPTY_SYNC_PEER_FORM,
      name: ' Peer ',
      host: ' peer.example ',
      username: ' sync ',
      authKind: 'key',
      password: 'stale password',
      privateKey: 'selected private key',
      passphrase: 'key phrase',
    })

    expect(request.fields).toMatchObject({ name: 'Peer', host: 'peer.example', username: 'sync', port: 22 })
    expect(request.fields).not.toHaveProperty('remoteDshHome')
    expect(request.secrets).toEqual({ privateKey: 'selected private key', passphrase: 'key phrase' })
  })

  it('validates optional remote web port boundaries', () => {
    const base = { ...EMPTY_SYNC_PEER_FORM, name: 'Peer', host: 'peer.example', username: 'sync', password: 'pw' }
    expect(syncPeerFormError({ ...base, remoteWebPort: '65535' })).toBeUndefined()
    expect(syncPeerFormError({ ...base, remoteWebPort: '65536' })).toBe('远端 Web 端口必须在 1 到 65535 之间')
  })
})
