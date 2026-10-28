export interface SyncRevision {
  physicalTimeMs: number
  logicalCounter: number
  writerInstanceId: string
}

export interface HlcSnapshot {
  physicalTimeMs: number
  logicalCounter: number
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
}

function assertWriterId(value: string): void {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('writerInstanceId is invalid')
}

export function compareSyncRevision(a: SyncRevision, b: SyncRevision): number {
  if (a.physicalTimeMs !== b.physicalTimeMs) return a.physicalTimeMs < b.physicalTimeMs ? -1 : 1
  if (a.logicalCounter !== b.logicalCounter) return a.logicalCounter < b.logicalCounter ? -1 : 1
  if (a.writerInstanceId === b.writerInstanceId) return 0
  return a.writerInstanceId < b.writerInstanceId ? -1 : 1
}

export class HybridLogicalClock {
  private physicalTimeMs: number
  private logicalCounter: number

  constructor(
    private readonly writerInstanceId: string,
    snapshot: HlcSnapshot = { physicalTimeMs: 0, logicalCounter: 0 },
  ) {
    assertWriterId(writerInstanceId)
    assertTimestamp(snapshot.physicalTimeMs, 'physicalTimeMs')
    assertTimestamp(snapshot.logicalCounter, 'logicalCounter')
    this.physicalTimeMs = snapshot.physicalTimeMs
    this.logicalCounter = snapshot.logicalCounter
  }

  tick(now = Date.now()): SyncRevision {
    assertTimestamp(now, 'now')
    if (now > this.physicalTimeMs) {
      this.physicalTimeMs = now
      this.logicalCounter = 0
    } else {
      this.incrementCounter()
    }
    return this.current()
  }

  observe(remote: SyncRevision, now = Date.now()): SyncRevision {
    assertTimestamp(now, 'now')
    assertTimestamp(remote.physicalTimeMs, 'remote.physicalTimeMs')
    assertTimestamp(remote.logicalCounter, 'remote.logicalCounter')
    assertWriterId(remote.writerInstanceId)

    const localTime = this.physicalTimeMs
    const maxTime = Math.max(now, localTime, remote.physicalTimeMs)
    let logicalCounter: number
    if (maxTime === localTime && maxTime === remote.physicalTimeMs) {
      logicalCounter = Math.max(this.logicalCounter, remote.logicalCounter) + 1
    } else if (maxTime === localTime) {
      if (this.logicalCounter === Number.MAX_SAFE_INTEGER) throw new Error('HLC logical counter exhausted')
      logicalCounter = this.logicalCounter + 1
    } else if (maxTime === remote.physicalTimeMs) {
      logicalCounter = remote.logicalCounter + 1
    } else {
      logicalCounter = 0
    }
    assertTimestamp(logicalCounter, 'logicalCounter')
    this.physicalTimeMs = maxTime
    this.logicalCounter = logicalCounter
    return this.current()
  }

  snapshot(): HlcSnapshot {
    return { physicalTimeMs: this.physicalTimeMs, logicalCounter: this.logicalCounter }
  }

  private incrementCounter(): void {
    if (this.logicalCounter === Number.MAX_SAFE_INTEGER) throw new Error('HLC logical counter exhausted')
    this.logicalCounter += 1
  }

  private current(): SyncRevision {
    return {
      physicalTimeMs: this.physicalTimeMs,
      logicalCounter: this.logicalCounter,
      writerInstanceId: this.writerInstanceId,
    }
  }
}
