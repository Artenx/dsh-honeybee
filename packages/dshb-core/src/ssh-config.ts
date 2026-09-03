import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SshConfigEntry {
  alias: string
  host?: string
  port?: number
  username?: string
  identityFile?: string
  proxyJump?: string
}

function sshConfigPath(): string {
  return process.env.DSH_REMOTE_SSH_CONFIG ?? join(homedir(), '.ssh', 'config')
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export function parseSshConfig(content: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = []
  const lines = content.split(/\r?\n/)
  let current: SshConfigEntry | null = null

  for (const raw of lines) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const spaceIdx = line.search(/\s+/)
    if (spaceIdx < 0) continue
    const keyword = line.slice(0, spaceIdx).toLowerCase()
    const value = line.slice(spaceIdx).trim()

    if (keyword === 'host') {
      if (current) entries.push(current)
      current = { alias: value }
      continue
    }
    if (!current) continue
    switch (keyword) {
      case 'hostname':
        current.host = value
        break
      case 'port':
        current.port = parsePort(value, 22)
        break
      case 'user':
        current.username = value
        break
      case 'identityfile':
        current.identityFile = value.replace(/^~/, homedir())
        break
      case 'proxyjump':
        current.proxyJump = value
        break
    }
  }
  if (current) entries.push(current)
  return entries.filter((e) => !e.alias.includes('*') && !e.alias.includes('?') && !e.alias.includes('!'))
}

export function readSshConfig(): SshConfigEntry[] {
  try {
    return parseSshConfig(readFileSync(sshConfigPath(), 'utf8'))
  } catch {
    return []
  }
}

export function resolveSshConfigEntry(entry: SshConfigEntry): {
  host: string
  port: number
  username: string
  identityFile?: string
  proxyJump?: string
  hasProxyJump: boolean
  hasIdentityFile: boolean
} {
  return {
    host: entry.host ?? entry.alias,
    port: entry.port ?? 22,
    username: entry.username ?? '',
    identityFile: entry.identityFile,
    proxyJump: entry.proxyJump,
    hasProxyJump: Boolean(entry.proxyJump),
    hasIdentityFile: Boolean(entry.identityFile),
  }
}
