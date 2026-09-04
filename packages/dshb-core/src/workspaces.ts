import { mkdirSync } from 'node:fs'
import { basename, extname } from 'node:path'
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

interface RemoteWorldLike {
  ensure(nodeId: string): Promise<{
    fs: {
      stat(path: string): Promise<{ isFile?: boolean; isDirectory?: boolean } | undefined>
      readBytes(path: string, signal?: AbortSignal, maxBytes?: number): Promise<Uint8Array>
    }
  } | undefined>
}

function resolveRemoteWorld(ctx: Context, node: { type: string }): RemoteWorldLike | undefined {
  if (node.type === 'local-docker' || node.type === 'remote-docker') {
    return ctx.get('dshbDockerWorldsGeneric') as RemoteWorldLike | undefined
  }
  if (node.type === 'remote-ssh') {
    return ctx.get('dshbWorlds') as RemoteWorldLike | undefined
  }
  return undefined
}

const REMOTE_MAX_BYTES = 512 * 1024 * 1024

export function registerRemoteDownloadRoutes(ctx: Context, registry: NodeRegistry, bindings: WorkspaceBindingsStore): void {
  const webServer = ctx.webServer

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/api/dshb/remote',
      handler: async (req, res) => {
        const segs = pathSegments(req)
        const action = segs[3]
        if (req.method !== 'GET' || (action !== 'bound' && action !== 'file')) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }
        const path = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? ''
        if (!path) {
          sendJson(res, 400, { ok: false, error: '需要 path' })
          return
        }
        const hit = bindings.resolve(path)
        if (!hit) {
          sendJson(res, action === 'bound' ? 200 : 404, { ok: true, bound: false })
          return
        }
        const node = registry.get(hit.nodeId)
        if (!node) {
          sendJson(res, 502, { ok: false, bound: true, error: 'node not found' })
          return
        }
        const worlds = resolveRemoteWorld(ctx, node)
        if (!worlds) {
          sendJson(res, 502, { ok: false, bound: true, error: '远程执行世界不可用' })
          return
        }
        try {
          const world = await worlds.ensure(node.id)
          if (!world) {
            sendJson(res, 502, { ok: false, bound: true, error: '节点执行世界未就绪' })
            return
          }
          const info = await world.fs.stat(hit.remotePath)
          const isFile = info?.isFile ?? false
          if (action === 'bound') {
            sendJson(res, 200, { ok: true, bound: true, nodeId: node.id, remotePath: hit.remotePath, kind: isFile ? 'file' : 'dir' })
            return
          }
          if (!isFile) {
            sendJson(res, 404, { ok: false, bound: true, error: '目标不是文件' })
            return
          }
          const data = await world.fs.readBytes(hit.remotePath, undefined, REMOTE_MAX_BYTES)
          const name = basename(hit.remotePath) || 'download'
          const ext = extname(name).toLowerCase()
          const mime: Record<string, string> = {
            '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
            '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png',
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
            '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.csv': 'text/csv', '.yaml': 'text/yaml', '.yml': 'text/yaml',
          }
          res.writeHead(200, {
            'content-type': mime[ext] ?? 'application/octet-stream',
            'content-disposition': `attachment; filename="${encodeURIComponent(name).replace(/%20/g, ' ')}"`,
            'cache-control': 'no-store',
          })
          res.end(Buffer.from(data))
        } catch (err) {
          sendJson(res, 502, { ok: false, bound: true, error: err instanceof Error ? err.message : String(err) })
        }
      },
    }),
  )
}
