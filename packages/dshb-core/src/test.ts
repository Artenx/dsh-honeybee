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

export async function testNode(registry: NodeRegistry, id: string, sshTester?: SshHandshakeTester): Promise<NodeTestReport> {
  const node = registry.get(id)
  if (!node) return { ok: false, error: `node ${id} not found` }
  if (node.type === 'local-host') {
    registry.setStatus(id, { reachable: true, lastCheckedAt: new Date().toISOString() })
    return { ok: true, reachable: true }
  }
  if (node.type === 'remote-ssh' || node.type === 'remote-docker') {
    if (!node.ssh) return { ok: false, error: 'node has no ssh config' }
    let report: NodeTestReport
    if (sshTester) {
      const secrets = (await registry.getSecrets(id)) ?? {}
      const t = await sshTester.test(
        { host: node.ssh.host, port: node.ssh.port, username: node.ssh.username, auth: node.ssh.auth, jump: node.ssh.jump },
        secrets,
      )
      report = { ok: t.ok, reachable: t.ok, error: t.error, ...(t.category ? { category: t.category } : {}) }
    } else {
      report = await testReachability(node.ssh.host, node.ssh.port)
    }
    registry.setStatus(id, {
      reachable: report.reachable,
      lastCheckedAt: new Date().toISOString(),
      error: report.error,
    })
    return report
  }
  if (node.type === 'local-docker') {
    registry.setStatus(id, { reachable: true, lastCheckedAt: new Date().toISOString() })
    return { ok: true, reachable: true }
  }
  return { ok: false, error: 'unsupported node type' }
}
