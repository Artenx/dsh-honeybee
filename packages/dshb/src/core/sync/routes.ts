import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SyncHostKeyChallengeError, SyncHostKeyChallengeExpiredError } from './host-key.js'
import { SyncPeerInputError, SyncPeerManager, SyncPeerNotFoundError } from './peer-manager.js'
import { SyncSshProbeError, SyncSshTransport } from './ssh-transport.js'
import { SyncCoordinator, SyncCoordinatorError } from './coordinator.js'

const MAX_BODY_BYTES = 128 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      resolve(null)
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      resolve(null)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail()
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          fail()
          return
        }
        settled = true
        resolve(value as Record<string, unknown>)
      } catch {
        fail()
      }
    })
    req.on('error', fail)
  })
}

function pathSegments(req: IncomingMessage): string[] {
  return new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean)
}

function splitBody(body: Record<string, unknown>): { fields: Record<string, unknown>; secrets: unknown } {
  const { secrets, ...fields } = body
  return { fields, secrets }
}

function sendFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof SyncPeerInputError) {
    sendJson(res, 400, { ok: false, error: error.message })
    return
  }
  if (error instanceof SyncPeerNotFoundError) {
    sendJson(res, 404, { ok: false, error: 'sync peer not found' })
    return
  }
  sendJson(res, 500, { ok: false, error: 'sync peer operation failed' })
}

function sendProbeFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof SyncHostKeyChallengeError) {
    sendJson(res, 409, {
      ok: false,
      code: `host-key-${error.decision}`,
      fingerprint: error.fingerprint,
      ...(error.expected ? { expected: error.expected } : {}),
    })
    return
  }
  if (error instanceof SyncHostKeyChallengeExpiredError) {
    sendJson(res, 409, { ok: false, code: 'host-key-challenge-expired', error: error.message })
    return
  }
  if (error instanceof SyncPeerNotFoundError) {
    sendJson(res, 404, { ok: false, error: 'sync peer not found' })
    return
  }
  if (error instanceof SyncSshProbeError) {
    const status = error.category === 'auth' ? 502 : error.category === 'protocol' || error.category === 'hostkey' ? 409 : 503
    sendJson(res, status, { ok: false, code: `ssh-${error.category}`, error: error.message })
    return
  }
  sendJson(res, 500, { ok: false, error: 'sync peer probe failed' })
}

function sendRunFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof SyncCoordinatorError) {
    const status = error.code === 'peer-not-found' ? 404
      : error.code === 'peer-disabled' || error.code === 'sessions-unavailable' || error.code === 'revision-conflict' ? 409
        : error.code === 'session-bundle-too-large' || error.code === 'session-too-large' ? 413
          : error.code === 'session-workspace-unmapped' || error.code === 'session-format' || error.code === 'session-revision-conflict' || error.code === 'session-same-instance' ? 409
            : error.code.startsWith('ssh-') ? 502 : 500
    sendJson(res, status, { ok: false, code: error.code, error: error.message })
    return
  }
  sendJson(res, 500, { ok: false, error: 'sync run failed' })
}

export function registerSyncPeerRoutes(
  ctx: Context,
  manager: SyncPeerManager,
  transport?: SyncSshTransport,
  coordinator?: SyncCoordinator,
): void {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dshb/sync/peers',
      handler: async (req, res) => {
        const segments = pathSegments(req)
        const peerId = segments[4]
        const action = segments[5]
        if (segments.length > 6) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }

        if (req.method === 'GET' && peerId === undefined) {
          try {
            sendJson(res, 200, { ok: true, peers: await manager.list() })
          } catch {
            sendJson(res, 500, { ok: false, error: 'sync peer list unavailable' })
          }
          return
        }

        if (req.method === 'POST' && peerId === undefined) {
          const body = await readBody(req)
          if (!body) {
            sendJson(res, 400, { ok: false, error: 'request body must be JSON' })
            return
          }
          const { fields, secrets } = splitBody(body)
          try {
            sendJson(res, 201, { ok: true, peer: await manager.create(fields, secrets) })
          } catch (error) {
            sendFailure(res, error)
          }
          return
        }

        if (!peerId) {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }

        if (action !== undefined) {
          if (segments.length !== 6 || req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!transport) {
            sendJson(res, 503, { ok: false, error: 'SSH sync transport unavailable' })
            return
          }
          if (action === 'probe') {
            try {
              const handshake = await transport.probe(peerId)
              sendJson(res, 200, { ok: true, handshake })
            } catch (error) {
              sendProbeFailure(res, error)
            }
            return
          }
          if (action === 'trust-host-key') {
            try {
              await transport.trustObservedHostKey(peerId)
              const peer = await manager.get(peerId)
              sendJson(res, 200, { ok: true, peer })
            } catch (error) {
              sendProbeFailure(res, error)
            }
            return
          }
          if (action === 'run') {
            if (!coordinator) {
              sendJson(res, 503, { ok: false, error: 'sync coordinator unavailable' })
              return
            }
            try {
              sendJson(res, 200, { ok: true, result: await coordinator.run(peerId) })
            } catch (error) {
              sendRunFailure(res, error)
            }
            return
          }
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }

        if (req.method === 'GET') {
          try {
            const peer = await manager.get(peerId)
            if (!peer) {
              sendJson(res, 404, { ok: false, error: 'sync peer not found' })
              return
            }
            sendJson(res, 200, { ok: true, peer })
          } catch {
            sendJson(res, 500, { ok: false, error: 'sync peer lookup failed' })
          }
          return
        }

        if (req.method === 'PATCH') {
          const body = await readBody(req)
          if (!body) {
            sendJson(res, 400, { ok: false, error: 'request body must be JSON' })
            return
          }
          const { fields, secrets } = splitBody(body)
          try {
            sendJson(res, 200, { ok: true, peer: await manager.update(peerId, fields, secrets) })
          } catch (error) {
            sendFailure(res, error)
          }
          return
        }

        if (req.method === 'DELETE') {
          try {
            if (!(await manager.remove(peerId))) {
              sendJson(res, 404, { ok: false, error: 'sync peer not found' })
              return
            }
            sendJson(res, 200, { ok: true })
          } catch {
            sendJson(res, 500, { ok: false, error: 'sync peer removal failed' })
          }
          return
        }

        sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    }),
  )
}
