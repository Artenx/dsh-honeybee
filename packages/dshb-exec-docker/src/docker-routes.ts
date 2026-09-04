import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { HostCommandRunner } from './docker-backend.js'
import { listContainers, provisionContainer } from './provision.js'

const execFileAsync = promisify(execFile)

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
  get(id: string): { id: string; type: string; docker?: { containerId?: string; image?: string; mode?: string; resources?: { cpus?: number; memoryMB?: number } } } | undefined
}

interface SshExecutorLike {
  exec(argv: string[], cwd: string, env?: Record<string, string>, stdinData?: Buffer): Promise<{ code: number; stdout: string; stderr: string }>
}

function localRunner(): HostCommandRunner {
  return {
    run: async (argv) => {
      try {
        const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), { maxBuffer: 10 * 1024 * 1024 })
        return { code: 0, stdout, stderr }
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string }
        return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)) }
      }
    },
  }
}

function sshRunner(executor: SshExecutorLike): HostCommandRunner {
  return {
    run: async (argv, cwd) => executor.exec(argv, cwd ?? '/'),
  }
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

        const isRemote = node.type === 'remote-docker'
        const runner = isRemote
          ? await (async () => {
              const sshWorlds = ctx.get('dshbSshWorlds') as { ensure(nodeId: string): Promise<{ executor: SshExecutorLike } | undefined> } | undefined
              const sshWorld = await sshWorlds?.ensure(nodeId)
              if (!sshWorld) return undefined
              return sshRunner(sshWorld.executor)
            })()
          : localRunner()

        if (!runner) {
          sendJson(res, 503, { ok: false, error: '节点执行世界未就绪' })
          return
        }

        if (req.method === 'GET' && action === 'containers') {
          const containers = await listContainers(runner)
          sendJson(res, 200, { ok: true, containers })
          return
        }

        if (req.method === 'POST' && action === 'provision') {
          const body = await readBody(req)
          const image = String(body?.image ?? '')
          if (!image) {
            sendJson(res, 400, { ok: false, error: '需要 image' })
            return
          }
          try {
            const result = await provisionContainer(runner, {
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

        sendJson(res, 404, { ok: false, error: 'not found' })
      },
    }),
  )
}
