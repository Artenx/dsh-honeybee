# Hybrid Logical Clock

`SyncRevision` 将墙钟时间、逻辑计数器和写入实例身份组合为可持久化版本：

```ts
interface SyncRevision {
  physicalTimeMs: number
  logicalCounter: number
  writerInstanceId: string
}
```

`HybridLogicalClock.tick()` 在本机时间前进时更新物理时间；当本机时间回退或相同则递增逻辑计数器。`observe()` 合并远端 revision，使后续本机变更严格晚于已观察版本。

冲突排序使用 `(physicalTimeMs, logicalCounter, writerInstanceId)` 字典序，最后一项提供确定性平局裁决。`SyncStateStore` 持久化 HLC snapshot，使进程重启后仍保持单调性。
