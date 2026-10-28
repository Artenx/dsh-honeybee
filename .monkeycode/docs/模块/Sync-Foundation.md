# 同步基础模块

## 职责

同步模块定义 peer 配置、来源实体、HLC revision 和跨实例状态存储，并实现 peer 管理 API、SSH host-key 信任、有界帧传输、节点/会话协调、会话冲突归档、手动运行、定时调度与加密离线配置迁移。

## 文件

- `packages/dshb/src/core/sync/model.ts`：peer 配置、来源身份、记录元数据和运行时校验。
- `packages/dshb/src/core/sync/revision.ts`：revision 比较与 Hybrid Logical Clock。
- `packages/dshb/src/core/sync/stores.ts`：安全 JSON 持久化、instance ID、peer store 和 sync state store。
- `packages/dshb/src/core/sync/peer-manager.ts`：peer CRUD、credentials grant 与安全视图。
- `packages/dshb/src/core/sync/routes.ts`：`/api/dshb/sync/peers` CRUD 路由。
- `packages/dshb/src/core/sync/host-key.ts`、`ssh-transport.ts`：host key pin/challenge、SSH verifier、通用 framed session 和 helper handshake。
- `packages/dshb/src/core/sync/protocol.ts`、`remote-helper.ts`、`internal-routes.ts`：控制/数据帧、固定远端 loopback helper 和握手 endpoint。
- `packages/dshb/src/core/sync/node-sync.ts`：节点配置快照、HLC 更新、来源映射、幂等导入、tombstone 和 pending removal。
- `packages/dshb/src/core/sync/coordinator.ts`：方向过滤、双向 HLC 裁决、peer 锁、一次瞬时传输重试和成功水位提交。
- `packages/dshb/src/core/sync/session-sync.ts`：会话稳定快照、远程工作区映射、对象引用重写、journal 批次提交、LWW 分支归档和恢复。
- `packages/dshb/src/core/sync/session-journal.ts`：待处理会话批次、bundle/prepared 暂存与启动恢复索引。
- `packages/dshb/src/core/sync/session-routes.ts`：会话归档列表和恢复 API。
- `packages/dshb/src/core/sync/offline-archive.ts`、`offline-journal.ts`、`offline-routes.ts`：scrypt/AES-GCM `.dshb-sync`、ZIP/manifest 校验、流式解密 staging、空间/冲突预检、节点/会话阶段恢复和单次上传令牌。
- `packages/dshb/src/core/sync/scheduler.ts`：启用的 `every-5m` peer 进程内调度及 peer 更新/删除时的 timer 生命周期。
- `packages/dshb/src/core/sync/routes.ts`：peer CRUD、SSH trust/probe 和手动 run API。
- `packages/dshb/src/client/sync-peers.tsx`、`sync-peer-form.ts`：同步 peer 设置表单与纯表单模型。
- `packages/dshb/test/core/sync-foundation.test.ts`、`sync-peer-manager.test.ts`、`sync-protocol.test.ts`、`sync-host-key.test.ts`、`sync-internal-routes.test.ts`、`sync-remote-helper.test.ts`、`sync-ssh-transport.test.ts`、`sync-node.test.ts`、`sync-coordinator.test.ts`、`sync-scheduler.test.ts`、`packages/dshb/test/client/sync-peer-form.test.ts`：持久化、API、凭据脱敏、协议、host-key、manifest、方向裁决、互斥、watermark、timer 和表单测试。
- `packages/dshb/test/core/sync-node.test.ts`：节点过滤、同名来源隔离、版本更新、tombstone 和 workspace 解绑清理测试。
- `packages/dshb/test/core/sync-session.test.ts`、`sync-session-routes.test.ts`：会话映射、spill/附件、幂等、冲突归档/恢复、边界校验和中断恢复。
- `packages/dshb/test/core/sync-offline-archive.test.ts`、`sync-offline-routes.test.ts`、`sync-instance-integration.test.ts`、`sync-ssh-auth-integration.test.ts`：离线包往返、错误密码、密文篡改、ZIP 路径/膨胀限制、会话选项、一次性上传令牌、A→B→C 回环去重与 loopback SSH 密码/私钥认证。
- `packages/dshb/src/client/sync-offline.tsx`：设置页离线导入/导出表单、会话选项、密码与状态反馈。

## 存储行为

Peer 与状态 JSON 通过同目录临时文件及原子重命名更新，文件权限设为 `0600`。稳定实例 ID 使用独占创建；存在但格式损坏时保留文件并报错。`SyncStateStore.update()` 对副本执行变更，验证成功并落盘后才替换内存状态。

