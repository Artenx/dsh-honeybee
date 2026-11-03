# 需求文档：远端会话中继与双模式同步

## Introduction

本文定义 DSHB 同步节点的双模式设计：既有文件传输方案命名为**全量同步**并保持行为不变；新增**元数据同步**模式，自动同步只传输工作节点与工作区会话列表（目录），点击同步来的会话时经 SSH 通道与 wss 实时操作远端 DSH。离线导入导出保持现有加密归档语义不变。

设计依据（均在本仓库 node_modules 官方包与 DSH 源码中核实）：

- DSH Host Gateway 提供版本化 Remote 协议：unary 调用为普通 HTTP POST（`POST /api/<namespace/method>`，信封 `{type:'client-request', rpcId, method, payload}` → `{type:'server-response', rpcId, result}`），流/事件走 `/api` WebSocket 升级。
- 远端 Web profile 认证输入为启动令牌（进程内存）或签名 cookie（HMAC-SHA256，密钥存于远端 DSH credentials 的 `client-connection/browser-session` 记录）；回环请求无豁免。
- `dsh-host-webserver` 提供 `registerUpgrade`；`ssh2` 支持 `forwardOut` direct-tcpip。

## Glossary

- **全量同步**：既有同步方案，将工作节点配置与工作区会话内容（事件、附件、spill 对象、指令快照）完整传输到对端，导入后可在本机离线继续。
- **元数据同步**：新增模式，自动同步只传输节点配置与元数据目录；点击同步来的会话时经远端会话通道实时读取/操作远端 DSH。
- **元数据目录**：远端可同步节点、工作区、会话的摘要清单（来源身份、名称/路径、文件大小），不含事件正文、附件或秘密。
- **远端会话通道**：本地 DSHB 注册的 `/api/dshb/remote/<peerId>/` 路由，经 SSH direct-tcpip 连接远端回环 WebSocket 端口转发 Remote 调用与 wss 流。
- **中继凭据**：远端 DSHB 内部路由铸造的短时效签名 cookie（≤10 分钟），仅存内存。

## Requirements

### Requirement 1：同步模式选项与文字说明

**User Story:** AS DSHB 管理员, I want 为每个同步节点选择全量同步或元数据同步, so that 按数据量与使用场景选择传输策略。

#### Acceptance Criteria

1. WHEN 用户配置同步节点，系统 SHALL 提供「全量同步」与「元数据同步」两种模式，默认全量同步。
2. WHEN 用户选择模式，系统 SHALL 展示对应文字说明：全量同步完整传输会话内容、导入后可离线继续；元数据同步仅同步列表、点击会话时经加密通道实时操作远端。
3. WHEN 用户勾选「同步工作区会话」，界面 SHALL 在该选项下方显示同步模式选择器。
4. WHEN 用户取消勾选「同步工作区会话」，界面 SHALL 隐藏同步模式选择器并将模式设为全量同步。
5. WHEN 已保存的同步节点没有模式字段，系统 SHALL 按全量同步处理，保持既有行为不变。

### Requirement 2：元数据同步

**User Story:** AS DSHB 管理员, I want 元数据同步不传输会话内容, so that 同步快速且多机共用同一份远端历史。

#### Acceptance Criteria

1. WHEN 元数据同步执行，系统 SHALL 传输节点配置并拉取远端元数据目录（节点、工作区、会话摘要及持久化文件大小），且 SHALL NOT 传输会话事件、附件、spill 对象或指令快照。
2. WHEN 目录拉取成功，系统 SHALL 将目录按对端落盘并在进度中报告节点/工作区/会话计数。
3. WHEN 用户查看元数据同步节点，系统 SHALL 展示已同步目录中的远端节点、工作区与会话列表（含文件大小）。
4. IF 对端 DSHB 不支持目录接口，系统 SHALL 以稳定错误码失败并提示升级。
5. WHEN 用户对已同步节点重新执行同步，系统 SHALL 刷新落盘目录。

### Requirement 3：远端会话通道

**User Story:** AS DSHB 管理员, I want 点击同步来的会话时实时操作远端 DSH, so that 我在任意实例上都能继续远端工作。

#### Acceptance Criteria

1. WHEN 用户点击目录中的远端会话「在远端打开」，系统 SHALL 经本地 DSHB 远端通道向远端 DSH 下达 Remote 协议指令并实时展示返回内容，内容 SHALL NOT 落盘本机。
2. WHEN 远端通道建立，本地 DSHB SHALL 经既有 SSH 连接（含 host-key 校验）打开到远端回环 WebSocket 端口的 direct-tcpip 通道。
3. WHEN 通道首次访问远端，系统 SHALL 由远端 DSHB 铸造短时效中继凭据完成认证，且 SHALL NOT 要求用户输入远端启动令牌。
4. IF 远端实例未运行、不可达或认证失败，系统 SHALL 显示分类错误并保留目录数据。
5. WHILE 会话流式交互（实时事件 follow、审批）未接入前，界面 SHALL 明确提示该能力将在后续版本提供。

### Requirement 4：中继凭据安全

1. WHEN 铸造中继凭据，远端 DSHB SHALL 使用本机 DSH credentials 的 `client-connection/browser-session` 密钥记录，生成 ≤10 分钟签名 cookie，仅接受远端回环请求，凭据 SHALL NOT 写入日志、状态或磁盘。
2. WHEN 本地用户访问远端通道，系统 SHALL 先通过本地 DSHB 既有认证门，再建立 SSH 通道。

### Requirement 5：全量同步与离线导入导出保持不变

1. WHEN 同步模式为全量，系统 SHALL 保持既有会话内容同步行为（manifest、增量、冲突归档、墓碑语义）不变。
2. WHEN 用户创建或导入 `.dshb-sync` 离线包，系统 SHALL 保持现有加密、校验、范围选择与幂等导入行为。

## 明确边界

- 远端会话通道第一版提供只读内容预览（`session/list`、`session/page`）；实时事件流（follow）、发送消息、审批需要 wss 流透传，列入后续任务。
- 元数据模式的会话条目仅用于展示与点击访问；需要本机可继续的会话副本时使用全量同步或离线导入。
- 中继通道复用 peer 的 SSH 连接配置与 host-key 信任；单独配置中继节点不在本期。
- 远端 DSH 与 DSHB 版本需在本插件声明的兼容范围内；cookie 铸造按已安装版本常量实现并在运行时校验格式。
