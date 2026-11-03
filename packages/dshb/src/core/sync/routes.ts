import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SyncHostKeyChallengeError, SyncHostKeyChallengeExpiredError } from './host-key.js'
import { SyncPeerInputError, SyncPeerManager, SyncPeerNotFoundError } from './peer-manager.js'
import { SyncRemoteProbe, SyncSshProbeError, SyncSshTransport } from './ssh-transport.js'
import { SyncCoordinator, SyncCoordinatorError } from './coordinator.js'
import type { SyncStateStore } from './stores.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024

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
  state?: SyncStateStore,
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

        if (req.method === 'POST' && peerId === 'probe-remote') {
          // 远端配置探测：① peerId 模式——用已保存对端的存储凭据；② 显式模式——
          // 用表单填写的 SSH 连接信息（新建对端场景）。
          const body = await readBody(req)
          if (!body || (typeof body.peerId !== 'string'
            && (typeof body.host !== 'string' || !body.host.trim()
              || typeof body.username !== 'string' || !body.username.trim()
              || !Number.isInteger(body.port) || (body.port as number) < 1 || (body.port as number) > 65535
              || (body.authKind !== 'password' && body.authKind !== 'key')))) {
            sendJson(res, 400, { ok: false, error: 'either peerId or host/port/username/authKind are required' })
            return
          }
          try {
            const probe = new SyncRemoteProbe()
            let result
            if (typeof body.peerId === 'string' && body.peerId !== 'new') {
              const { peer, secrets } = await manager.connectionData(body.peerId)
              result = await probe.probeRemote(
                { host: peer.host, port: peer.port, username: peer.username, authKind: peer.authKind },
                secrets,
                peer.remoteWebPort,
              )
            } else {
              const secrets = (body.secrets ?? {}) as Record<string, unknown>
              if (body.authKind === 'password' && typeof secrets.password !== 'string') {
                sendJson(res, 400, { ok: false, error: 'SSH password is required for probing' })
                return
              }
              if (body.authKind === 'key' && typeof secrets.privateKey !== 'string') {
                sendJson(res, 400, { ok: false, error: 'SSH private key is required for probing' })
                return
              }
              const authKind = body.authKind === 'key' ? 'key' : 'password'
              result = await probe.probeRemote(
                { host: (body.host as string).trim(), port: body.port as number, username: (body.username as string).trim(), authKind },
                secrets as { password?: string; privateKey?: string; passphrase?: string },
              )
            }
            sendJson(res, 200, { ok: true, probe: result })
          } catch (error) {
            if (error instanceof SyncPeerNotFoundError) {
              sendJson(res, 404, { ok: false, error: '同步节点已不存在' })
              return
            }
            sendProbeFailure(res, error)
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

        if (action === 'catalog' && req.method === 'GET') {
          // ?cached=1 读取元数据同步最近一次落盘目录；默认实时拉取远端。
          if (typeof req.url === 'string' && new URL(req.url, 'http://x').searchParams.get('cached') === '1') {
            const entry = state?.read().catalogs[peerId]
            if (!entry) {
              sendJson(res, 404, { ok: false, error: '尚未同步过目录' })
              return
            }
            sendJson(res, 200, { ok: true, catalog: entry.catalog, fetchedAt: entry.fetchedAt })
            return
          }
          if (!transport) {
            sendJson(res, 503, { ok: false, error: 'SSH sync transport unavailable' })
            return
          }
          try {
            if (!await manager.get(peerId)) {
              sendJson(res, 404, { ok: false, error: 'sync peer not found' })
              return
            }
            sendJson(res, 200, { ok: true, catalog: await transport.fetchCatalog(peerId) })
          } catch (error) {
            sendProbeFailure(res, error)
          }
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
              const peer = await manager.get(peerId)
              if (!peer) {
                sendJson(res, 404, { ok: false, error: 'sync peer not found' })
                return
              }
              if (!peer.enabled) {
                sendJson(res, 409, { ok: false, code: 'peer-disabled', error: '此同步节点已停用' })
                return
              }
              void coordinator.run(peerId).catch(() => undefined)
              sendJson(res, 202, { ok: true, accepted: true })
            } catch (error) {
              sendRunFailure(res, error)
            }
            return
          }
          if (action === 'stop') {
            // 停止运行中的同步：在最近的安全边界中止，丢弃未完成批次，水位不变。
            if (!coordinator) {
              sendJson(res, 503, { ok: false, error: 'sync coordinator unavailable' })
              return
            }
            try {
              await manager.get(peerId)
              sendJson(res, 200, { ok: true, stopped: coordinator.stop(peerId) })
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
