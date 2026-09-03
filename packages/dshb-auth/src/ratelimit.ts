const WINDOW_MS = 30_000
const MAX_FAILURES = 5

interface Entry {
  failures: number
  lockedUntil: number
}

export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>()

  isLocked(ip: string, now = Date.now()): boolean {
    const entry = this.entries.get(ip)
    if (!entry) return false
    if (entry.lockedUntil > now) return true
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) this.entries.delete(ip)
    return false
  }

  recordFailure(ip: string, now = Date.now()): void {
    const entry = this.entries.get(ip) ?? { failures: 0, lockedUntil: 0 }
    entry.failures += 1
    if (entry.failures >= MAX_FAILURES) {
      entry.lockedUntil = now + WINDOW_MS
      entry.failures = 0
    }
    this.entries.set(ip, entry)
    this.sweep(now)
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip)
  }

  private sweep(now: number): void {
    if (this.entries.size < 1024) return
    for (const [ip, entry] of this.entries) {
      if (entry.lockedUntil <= now) this.entries.delete(ip)
    }
  }
}
