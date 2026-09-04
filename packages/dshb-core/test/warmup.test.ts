import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../src/index.js'

const TMP_HOME = '/tmp/dshb-test-warmup'
const REMOTE_NODE = 'nd08f171b21a2'

function writeFixture(): void {
  mkdirSync(join(TMP_HOME, 'dshb'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(TMP_HOME, 'dshb', 'nodes.json'),
    JSON.stringify(
      [
        { id: 'local', name: '本地环境', type: 'local-host', createdAt: '', updatedAt: '' },
        {
          id: REMOTE_NODE,
          name: '38',
          type: 'remote-ssh',
          ssh: { host: '38.76.209.172', port: 22, username: 'root', auth: { kind: 'password' } },
          createdAt: '',
          updatedAt: '',
        },
      ],
      null,
      2,
    ),
    { mode: 0o600 },
  )
  writeFileSync(
    join(TMP_HOME, 'dshb', 'workspace-bindings.json'),
    JSON.stringify([{ mirrorPath: join(TMP_HOME, 'dshb', 'mirrors', REMOTE_NODE, 'home'), nodeId: REMOTE_NODE, remotePath: '/home/' }], null, 2),
    { mode: 0o600 },
  )
}

describe('重启后预热激活持久化 bindings 对应的世界（world not available 修复）', () => {
  beforeEach(() => {
    process.env.DSH_HOME = TMP_HOME
    writeFixture()
  })
  afterEach(() => {
    try { rmSync(TMP_HOME, { recursive: true, force: true }) } catch {}
  })

  it('启动时对 bindings 中的远程节点调用 ensure，避免 world not available', async () => {
    const ensured: string[] = []
    const services = new Map<string, unknown>()

    const mockWebServer = {
      register: () => () => {},
    }

    const ctx = {
      webServer: mockWebServer,
      effect: (fn: () => unknown) => fn() as never,
      provide: (name: string, value: unknown) => void services.set(name, value),
      get: (name: string) => services.get(name),
      credentials: {
        readRecord: async () => undefined,
        modifyRecord: async () => ({ kind: 'grant', payload: {} }),
        deleteRecord: async () => {},
      },
    } as never

    services.set('dshbWorlds', {
      ensure: async (nodeId: string) => {
        ensured.push(nodeId)
        return {}
      },
    })

    apply(ctx)

    await new Promise((r) => setTimeout(r, 20))

    expect(ensured).toContain(REMOTE_NODE)
    expect(ensured).not.toContain('local')
  })
})
