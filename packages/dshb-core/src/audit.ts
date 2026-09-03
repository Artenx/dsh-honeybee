import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AuditEntry {
  time: string
  nodeId: string
  op: 'exec' | 'write' | 'remove' | 'move' | 'provision' | 'connect'
  target: string
  result: string
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export class AuditLogger {
  private file(): string {
    return join(dshHome(), 'dshb', 'audit.log')
  }

  log(nodeId: string, op: AuditEntry['op'], target: string, result: string): void {
    try {
      const file = this.file()
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
      const entry: AuditEntry = { time: new Date().toISOString(), nodeId, op, target, result }
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch {}
  }
}

let shared: AuditLogger | null = null

export function sharedAuditLogger(): AuditLogger {
  if (!shared) shared = new AuditLogger()
  return shared
}
