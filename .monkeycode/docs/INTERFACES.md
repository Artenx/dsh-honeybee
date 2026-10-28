# 接口定义

## 工作节点

节点类型为 `local-host`、`local-docker`、`remote-ssh` 和 `remote-docker`。节点档案由 `NodeRegistry` 管理；秘密载荷通过 DSH credentials 保存，节点 API 只暴露存在性标识。

## 同步 Peer

`SyncPeer` 记录非秘密连接配置和该 peer 的同步策略：

```ts
interface SyncPeer {
  id: string
  name: string
  host: string
  port: number
  username: string
  authKind: 'password' | 'key'
  remoteDshHome?: string
  remoteProfile?: string
  remoteWebPort?: number
  direction: 'pull' | 'bidirectional'
  schedule: 'manual' | 'every-5m'
  syncSessions: boolean
  enabled: boolean
  hostKeyFingerprint?: string
}
```

`parseSyncPeer()` 验证必填字段、端口范围、枚举值和远端绝对路径；未声明字段会被拒绝，避免秘密误写入 peer 元数据。`SyncPeerStore` 提供 `list`、`get`、`create`、`update` 和 `remove`。

## 同步节点管理 API

现有路由由 DSHB WebServer 认证门保护：

- `GET /api/dshb/sync/peers`：列出 peer 元数据和 `hasSecret` 存在标识。
- `POST /api/dshb/sync/peers`：创建 peer，可选传入嵌套 `secrets`。
- `GET /api/dshb/sync/peers/:id`：读取单个 peer 和秘密存在标识。
- `PATCH /api/dshb/sync/peers/:id`：更新配置，可选轮换嵌套 `secrets`。
- `DELETE /api/dshb/sync/peers/:id`：删除 peer、凭据和该 peer 的同步进度。
- `POST /api/dshb/sync/peers/:id/probe`：验证 SSH 主机身份、认证并完成远端 loopback handshake。
- `POST /api/dshb/sync/peers/:id/trust-host-key`：确认最近一次实际观察到的主机指纹；fingerprint 不由客户端任意指定。
- `POST /api/dshb/sync/peers/:id/run`：手动执行该 peer 的节点同步；同一 peer 的并发调用共享当前作业。
- `GET /api/dshb/sync/archives`：列出可恢复的会话冲突分支。
- `POST /api/dshb/sync/archives/:branchId/restore`：把归档分支恢复为活动会话，并归档当前活动版本。
- `POST /api/dshb/sync/offline/export`：提交 `{ password, includeSessions? }`，返回加密 `.dshb-sync` 文件；会话选项默认为 `false`。
- `POST /api/dshb/sync/offline/import`：提交包密码并取得五分钟有效的单次上传令牌。
- `PUT /api/dshb/sync/offline/import/:token`：以 `application/octet-stream` 上传加密文件；服务端解密、校验并应用后返回节点/会话计数。

Peer view 的 `progress` 提供 `lastRunAt`、`lastRunStatus`、`lastSuccessAt`、`lastManifestDigest`、`watermark`、安全错误码/消息及本次导入/导出/跳过/pending-removal 计数。失败作业保留上次成功时间和水位；网络、超时或 helper 瞬时错误会在当前作业中重试一次，已启用的定时 peer 也会在下一周期再次运行。

SSH `password`、`privateKey` 和 `passphrase` 通过 `credentialKey('dshb-core', peerId)` 保存为 credentials grant payload。路由响应只包含 `hasPassword`、`hasKey`、`hasPassphrase` 布尔值；私钥与密码不会进入 JSON peer 文件、API 响应或页面状态。变更 auth kind 时，只保留新认证方式所需凭据。

首次遇到未知或已变化的 host key 时，probe 返回 `409` 和 SHA256 OpenSSH fingerprint。确认接口只接受服务端内存中、未过期且与当前 peer host/port 相同的观察结果。

## 来源身份与版本

- `SyncOrigin`：`originInstanceId` + `originEntityId`。
- `SyncProvenance`：来源身份、本地实体 ID，以及可选的导入方式和展示名称。
- `SyncRecordMetadata`：实体类型、来源信息、HLC revision、内容摘要与删除标记。
- `syncRecordKey(kind, origin)` 以 JSON tuple 编码实体类型和来源键，避免分隔符碰撞。
- `SyncRevision` 由 `physicalTimeMs`、`logicalCounter` 和 `writerInstanceId` 组成。

## Cordis 服务

`dshb-core` 提供：

