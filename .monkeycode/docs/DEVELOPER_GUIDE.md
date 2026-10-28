# 开发指南

## 环境

- Node.js `>=22.13`
- pnpm workspace

## 构建与验证

```bash
# 构建 DSHB 包
pnpm --filter @artenx/dshb run build

# 运行全仓测试
pnpm test

# 运行节点、会话、离线归档、协议、host-key、peer 和表单定向测试
pnpm exec vitest run packages/dshb/test/core/sync-*.test.ts packages/dshb/test/core/workspace-instructions.test.ts packages/dshb/test/client

# 运行 TypeScript 类型检查
pnpm --filter @artenx/dshb run typecheck
```

`pnpm --filter @artenx/dshb run typecheck` 当前通过。`RouterFileSystem` 的文件类型从沙箱基类方法签名派生，避免 pnpm peer variant 下重复 branded `dsh-fs` 声明产生类型冲突。

## 同步状态开发约定

- 持久化状态置于 `DSH_HOME/dshb/`，敏感凭据不写入 `sync-peers.json` 或 `sync-state.json`。
- Peer 配置进入存储前必须经过 `parseSyncPeer()`。
- Peer API 只接受嵌套 `secrets` 字段；视图响应始终使用 `hasSecret` 布尔值。
- UI 编辑 peer 时只展示秘密的保存状态；空输入代表保留既有秘密值。
- HLC 版本通过 `SyncStateStore.nextRevision()` 创建；应用远端版本后通过 `observeRevision()` 合并时钟。
- 状态解析失败时保留原文件并报错，禁止默默生成新的 instance ID 或空状态。
- 运行测试使用独立临时 DSH_HOME，清理由测试夹具完成。
- `.dshb-sync` 密码不得写入 credentials、日志或归档 header；上传密码只经短时单次 token 保存在服务端内存。
- 离线导入必须先完成 GCM、ZIP 路径/大小/CRC、manifest 摘要、引用和磁盘空间验证，再调用 node/session apply pipeline。
