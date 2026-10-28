import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncScheduler } from '../../src/core/sync/scheduler.js'
import type { SyncPeer, SyncPeerView } from '../../src/core/sync/model.js'
import type { SyncPeerChangeListener } from '../../src/core/sync/peer-manager.js'

const basePeer: SyncPeerView = {
  id: 'p-0123456789abcdef01234567',
  name: 'Scheduled peer',
  host: 'sync.example.com',
  port: 22,
  username: 'sync',
  authKind: 'password',
  direction: 'pull',
  schedule: 'every-5m',
  syncSessions: false,
  enabled: true,
  hasSecret: { hasPassword: true, hasKey: false, hasPassphrase: false },
}

class FakePeerManager {
  private current: SyncPeerView[]
  private readonly listeners = new Set<SyncPeerChangeListener>()

  constructor(peers: SyncPeerView[]) {
    this.current = peers
  }

  async list(): Promise<SyncPeerView[]> {
    return this.current.map((peer) => ({ ...peer }))
  }

  subscribe(listener: SyncPeerChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setPeer(id: string, peer?: SyncPeer): void {
    this.current = this.current.filter((item) => item.id !== id)
    if (peer) this.current.push({ ...peer, hasSecret: basePeer.hasSecret })
    for (const listener of this.listeners) listener(id, peer)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SyncScheduler', () => {
  it('runs enabled every-5m peers on the interval and stops after disable/removal', async () => {
    vi.useFakeTimers()
    const manager = new FakePeerManager([basePeer])
    const coordinator = { run: vi.fn(async () => ({})) }
    const scheduler = new SyncScheduler(manager as never, coordinator as never, 300_000)
    const stop = scheduler.start()

    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(coordinator.run).toHaveBeenCalledTimes(1)

    manager.setPeer(basePeer.id, { ...basePeer, enabled: false })
    expect(vi.getTimerCount()).toBe(0)
    manager.setPeer(basePeer.id, { ...basePeer, enabled: true })
    expect(vi.getTimerCount()).toBe(1)
    manager.setPeer(basePeer.id)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(coordinator.run).toHaveBeenCalledTimes(1)

    stop()
  })

  it('does not schedule manual peers and schedules them after switching to every-5m', async () => {
    vi.useFakeTimers()
    const manager = new FakePeerManager([{ ...basePeer, schedule: 'manual' }])
    const coordinator = { run: vi.fn(async () => ({})) }
    const scheduler = new SyncScheduler(manager as never, coordinator as never, 300_000)
    const stop = scheduler.start()

    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(coordinator.run).not.toHaveBeenCalled()

    manager.setPeer(basePeer.id, { ...basePeer, schedule: 'every-5m' })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(coordinator.run).toHaveBeenCalledTimes(1)
    stop()
  })

  it('keeps independent timers for multiple peers', async () => {
    vi.useFakeTimers()
    const secondPeer = { ...basePeer, id: 'p-1123456789abcdef01234567', name: 'Second peer' }
    const manager = new FakePeerManager([basePeer, secondPeer])
    const coordinator = { run: vi.fn(async () => ({})) }
    const scheduler = new SyncScheduler(manager as never, coordinator as never, 300_000)
    const stop = scheduler.start()

    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(coordinator.run).toHaveBeenCalledTimes(2)
    expect(coordinator.run).toHaveBeenCalledWith(basePeer.id)
    expect(coordinator.run).toHaveBeenCalledWith(secondPeer.id)
    stop()
  })
})
