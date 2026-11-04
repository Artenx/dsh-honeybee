# 需求实施计划

- [x] 1. 双模式基础与中继通道
  - [x] 1.1 `SyncPeer.mode`（full/metadata，旧数据缺省 full）与实时目录拉取
  - [x] 1.2 远端 `POST /api/dshb/sync/internal/relay-ticket`（loopback-only，≤10 分钟 cookie）及单元测试
  - [x] 1.3 本地 `/api/dshb/remote/<peerId>/call/...` 信封转发（SSH direct-tcpip、凭据缓存、失败分类）及单元测试

- [x] 2. 元数据同步协调与 UI
  - [x] 2.1 协调器元数据分支：每次实时拉取目录、跳过会话内容交换、capability 缺失稳定错误码、进度目录计数
  - [x] 2.2 表单「同步模式」选项置于「同步工作区会话」下方，仅勾选时显示；两种模式均有文字说明
  - [x] 2.3 同步范围选择器每次从目标 peer 实时拉取目录；会话显示可读名称（缺省 ID），文件大小位于名称之后

- [x] 3. wss 流式交互
  - [x] 3.1 本地 `registerUpgrade` wss 透传（原始字节管道），接入 `session/follow` 实时事件
  - [x] 3.2 `session/prompt` 发送与审批交互；会话只读预览升级为完整远端视图

- [ ] 4. 验证与文档
  - [x] 4.1 全量测试、类型检查、构建
  - [ ] 4.2 同步 `.monkeycode/docs/`（架构、接口、同步模块文档）
  - [x] 4.3 A/B 双实例实测：元数据同步实时拉取（1 节点/1 工作区/56 会话、内容零传输）、远端通道预览（session/list + page 按游标取事件）、全量模式回归（56 会话跳过、行为不变）
