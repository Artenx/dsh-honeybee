import { createConnection } from 'node:net'
import type { NodeRegistry, NodeSsh, NodeTestReport } from './node-registry.js'

export interface SshHandshakeTester {
  test(
    target: { host: string; port: number; username: string; auth: NodeSsh['auth']; jump?: NodeSsh['jump'] },
    secrets: { password?: string; privateKey?: string; passphrase?: string },
  ): Promise<{ ok: boolean; error?: string; category?: string }>
}

export function testReachability(host: string, port: number, timeoutMs = 5000): Promise<NodeTestReport> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (report: NodeTestReport) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(report)
    }
    const socket = createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ ok: true, reachable: true }))
    socket.once('timeout', () => finish({ ok: false, reachable: false, error: 'connection timed out' }))
    socket.once('error', (err) =>
      finish({ ok: false, reachable: false, error: err instanceof Error ? err.message : String(err) }),
    )
  })
}

export interface NodeTestOverrides {
  ssh?: NodeSsh
  secrets?: { password?: string; privateKey?: string; passphrase?: string }
}

export interface DockerNodeTester {
  test(node: { id: string; type: string; ssh?: NodeSsh; docker?: { containerId?: string; image?: string } }): Promise<NodeTestReport>
}

export async function testNode(
  registry: NodeRegistry,
  id: string,
  sshTester?: SshHandshakeTester,
  overrides?: NodeTestOverrides,
  dockerTester?: DockerNodeTester,
): Promise<NodeTestReport> {
  const node = registry.get(id)
  if (!node) return { ok: false, error: `node ${id} not found` }
  if (node.type === 'local-host') {
    registry.setStatus(id, { reachable: true, lastCheckedAt: new Date().toISOString() })
    return { ok: true, reachable: true }
  }
  if (node.type === 'local-docker') {
    let report: NodeTestReport
    if (dockerTester) {
      report = await dockerTester.test({ id: node.id, type: node.type, docker: node.docker })
    } else {
      report = { ok: true, reachable: true }
    }
    registry.setStatus(id, {
      reachable: report.reachable,
      lastCheckedAt: new Date().toISOString(),
      error: report.error,
    })
    return report
  }
  if (node.type === 'remote-ssh' || node.type === 'remote-docker') {
    const ssh = overrides?.ssh ?? node.ssh
    if (!ssh) return { ok: false, error: 'node has no ssh config' }
    let report: NodeTestReport
    if (sshTester) {
      const savedSecrets = (await registry.getSecrets(id)) ?? {}
      const secrets = overrides?.secrets
        ? {
            password: overrides.secrets.password || savedSecrets.password,
            privateKey: overrides.secrets.privateKey || savedSecrets.privateKey,
            passphrase: overrides.secrets.passphrase || savedSecrets.passphrase,
          }
        : savedSecrets
      const t = await sshTester.test(
        { host: ssh.host, port: ssh.port, username: ssh.username, auth: ssh.auth, jump: ssh.jump },
        secrets,
      )
      report = { ok: t.ok, reachable: t.ok, error: t.error, ...(t.category ? { category: t.category } : {}) }
    } else {
      report = await testReachability(ssh.host, ssh.port)
    }
    if (report.ok && node.type === 'remote-docker' && dockerTester) {
      report = await dockerTester.test({ id: node.id, type: node.type, ssh, docker: node.docker })
    }
    registry.setStatus(id, {
      reachable: report.reachable,
      lastCheckedAt: new Date().toISOString(),
      error: report.error,
    })
    return report
  }
  return { ok: false, error: 'unsupported node type' }
}