同步 peer 的 SSH 凭据存入 DSH credentials 的 `dshb-core/<peerId>` grant record。API 和表单只读取保存状态；更换 auth kind 会清理旧 auth kind 的秘密字段。

节点 manifest 只包含非默认 SSH/Docker 节点。SSH keyPath 会从跨实例 profile 中剔除；可迁移的密码/私钥随记录传入目标 credentials，缺少可迁移凭据时保留 `credentialsRequired` 状态。

节点导出、导入、删除和 pending-removal 清理通过 `SyncNodeService` mutation queue 串行执行。待删除 tombstone 先持久化为 pending，再检查活动绑定并清理；workspace bind 在远端目录准备后再次校验 pending 状态，阻止并发绑定跨过删除边界。

`SyncCoordinator` 对同一 peer 共享一个 in-flight Promise。瞬时 SSH network/timeout/helper 错误当前作业重试一次；失败状态保留之前的 `lastSuccessAt` 和 `watermark`。会话通过独立 journal 管理；bundle 在 journal batch 登记前先原子暂存，prepared 数据与 bundle 校验后按幂等方式写入，重放时先恢复 pending batch，再导出当前 workspace session，避免导入记录丢失 origin。重放会重建 membership 与 workspace 顺序；删除 peer 不清除已有待恢复 bundle。启动时逐批恢复并清理未登记的 staging。工作区映射键包含来源 workspace 与 remotePath，避免同一来源 workspace 的多路径映射相互覆盖。

## 离线归档行为

- 默认导出只有节点 manifest；启用会话选项后附加 session bundle。归档源只来自 `SyncNodeService.exportManifest()` 与 `SyncSessionService.exportBundle()`，因此本地节点、同步 peer 凭据和 Web 登录凭据不会入包。
- ZIP 文件名固定为 `manifest.json`、`nodes.json` 与可选 `sessions.json`。manifest 对每个 payload 保存字节数和 SHA-256，并枚举 origin/revision/tombstone 摘要。
- AES-256-GCM 使用 scrypt 派生密钥，参数固定为 `N=32768,r=8,p=1`；header 由 GCM AAD 认证。密文上传流式写入 staging，解密流在 tag 认证前只写入 staging，不会调用 apply 服务。
- ZIP parser 只接受 2–3 个预期文件，拒绝路径穿越、绝对路径、重复项、符号链接、CRC 不匹配、未知格式及超过 128 MiB 的展开内容；加密文件上限为 128 MiB，ZIP payload 会为 50 字节 header 和 16 字节 GCM tag 预留空间。节点/会话 revision 冲突、引用和保守磁盘空间估算均通过后才应用。
- 导入节点使用 `importedVia='offline'`，客户端按本地节点样式展示；会话保留 origin，并通过同一 journal/apply 路径支持中断恢复与同实例回环去重。
- 导入 API 将密码放入服务端短时内存 token；token 为随机单次值，五分钟过期，PUT 消费后不能重放。
- 节点 manifest 在每条 registry 写入后立即提交对应 provenance 与 HLC；后续条目失败时，已写入节点仍保留来源身份。
- `SyncSessionApplyResult.skipped` 是总跳过数，`unmapped` 是其中的原因分类；Coordinator 只将总跳过数计入 `skippedSessions`。
- 导入 workspace 时，远程节点存在性校验、workspace 创建、binding 和映射提交在 `SyncNodeService` mutation queue 内串行，避免节点删除跨过异步 workspace 创建窗口。

## 集成验证

`sync-instance-integration.test.ts` 通过三份独立 DSH_HOME 和实际 `SyncNodeService`、`SyncSessionService`、`SyncCoordinator` 验证 A→B→C 节点/会话转发及 C→A 回环去重；同文件也验证真实加密离线包的节点/会话导入和重复导入。`sync-ssh-auth-integration.test.ts` 在 loopback ephemeral port 启动 `ssh2.Server`，验证首次 host-key challenge、显式 pin、SSH password/public-key authentication 和固定 helper handshake。

## 使用顺序

1. 从 Cordis 获取 `syncPeerStore` 或 `syncStateStore`。
2. 创建/更新 peer 时通过 `SyncPeerStore`，不要将 SSH 秘密合并到 `SyncPeer`。
3. 首次需要来源身份时调用 `instanceId()`。
4. 生成本地 revision 使用 `nextRevision()`；接收远端 revision 后使用 `observeRevision()`。