- `syncPeerStore`：`SyncPeerStore` 实例，保存 `$DSH_HOME/dshb/sync-peers.json`。
- `syncStateStore`：`SyncStateStore` 实例，保存稳定实例身份和 `$DSH_HOME/dshb/sync-state.json`。
- `syncPeerManager`：负责 peer CRUD、credentials 隔离、认证信息校验和 redacted view。
- `syncSshTransport`：同步专用 SSH probe、host-key challenge 和 framed helper session。
- `syncCoordinator`：运行单向 pull 或双向 HLC 节点协调，按 peer 防重入并提交成功水位。
- `syncScheduler`：为启用且设为 `every-5m` 的 peer 注册进程内 300 秒定时器；停用/删除时清理定时器，Cordis dispose 时统一停止。
- `syncNodeService`：串行化节点 manifest 导出、导入和本地删除事务，协调任务共享节点状态时保持 HLC 单调。
- `syncSessionService`：导出、校验并应用远程工作区会话 bundle；管理 workspace mapping、批次 journal、冲突归档和恢复。
- `syncOfflineArchiveService`：生成或验证 `.dshb-sync` 加密归档，流式写入/解密 staging，预检 revision 与空间，并通过离线 journal 恢复节点/会话两阶段导入。

`SyncStateStore` 提供 `instanceId()`、`read()`、`update()`、`nextRevision()` 和 `observeRevision()`。读取损坏状态会失败关闭；更新通过验证后的新状态原子写入。

`GET /api/dshb/sync/internal/handshake` 是 loopback-only endpoint，返回协议版本、稳定 instance ID 和能力集。SSH host verifier 将 `ssh2` SHA256 hex hash 转成 OpenSSH 指纹并与显式 pin 比较；固定远端 helper 通过 SSH stdin/stdout 调用 loopback endpoint，命令字符串不包含 peer 参数。

内部节点数据接口位于同一 loopback-only namespace：

- `GET /api/dshb/sync/internal/nodes/manifest`：导出 `remote-ssh`、`remote-docker` 节点与来源版本，过滤 `local-host` 和 `local-docker`。
- `POST /api/dshb/sync/internal/nodes/apply`：按来源身份和 revision 幂等应用节点记录及 tombstone。
- 活动 workspace 仍绑定待删除节点时，服务保留 profile/credentials、标记 `pendingRemoval` 并阻止新绑定；工作区解除后由节点列表刷新触发清理。
- Manifest 不携带源端 SSH keyPath；缺少可迁移密码/私钥时记录 `credentialsRequired`，允许目标实例继续使用其本地凭据。
- `syncSessions: true` 时，协调器交换符合远程工作区范围的 session、事件、附件、spill 对象、项目指令快照和 workspace membership；`local-host`、`local-docker` 与 cwd 不匹配的记录不会导出。
- 会话导入按 origin 和远端路径映射到本地镜像工作区，重写 cwd、SessionId、父会话和对象引用；等版本冲突会显式失败，较旧日志作为稳定 branchId 归档并可恢复。journal 在启动时重放未完成批次。

## 离线归档

`.dshb-sync` 的外层为 `DSHBSYNC` magic、归档版本、固定 scrypt 参数、随机 salt 和 nonce，后接 AES-256-GCM 密文与 16 字节认证 tag。header 作为 GCM AAD，格式/KDF 参数不匹配会在解密前拒绝。密码要求 8–1024 个 UTF-8 字节，只在单次导出/导入流程内存中使用。

加密 payload 是最多 128 MiB 的 ZIP，包含 `manifest.json`、`nodes.json` 和可选 `sessions.json`。manifest 保存源 instance ID、记录 origin/revision/tombstone/digest、会话包含标记、文件长度与 SHA-256，以及可选 DSH session 格式版本。导入接受 STORE/DEFLATE 条目，限制条目数量、总展开量、路径和 CRC；未知文件、重复路径、绝对路径、`..`、反斜线、符号链接和超限内容会在 apply 前拒绝。

离线导入先按当前 `SyncStateStore` 预检节点/会话 revision 冲突和目标空间，再复用 `SyncNodeService.applyManifest(..., 'offline')` 与 session apply pipeline，保留原始 origin 用于重复导入和后续 SSH 同步去重。离线 journal 在节点和会话阶段完成后分别落盘；失败重试会跳过已完成阶段。节点及会话对象使用内容寻址或 transfer-ID 幂等存储。离线来源的节点按本地节点样式展示；同步 peer 连接凭据和 DSHB Web 登录凭据不进入归档。

离线端点的 `POST /import` 只返回随机单次 token，不回显包密码；token 与密码在服务端内存中保存，五分钟后失效，PUT 成功或失败后立即消费。
