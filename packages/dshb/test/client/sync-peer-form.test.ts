import { describe, expect, it } from 'vitest'
import {
  applyRemoteProbeToForm,
  buildSyncPeerFormRequest,
  EMPTY_SYNC_PEER_FORM,
  remoteProfileOptions,
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
    expect(request.fields.selection).toEqual({ mode: 'all', nodes: [], workspaces: [], sessions: [] })
    expect(request.secrets).toEqual({ privateKey: 'selected private key', passphrase: 'key phrase' })
  })

  it('round-trips an explicit stable-origin selection scope', () => {
    const selection = {
      mode: 'selected' as const,
      nodes: [{ originInstanceId: 'i-source', originEntityId: 'node-a' }],
      workspaces: [{ originInstanceId: 'i-source', originEntityId: 'workspace-a', remotePath: '/work/app' }],
      sessions: [{ originInstanceId: 'i-source', originEntityId: 'session-a' }],
    }
    const form = { ...EMPTY_SYNC_PEER_FORM, selection }
    const request = buildSyncPeerFormRequest(form)
    const peer = {
      name: 'Peer',
      host: 'peer.example',
      port: 22,
      username: 'sync',
      authKind: 'password' as const,
      direction: 'pull' as const,
      schedule: 'manual' as const,
      syncSessions: true,
      enabled: true,
      selection,
      hasSecret: { hasPassword: true, hasKey: false, hasPassphrase: false },
    }

    expect(request.fields.selection).toEqual(selection)
    expect(toSyncPeerForm(peer).selection).toEqual(selection)
  })

  it('validates optional remote web port boundaries', () => {
    const base = { ...EMPTY_SYNC_PEER_FORM, name: 'Peer', host: 'peer.example', username: 'sync', password: 'pw' }
    expect(syncPeerFormError({ ...base, remoteWebPort: '65535' })).toBeUndefined()
    expect(syncPeerFormError({ ...base, remoteWebPort: '65536' })).toBe('远端 Web 端口必须在 1 到 65535 之间')
  })
})

describe('远端配置探测回填', () => {
  it('applyRemoteProbeToForm 用探测值回填空字段并保留手改值', () => {
    const probe = {
      homes: ['/home/mt/.dsh', '/home/mt/Library/Application Support/dsh'],
      profiles: [
        { name: 'web2', dshbInstalled: false, home: '/home/mt/.dsh' },
        { name: 'web', dshbInstalled: true, home: '/home/mt/.dsh' },
      ],
      webPort: 3206,
      instanceId: 'i-1234567890abcdef1234567890abcdef',
      hostKeyFingerprint: 'SHA256:abc',
    }
    const empty = applyRemoteProbeToForm(
      { ...EMPTY_SYNC_PEER_FORM, remoteProfile: '' },
      probe,
    )
    expect(empty.remoteDshHome).toBe('/home/mt/.dsh')
    expect(empty.remoteProfile).toBe('web')
    expect(empty.remoteWebPort).toBe('3206')

    const edited = applyRemoteProbeToForm(
      { ...EMPTY_SYNC_PEER_FORM, remoteDshHome: '/custom/.dsh', remoteProfile: 'prod' },
      probe,
    )
    expect(edited.remoteDshHome).toBe('/custom/.dsh')
    expect(edited.remoteProfile).toBe('prod')
    expect(edited.remoteWebPort).toBe('3206')
  })

  it('remoteProfileOptions 把 dshb 已装条目排前并保留手填值', () => {
    const probe = {
      homes: ['/home/mt/.dsh'],
      profiles: [
        { name: 'scratch', dshbInstalled: false, home: '/home/mt/.dsh' },
        { name: 'web', dshbInstalled: true, home: '/home/mt/.dsh' },
      ],
      hostKeyFingerprint: 'SHA256:abc',
    }
    const options = remoteProfileOptions({ ...EMPTY_SYNC_PEER_FORM, remoteProfile: 'prod' }, probe)
    expect(options.map((option) => option.name)).toEqual(['web', 'scratch', 'prod'])
    expect(remoteProfileOptions(EMPTY_SYNC_PEER_FORM).map((option) => option.name)).toEqual(['web'])
  })
})
