import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { listContainers, provisionContainer } from './provision.js'
import { resolveHostRunner } from './host-runner.js'

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
      if (size > 64 * 1024) {
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

interface NodeRegistryLike {
  get(id: string): { id: string; type: string; ssh?: unknown; docker?: { containerId?: string; image?: string; mode?: string; resources?: { cpus?: number; memoryMB?: number } } } | undefined
}

export function registerDockerRoutes(ctx: Context): void {
  const webServer = ctx.webServer
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: '/api/dshb/docker',
      handler: async (req, res) => {
        const segs = pathSegments(req)
        const nodeId = segs[3]
        const action = segs[4]

        const nodeRegistry = ctx.get('nodeRegistry') as NodeRegistryLike | undefined
        const node = nodeId ? nodeRegistry?.get(nodeId) : undefined
        if (!node) {
          sendJson(res, 404, { ok: false, error: 'node not found' })
          return
        }

        if (req.method === 'POST' && action === 'provision') {
          const provisioner = ctx.get('dshbDockerProvisioner') as { provision(nodeId: string): Promise<{ containerId: string; name: string }> } | undefined
          if (provisioner) {
            try {
              const result = await provisioner.provision(nodeId)
              sendJson(res, 201, { ok: true, containerId: result.containerId, name: result.name })
            } catch (err) {
              sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) })
            }
            return
          }
          const body = await readBody(req)
          const image = String(body?.image ?? '')
          if (!image) {
            sendJson(res, 400, { ok: false, error: '需要 image' })
            return
          }
          const fallbackRunner = await resolveHostRunner(ctx, node)
          if (!fallbackRunner) {
            sendJson(res, 503, { ok: false, error: '节点执行世界未就绪' })
            return
          }
          try {
            const result = await provisionContainer(fallbackRunner, {
              image,
              cpus: body?.cpus ? Number(body.cpus) : undefined,
              memoryMB: body?.memoryMB ? Number(body.memoryMB) : undefined,
              name: body?.name ? String(body.name) : undefined,
            })
            sendJson(res, 201, { ok: true, containerId: result.containerId, name: result.name })
          } catch (err) {
            sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        const runner = await resolveHostRunner(ctx, node)

        if (!runner) {
          sendJson(res, 503, { ok: false, error: '节点执行世界未就绪' })
          return
        }

        if (req.method === 'GET' && action === 'containers') {
          const containers = await listContainers(runner)
          sendJson(res, 200, { ok: true, containers })
          return
        }

        if (req.method === 'POST' && (action === 'restart' || action === 'stop' || action === 'start')) {
          const containerId = node.docker?.containerId
          if (!containerId) {
            sendJson(res, 400, { ok: false, error: '节点未关联容器' })
            return
          }
          try {
            if (action === 'stop') {
              const r = await runner.run(['docker', 'stop', containerId])
              if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || '停止失败')
              sendJson(res, 200, { ok: true, action: 'stop' })
              return
            }
            if (action === 'start') {
              const r = await runner.run(['docker', 'start', containerId])
              if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || '启动失败')
              sendJson(res, 200, { ok: true, action: 'start' })
              return
            }
            const inspect = await runner.run(['docker', 'inspect', '--format', '{{.State.Running}}', containerId])
            if (inspect.code !== 0) throw new Error('容器不存在或已删除')
            const running = inspect.stdout.trim() === 'true'
            const cmd = running ? 'restart' : 'start'
            const r = await runner.run(['docker', cmd, containerId])
            if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || '重启失败')
            sendJson(res, 200, { ok: true, action: 'restart', was: running ? 'running' : 'stopped' })
          } catch (err) {
            sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}
