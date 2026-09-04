import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, readdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { NodeRegistry, type NodeProfile, type NodeType } from './node-registry.js'
import { readSshConfig, resolveSshConfigEntry } from './ssh-config.js'
import type { KnownHostsStore } from './known-hosts.js'
import { testNode, type SshHandshakeTester } from './test.js'

interface WorldsLike {
  ensure(nodeId: string): Promise<{
    ensureDir(path: string): Promise<void>
    fs: { listDir(path: string): Promise<Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean }>> }
  } | undefined>
}

const MAX_BODY = 64 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    if ((req.headers['content-type'] ?? '') !== 'application/json') {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function pathSegments(req: IncomingMessage): string[] {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  return path.split('/').filter(Boolean)
}

const VALID_TYPES: NodeType[] = ['local-host', 'local-docker', 'remote-ssh', 'remote-docker']

export async function registerNodeRoutes(ctx: Context, registry: NodeRegistry): Promise<void> {
  const webServer = ctx.webServer
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/api/dshb/nodes',
      handler: async (req, res) => {
        const segs = pathSegments(req)
        const resourceId = segs[3]
        const worlds = ctx.get('dshbWorlds') as WorldsLike | undefined

        if (req.method === 'GET' && segs[4] === 'browse' && resourceId) {
          const node = registry.get(resourceId)
          if (!node) {
            sendJson(res, 404, { ok: false, error: 'node not found' })
            return
          }
          const path = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? (node.type === 'local-host' ? process.env.HOME ?? '/' : '~')
          try {
            if (node.type === 'local-host') {
              const entries = readdirSync(path, { withFileTypes: true }).map((e) => ({
                name: e.name,
                path: `${path.replace(/\/$/, '')}/${e.name}`,
                isDirectory: e.isDirectory(),
                isFile: e.isFile(),
              }))
              sendJson(res, 200, { ok: true, path, entries })
              return
            }
            if (!worlds) {
              sendJson(res, 503, { ok: false, error: '远程执行世界不可用' })
              return
            }
            const world = await worlds.ensure(resourceId)
            if (!world) {
              sendJson(res, 503, { ok: false, error: '节点执行世界未就绪' })
              return
            }
            const entries = await world.fs.listDir(path)
            sendJson(res, 200, { ok: true, path, entries })
          } catch (err) {
            sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        if (req.method === 'POST' && segs[4] === 'mkdir' && resourceId) {
          const node = registry.get(resourceId)
          if (!node) {
            sendJson(res, 404, { ok: false, error: 'node not found' })
            return
          }
          const body = await readBody(req)
          const path = body && typeof body.path === 'string' ? body.path : undefined
          if (!path) {
            sendJson(res, 400, { ok: false, error: '需要 path' })
            return
          }
          try {
            if (node.type === 'local-host') {
              mkdirSync(path, { recursive: true })
              sendJson(res, 200, { ok: true, path })
              return
            }
            if (!worlds) {
              sendJson(res, 503, { ok: false, error: '远程执行世界不可用' })
              return
            }
            const world = await worlds.ensure(resourceId)
            if (!world) {
              sendJson(res, 503, { ok: false, error: '节点执行世界未就绪' })
              return
            }
            await world.ensureDir(path)
            sendJson(res, 200, { ok: true, path })
          } catch (err) {
            sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        if (req.method === 'GET' && resourceId === undefined) {
          const nodes = registry.list()
          const withFlags = await Promise.all(
            nodes.map(async (n) => ({ ...n, hasSecret: await registry.hasSecret(n.id) })),
          )
          sendJson(res, 200, { ok: true, nodes: withFlags })
          return
        }

        if (req.method === 'POST' && resourceId === undefined) {
          const body = await readBody(req)
          if (!body) {
            sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
            return
          }
          const type = String(body.type ?? '') as NodeType
          if (!VALID_TYPES.includes(type)) {
            sendJson(res, 400, { ok: false, error: 'type 必须是 local-host/local-docker/remote-ssh/remote-docker' })
            return
          }
          try {
            const node: NodeProfile = await registry.create({
              name: String(body.name ?? ''),
              type,
              ssh: body.ssh as never,
              docker: body.docker as never,
              secrets: body.secrets as never,
            })
            sendJson(res, 201, { ok: true, node: { ...node, hasSecret: await registry.hasSecret(node.id) } })
          } catch (err) {
            sendJson(res, 409, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        if (resourceId === undefined) {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }

        if (req.method === 'GET' && segs[4] === undefined) {
          const node = registry.get(resourceId)
          if (!node) {
            sendJson(res, 404, { ok: false, error: 'node not found' })
            return
          }
          sendJson(res, 200, { ok: true, node: { ...node, hasSecret: await registry.hasSecret(node.id), status: registry.status(resourceId) } })
          return
        }

        if (req.method === 'PATCH' && segs[4] === undefined) {
          const body = await readBody(req)
          if (!body) {
            sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
            return
          }
          try {
            const node = await registry.update(resourceId, {
              name: body.name as string | undefined,
              ssh: body.ssh as never,
              docker: body.docker as never,
              secrets: body.secrets as never,
            })
            sendJson(res, 200, { ok: true, node: { ...node, hasSecret: await registry.hasSecret(node.id) } })
          } catch (err) {
            sendJson(res, 404, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        if (req.method === 'DELETE' && segs[4] === undefined) {
          await registry.remove(resourceId)
          sendJson(res, 200, { ok: true })
          return
        }

        if (req.method === 'POST' && segs[4] === 'test') {
          const sshTester = ctx.get('dshbSshPool') as SshHandshakeTester | undefined
          const report = await testNode(registry, resourceId, sshTester)
          sendJson(res, 200, { ok: true, report })
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}

export async function registerSshConfigRoutes(ctx: Context, knownHosts: KnownHostsStore): Promise<void> {
  const webServer = ctx.webServer

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/api/dshb/ssh-config',
      handler: (_req, res) => {
        const entries = readSshConfig().map(resolveSshConfigEntry)
        sendJson(res, 200, { ok: true, entries })
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/api/dshb/known-hosts',
      handler: async (req, res) => {
        const segs = pathSegments(req)
        const action = segs[3]

        if (req.method === 'GET' && action === undefined) {
          sendJson(res, 200, { ok: true, hosts: knownHosts.list() })
          return
        }

        if (req.method === 'POST' && action === 'forget') {
          const body = await readBody(req)
          if (!body || typeof body.host !== 'string') {
            sendJson(res, 400, { ok: false, error: '需要 host' })
            return
          }
          const port = Number(body.port ?? 22)
          knownHosts.forget(String(body.host), port)
          sendJson(res, 200, { ok: true })
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}
