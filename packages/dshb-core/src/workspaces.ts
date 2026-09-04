import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { NodeRegistry } from './node-registry.js'
import type { WorkspaceBindingsStore } from './workspace-bindings.js'

const MAX_BODY = 64 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
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
  return new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean)
}

interface WorldsLike {
  ensure(nodeId: string): Promise<{ ensureDir(path: string): Promise<void> } | undefined>
}

interface DockerProvisionLike {
  provision(nodeId: string): Promise<{ containerId: string } | undefined>
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace'
}

export function registerWorkspaceRoutes(ctx: Context, registry: NodeRegistry, bindings: WorkspaceBindingsStore): void {
  const webServer = ctx.webServer

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/api/dshb/workspaces',
      handler: async (req, res) => {
        const worlds = ctx.get('dshbWorlds') as WorldsLike | undefined
        const segs = pathSegments(req)
        const action = segs[3]

        if (req.method === 'POST' && action === 'bind') {
          const body = await readBody(req)
          if (!body || typeof body.nodeId !== 'string' || typeof body.remotePath !== 'string') {
            sendJson(res, 400, { ok: false, error: '需要 nodeId 与 remotePath' })
            return
          }
          const node = registry.get(body.nodeId)
          if (!node) {
            sendJson(res, 404, { ok: false, error: 'node not found' })
            return
          }
          const remotePath = String(body.remotePath)
          if (node.type === 'local-host') {
            sendJson(res, 200, { ok: true, mirrorPath: remotePath })
            return
          }
          const slug = slugify(String(body.name ?? remotePath.split('/').filter(Boolean).pop() ?? 'workspace'))
          const mirrorPath = bindings.mirrorRoot(node.id, slug)
          try {
            const isDocker = node.type === 'local-docker' || node.type === 'remote-docker'
            if (isDocker) {
              const dockerWorlds = ctx.get('dshbDockerWorldsGeneric') as WorldsLike | undefined
              if (!dockerWorlds) {
                sendJson(res, 503, { ok: false, error: 'Docker 执行世界不可用（dshb-exec-docker 未加载）' })
                return
              }
              const world = await dockerWorlds.ensure(node.id)
              if (!world) {
                sendJson(res, 503, { ok: false, error: '容器未就绪，请先拉起容器' })
                return
              }
              await world.ensureDir(remotePath)
            } else {
              if (!worlds) {
                sendJson(res, 503, { ok: false, error: '远程执行世界不可用' })
                return
              }
              const world = await worlds.ensure(node.id)
              if (!world) {
                sendJson(res, 503, { ok: false, error: '节点执行世界未就绪' })
                return
              }
              await world.ensureDir(remotePath)
            }
            mkdirSync(mirrorPath, { recursive: true })
            bindings.add({ mirrorPath, nodeId: node.id, remotePath })
            sendJson(res, 201, { ok: true, mirrorPath })
          } catch (err) {
            sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        if (req.method === 'GET' && action === undefined) {
          sendJson(res, 200, { ok: true, bindings: bindings.list() })
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}
