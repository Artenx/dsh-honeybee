import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'dshb_sid'
export const SESSION_MAX_AGE_SEC = 14 * 24 * 3600

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function issueSession(username: string, secret: Buffer): string {
  const payload = `${base64url(username)}.${Math.floor(Date.now() / 1000)}`
  return `${payload}.${sign(secret, payload)}`
}

export function verifySession(
  value: string | undefined,
  secret: Buffer,
  currentUsername: string,
): boolean {
  if (!value) return false
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const [b64user, iatText, sig] = parts
  const payload = `${b64user}.${iatText}`
  const expected = sign(secret, payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  const iat = Number(iatText)
  if (!Number.isInteger(iat)) return false
  if (Math.floor(Date.now() / 1000) - iat > SESSION_MAX_AGE_SEC) return false
  let username: string
  try {
    username = Buffer.from(b64user, 'base64url').toString('utf8')
  } catch {
    return false
  }
  return username === currentUsername
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
