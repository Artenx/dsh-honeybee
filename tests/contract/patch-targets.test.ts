import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

interface PatchTarget {
  id: string
  name: string
  purpose: string
}

const PATCH_TARGETS: PatchTarget[] = [
  { id: 'web-startup', name: '@deepseek-ai/dsh-web-app/startup', purpose: '认证与网络绑定替换点（需求 1）' },
  { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local', purpose: '执行世界路由器插入点（需求 6）' },
  { id: 'bash-sandbox', name: '@deepseek-ai/dsh-bash-sandbox', purpose: '执行世界路由器插入点（需求 6）' },
  { id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox', purpose: '执行世界路由器插入点（需求 6）' },
  { id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-auto', purpose: '节点感知 occupant 替换点（需求 5）' },
]

let dump = ''

beforeAll(async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dshb-contract-'))
  const { stdout } = await execFileAsync('npx', ['dsh', '--profile', 'web', '--dump-config'], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, DSH_HOME: dshHome },
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  })
  dump = stdout
}, 150000)

describe('patch 目标行契约（设计文档：patch 层三处替换）', () => {
  for (const target of PATCH_TARGETS) {
    it(`上游 web profile 存在 id=${target.id}（${target.purpose}）`, () => {
      const row = new RegExp(`^- id: ${target.id}\\n\\s+name: '?${target.name.replace(/[/.]/g, '\\$&')}'?`, 'm')
      expect(dump).toMatch(row)
    })
  }
})
