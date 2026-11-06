import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

describe('single-package distribution', () => {
  it('installs only packages/dshb from source scripts', () => {
    const install = read('../../../scripts/install.sh')
    const bootstrap = read('../../../scripts/bootstrap.sh')
    const legacyPackages = ['dshb-auth', 'dshb-core', 'dshb-router', 'dshb-exec-ssh', 'dshb-exec-docker', 'dshb-ui']

    expect(install).toContain('$REPO/packages/dshb')
    expect(bootstrap).toContain('$SRC/packages/dshb')
    for (const packageName of legacyPackages) {
      expect(install).not.toContain(`packages/${packageName}`)
      expect(bootstrap).not.toContain(`packages/${packageName}`)
    }
  })

  it('declares only verified DSH compatibility and no type-only runtime peer', () => {
    const pkg = JSON.parse(read('../package.json')) as {
      version: string
      engines: { dsh: string }
      dsh: { compatibility: { dshReleases: string; nodeVersions: string } }
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }

    expect(pkg.version).toBe('0.1.50')
    expect(pkg.dsh.compatibility.dshReleases).toBe(pkg.engines.dsh)
    expect(pkg.engines.dsh).toContain('>=0.2.2-rc.1 <0.2.3')
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toContain('>=0.2.2-rc.1 <0.2.3')
    }
    expect(pkg.dsh.compatibility.nodeVersions).toBe('>=22.13')
    expect(pkg.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-client-runtime')
    expect(pkg.devDependencies).toHaveProperty('@deepseek-ai/dsh-client-runtime')
  })

  it('patch keeps the upstream web-startup provider untouched', () => {
    // webserver 行 inject: [webStartup]：运行时启用/停用的补丁重载一旦更换
    // webStartup 提供者，webServer 会被连带销毁重建，拆断桌面端正在使用的
    // 连接（0.1.33 及之前桌面端"启用即断连"的根因）。补丁必须只做插入。
    const patchLines = read('../cordis.patch.yml')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
    for (const line of patchLines) {
      expect(line).not.toContain('disabled:')
      expect(line).not.toContain('web-startup')
      expect(line).not.toContain('dshb-web-startup')
    }
    expect(read('../cordis.patch.yml')).toContain('id: dshb-auth')
  })

  it('exports the bundled plugin entry points and client patch metadata', () => {
    const pkg = JSON.parse(read('../package.json')) as {
      exports: Record<string, string>
      files: string[]
      dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } }
    }

    expect(pkg.exports['.']).toBe('./lib/index.js')
    expect(pkg.exports['./core']).toBe('./lib/core/index.js')
    expect(pkg.exports['./client']).toBe('./lib/client.js')
    expect(pkg.files).toContain('lib')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-settings')
  })

  it('yields the mobile drawer to the upstream native drawer (dsh >= 0.2.2)', () => {
    // 0.2.2 起 AppFrame 自带 data-sidebar-drawer 抽屉且 centerCol 固定 grid-area:1/2；
    // dshb 若继续强设 grid-template-columns: minmax(0,1fr) 0 0，第 2 列会被压成 0 宽，
    // 手机端会话区整体移出屏幕（白屏根因）。客户端必须：探测上游抽屉 -> 改打
    // frame-native 标记（不触发 dshb 抽屉 CSS）-> 停用 dshb 切换按钮/遮罩。
    const client = read('../lib/client.js')

    expect(client).toContain('data-sidebar-drawer')
    expect(client).toContain('frame-native')
    // 探测函数必须扫描 style 标签而非仅 matchMedia，避免上游 CSS 晚注入时漏判
    expect(client).toMatch(/querySelectorAll\((["'])style\1\)/)
    // 切换按钮与 FAB/遮罩必须在上游抽屉存在时退场（防双按钮/双遮罩）
    expect(client).toContain('if (native) return null')
    expect(client).toMatch(/upstreamHandlesDrawer\(\) ?\|\| ?!narrow\.matches/)
    expect(client.match(/upstreamHandlesDrawer/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})
