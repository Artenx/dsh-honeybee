import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Server, utils } from 'ssh2'
import type { SyncPeer } from '../../src/core/sync/model.js'
import { SyncHostKeyChallengeError } from '../../src/core/sync/host-key.js'
import { encodeSyncControlFrame, SyncFrameDecoder } from '../../src/core/sync/protocol.js'
import { REMOTE_SYNC_HELPER_COMMAND } from '../../src/core/sync/remote-helper.js'
import { SyncSshTransport } from '../../src/core/sync/ssh-transport.js'

describe('SSH authentication integration', () => {
  it('pins a live loopback SSH host and authenticates with password and private key', async () => {
    const hostKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })
    const clientKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })
    const parsedClientKey = utils.parseKey(clientKeyPair.privateKey)
    if (parsedClientKey instanceof Error) throw parsedClientKey
    const peer: SyncPeer = {
      id: 'p-0123456789abcdef01234567',
      name: 'Loopback test peer',
      host: '127.0.0.1',
      port: 0,
      username: 'sync-user',
      authKind: 'password',
      direction: 'pull',
      schedule: 'manual',
      syncSessions: false,
      enabled: true,
    }
    const server = new Server({ hostKeys: [hostKeyPair.privateKey] }, (connection) => {
      connection.on('error', () => {})
      connection.on('authentication', (context) => {
        if (context.username !== peer.username) { context.reject(); return }
        if (context.method === 'password') {
          if (context.password === 'loopback-password') context.accept()
          else context.reject()
          return
        }
        if (context.method === 'publickey' && context.key.data.equals(parsedClientKey.getPublicSSH())) {
          if (!context.signature || (context.blob && parsedClientKey.verify(context.blob, context.signature, context.hashAlgo))) {
            context.accept()
          } else context.reject()
          return
        }
        context.reject()
      })
      connection.on('ready', () => {
        connection.on('session', (accept, reject) => {
          const session = accept()
          session.on('exec', (acceptChannel, rejectChannel, info) => {
            if (info.command !== REMOTE_SYNC_HELPER_COMMAND) { rejectChannel(); return }
            const channel = acceptChannel()
            const decoder = new SyncFrameDecoder()
            let operation = ''
            channel.on('data', (chunk: Buffer) => {
              for (const frame of decoder.push(Buffer.from(chunk))) {
                if (frame.kind === 'control' && frame.value.kind === 'request') {
                  operation = String(frame.value.operation ?? '')
                }
              }
            })
            channel.on('end', () => {
              decoder.finish()
              if (operation !== 'handshake') { channel.end(); return }
              channel.write(encodeSyncControlFrame({
                kind: 'response',
                status: 200,
                body: {
                  protocolVersion: 1,
                  instanceId: 'i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  capabilities: ['nodes', 'sessions'],
                },
              }))
              channel.end()
            })
          })
        })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    peer.port = (server.address() as { port: number }).port
    let privateKey = false
    const manager = {
      async connectionData() {
        return {
          peer,
          secrets: privateKey
            ? { privateKey: clientKeyPair.privateKey }
            : { password: 'loopback-password' },
        }
      },
      async pinHostKey(_id: string, fingerprint: string) { peer.hostKeyFingerprint = fingerprint; return peer },
    }
    const transport = new SyncSshTransport(manager as never)
    try {
      await expect(transport.probe(peer.id)).rejects.toBeInstanceOf(SyncHostKeyChallengeError)
      await transport.trustObservedHostKey(peer.id)
      await expect(transport.probe(peer.id)).resolves.toMatchObject({
        protocolVersion: 1,
        instanceId: 'i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      })

      privateKey = true
      peer.authKind = 'key'
      await expect(transport.probe(peer.id)).resolves.toMatchObject({ capabilities: ['nodes', 'sessions'] })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
