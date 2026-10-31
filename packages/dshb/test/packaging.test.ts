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

    expect(pkg.version).toBe('0.1.23')
    expect(pkg.engines.dsh).toBe('>=0.1.7-rc.1 <0.2.2-rc.1')
    expect(pkg.dsh.compatibility.dshReleases).toBe(pkg.engines.dsh)
    expect(pkg.dsh.compatibility.nodeVersions).toBe('>=22.13')
    expect(pkg.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-client-runtime')
    expect(pkg.devDependencies).toHaveProperty('@deepseek-ai/dsh-client-runtime')
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
})
