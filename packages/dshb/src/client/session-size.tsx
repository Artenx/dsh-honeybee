import { useSyncExternalStore, type ReactElement } from 'react'

type SizeSnapshot =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'unpersisted' }
  | { status: 'unknown' }
  | { status: 'ready'; bytes: number }

const LOADING: SizeSnapshot = { status: 'loading' }
const UNAVAILABLE: SizeSnapshot = { status: 'unavailable' }
const UNPERSISTED: SizeSnapshot = { status: 'unpersisted' }
const UNKNOWN: SizeSnapshot = { status: 'unknown' }
const sizes = new Map<string, SizeSnapshot>()
const listeners = new Set<() => void>()
let loaded = false
let failed = false
let request: Promise<void> | undefined
let timer: ReturnType<typeof setInterval> | undefined

function notify(): void {
  for (const listener of listeners) listener()
}

async function loadSizes(): Promise<void> {
  if (request) return request
  request = (async () => {
    try {
      const response = await fetch('/api/dshb/sync/session-sizes')
      const data = await response.json() as {
        ok?: boolean
        sessions?: Array<{ sessionId: string; sizeBytes?: number }>
      }
      if (!response.ok || !data.ok || !Array.isArray(data.sessions)) throw new Error('session sizes unavailable')
      sizes.clear()
      for (const session of data.sessions) {
        if (typeof session.sessionId !== 'string') continue
        sizes.set(session.sessionId, Number.isSafeInteger(session.sizeBytes) && session.sizeBytes! >= 0
          ? { status: 'ready', bytes: session.sizeBytes! }
          : UNKNOWN)
      }
      loaded = true
      failed = false
    } catch {
      loaded = true
      failed = true
    } finally {
      request = undefined
      notify()
    }
  })()
  return request
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    void loadSizes()
    timer = setInterval(() => { void loadSizes() }, 30_000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

function snapshot(sessionId: string): SizeSnapshot {
  const found = sizes.get(sessionId)
  if (found) return found
  if (!loaded) return LOADING
  return failed ? UNAVAILABLE : UNPERSISTED
}

function useSessionSize(sessionId: string): SizeSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot(sessionId), () => LOADING)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function compactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const units = ['K', 'M', 'G', 'T']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${Math.round(value)}${units[unit]}`
}

function sizeLabel(size: SizeSnapshot): string {
  if (size.status === 'ready') return formatBytes(size.bytes)
  if (size.status === 'unpersisted') return '未落盘'
  if (size.status === 'loading') return '读取中'
  return '未知'
}

export function SessionSizeLeading(props: { sessionId: string }): ReactElement {
  const size = useSessionSize(props.sessionId)
  const label = size.status === 'ready' ? compactBytes(size.bytes)
    : size.status === 'unpersisted' ? '未'
      : size.status === 'loading' ? '…' : '?'
  return (
    <span title={`会话文件大小：${sizeLabel(size)}${size.status === 'ready' ? `（${size.bytes} 字节）` : ''}`}
      aria-label={`会话文件大小：${sizeLabel(size)}`}
      style={{ display: 'block', maxWidth: 16, overflow: 'visible', font: '8px/16px ui-monospace, SFMono-Regular, monospace', textAlign: 'center', whiteSpace: 'nowrap', opacity: 0.72 }}>
      {label}
    </span>
  )
}

export function SessionSizeHover(props: { sessionId: string }): ReactElement {
  const size = useSessionSize(props.sessionId)
  return <span>文件大小：{sizeLabel(size)}{size.status === 'ready' ? `（${size.bytes} 字节）` : ''}</span>
}
