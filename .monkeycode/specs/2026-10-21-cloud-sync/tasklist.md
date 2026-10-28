# 需求实施计划

- [x] 1. 建立同步身份、数据模型与持久化
  - 定义 SyncPeer、SyncRevision、SyncProvenance、manifest、tombstone 和同步状态类型；实现 peer 配置验证、稳定 instance ID、HLC 与安全原子状态存储（Requirements 8.3–8.4、11.1–2、11.8、11.11–12；Design: Data Models、Loop Prevention and Conflict Resolution）
  - [x] 1.1 为配置验证、状态读写、HLC 排序、来源身份初始化和损坏状态恢复编写单元测试（Design: Correctness Properties 1、7）

- [x] 2. 实现同步节点管理 API 与设置界面
  - 增加 peer 新建、编辑、启用/停用、删除、凭据保存和凭据存在状态 API；秘密值仅写入 DSH credentials，不回传给客户端（Requirements 8.1–6、9.1–7）
  - 在“工作节点”设置中增加同步节点入口和表单，支持 SSH 地址、端口、账号、认证、远端 DSH_HOME、方向、手动/5 分钟时机、会话开关和 peer 状态（Requirements 8.1–7、9.1–7）
  - [x] 2.1 为 peer API、凭据脱敏、配置校验和同步节点表单状态编写单元测试（Design: Test Strategy 1）

- [x] 3. 实现 SSH 信任、远端 helper 与同步传输协议
  - 为同步 SSH 连接实现首次 host-key pinning、后续强校验、认证和分类错误；固定远端 helper 入口，结构化参数经 stdin 传递（Requirements 8.2、8.5；Design: Peer endpoints、Security and Limits）
  - 实现 loopback-only handshake 和固定 helper 调用；建立有界 NDJSON 控制帧/数据帧协议，验证协议版本、chunk 序号、摘要和传输限制。manifest/export/apply 数据处理由任务 4、6 接入，run-status 由任务 5 接入（Requirement 8.5；Design: Synchronization Flow 2–3、6）
  - [x] 3.1 为 SHA256 fingerprint 转换与 host-key trust challenge、loopback 隔离、固定 helper handshake、帧序列/摘要/大小边界编写测试；真实 SSH auth 与中断恢复纳入集成阶段（Design: Test Strategy 4、6）

- [x] 4. 实现节点 manifest、过滤、导入与删除传播
  - 实现节点导出/导入、来源映射、重复 apply 幂等、同名节点隔离、秘密写入目标 credentials、`local-host`/`local-docker` 排除以及 tombstone 版本裁决（Requirements 10.1–2、11.1–4、11.7–9、11.11–12；Design: Data Scope and Import Mapping、Correctness Properties 1–3、5）
  - 对仍绑定活动工作区的删除执行 pending removal，禁止新工作区选择；解除最后一个绑定后清理节点档案和凭据（Requirement 11.9；Design: Data Models）
  - [x] 4.1 为过滤、来源映射、重复导入、删除墓碑、绑定保护和同名节点隔离编写单元测试（Design: Test Strategy 1、Correctness Properties 1–5）

- [x] 5. 实现同步协调器、方向控制与定时调度
  - 实现 peer 级互斥、manifest 差异计算、单向 pull、双向 HLC 裁决、水位提交、一次瞬时传输重试和同步状态报告（Requirements 9.1–4、11.2–8；Design: Synchronization Flow、Correctness Properties 2–3、7）
  - 为启用的 every-5m peer 建立进程内 300 秒调度；停用或删除 peer 时取消调度，定时和手动运行共用 peer 锁（Requirements 9.4–6；Design: Components and Interfaces、Consistency and Concurrency）
  - [x] 5.1 使用 fake timers 测试方向过滤、多 peer 并行、peer 锁、防重入、五分钟调度、停用/删除 timer 清理、瞬时重试和失败后水位保持（Design: Test Strategy 5–6）

- [x] 6. 实现会话快照、工作区映射和冲突归档
  - 经公开 session persistence API flush 并导出符合范围的完整会话、事件、附件、spill/file 对象、指令快照和 workspace membership；排除默认环境、本地 Docker 与不可映射会话（Requirements 9.7、10.3–6；Design: Data Scope and Import Mapping、Correctness Properties 4–5）
  - 导入时映射 workspace、mirrorPath、cwd、本地 SessionId、父子/fork lineage 和对象引用；按 HLC/LWW 保留胜出活动日志，将输家分支以稳定 branchId 保存至可恢复归档（Requirements 11.4–6、11.10；Design: LWW Session Archive）
  - 实现同步 journal 和启动恢复，确保活动日志、归档、workspace membership 与水位按批次提交（Design: Synchronization Flow 7–8、LWW Session Archive 1–4）
  - [x] 6.1 为会话 flush、cwd 映射、对象摘要、重复导入、分支归档/恢复及中断恢复编写测试（Design: Test Strategy 2–3、6–7）

- [x] 7. 实现加密离线配置导入与导出
  - 实现默认不含会话的 `.dshb-sync` 导出/导入，使用 scrypt 与 AES-256-GCM 加密，并在 manifest 保存来源身份、revision、tombstone、摘要和格式版本（Requirements 12.1–4；Design: Offline Configuration Archive 1–3）
  - 实现流式解密、密码/tag/格式/摘要/引用/路径/解压总量/磁盘空间校验；校验完整后复用同步 apply pipeline，失败时不修改已提交数据（Requirements 12.5–7；Design: Offline Configuration Archive 4–6）
  - 在“工作节点”设置增加导出、会话选项、密码输入、导入和进度/错误展示；离线导入保留内部 origin，但按本地新建节点样式展示（Requirements 8.8、12.1–3；Design: Offline Configuration Archive）
  - [x] 7.1 为加密往返、错误密码、篡改、路径穿越、解压膨胀、幂等重导入和会话选项编写测试（Requirements 12.5–7；Design: Offline Archive Test Strategy）

- [x] 8. 完成跨实例集成验证与发布构建
  - 验证 A→B→C 转发与回环去重、peer 单向/双向行为、节点和会话同步、定时运行、失败恢复及离线包往返（Requirements 8–12；Design: Correctness Properties 1–7、Test Strategy 5–7、Offline Archive Test Strategy）
  - [x] 8.1 运行并修复同步相关单元/集成测试、全量测试、类型检查与包构建；验证发布包导出与兼容元数据（Design: Test Strategy）
