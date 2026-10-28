import { SyncCoordinator } from './coordinator.js'
import { SyncPeerManager, type SyncPeerView } from './peer-manager.js'
import type { SyncPeer } from './model.js'

export const SYNC_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000

export class SyncScheduler {
  constructor(
    private readonly peers: SyncPeerManager,
    private readonly coordinator: SyncCoordinator,
    private readonly intervalMs = SYNC_SCHEDULE_INTERVAL_MS,
  ) {}

  start(): () => void {
    const timers = new Map<string, ReturnType<typeof setInterval>>()
    let stopped = false
    let generation = 0
    let refreshNeeded = false
    let refreshing: Promise<void> | undefined

    const clearTimer = (peerId: string): void => {
      const timer = timers.get(peerId)
      if (!timer) return
      clearInterval(timer)
      timers.delete(peerId)
    }

    const configure = (peer: Pick<SyncPeer, 'id' | 'enabled' | 'schedule'>): void => {
      if (!peer.enabled || peer.schedule !== 'every-5m') {
        clearTimer(peer.id)
        return
      }
      if (timers.has(peer.id)) return
      const timer = setInterval(() => {
        void this.coordinator.run(peer.id).catch(() => {})
      }, this.intervalMs)
      timers.set(peer.id, timer)
    }

    const refresh = (): void => {
      if (stopped) return
      refreshNeeded = true
      if (refreshing) return
      refreshing = (async () => {
        while (refreshNeeded && !stopped) {
          refreshNeeded = false
          const observedGeneration = generation
          let peers: SyncPeerView[]
          try {
            peers = await this.peers.list()
          } catch {
            break
          }
          if (observedGeneration !== generation) {
            refreshNeeded = true
            continue
          }
          const liveIds = new Set(peers.map((peer) => peer.id))
          for (const peerId of timers.keys()) {
            if (!liveIds.has(peerId)) clearTimer(peerId)
          }
          for (const peer of peers) configure(peer)
        }
      })().finally(() => {
        refreshing = undefined
        if (refreshNeeded && !stopped) refresh()
      })
    }

    const unsubscribe = this.peers.subscribe((peerId, peer) => {
      generation += 1
      if (peer) configure(peer)
      else clearTimer(peerId)
      refresh()
    })
    refresh()

    return () => {
      if (stopped) return
      stopped = true
      unsubscribe()
      for (const timer of timers.values()) clearInterval(timer)
      timers.clear()
    }
  }
}
