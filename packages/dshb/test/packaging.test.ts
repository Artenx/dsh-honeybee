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
      dsh: { compatibility: { dshReleases: Record<string, string> } }
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }

    expect(pkg.dsh.compatibility.dshReleases).toEqual({ '0.1.5-rc.1': 'compatible' })
    expect(pkg.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-client-runtime')
    expect(pkg.devDependencies).toHaveProperty('@deepseek-ai/dsh-client-runtime')
  })
})
