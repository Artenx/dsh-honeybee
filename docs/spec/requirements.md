# Requirements Document — DSH-HoneyBee（DSHB）

## Introduction

DSH-HoneyBee（简称 DSHB）是基于 deepseek-harness（DSH）二次开发的多节点 Agent 工作台。DSHB 划分为管理端与执行端：管理端是统一 Web 入口，负责认证授权、下发会话指令、收集会话返回内容，同时适配电脑与手机浏览器；执行端运行在本地或远程宿主机/容器中，接受会话指令并执行具体的文件、命令、终端任务。架构采用方案 A（集中会话 + 远程执行世界）：agent loop、LLM 调用、会话日志与持久化集中在管理端单一 DSH 进程内，执行端仅承载工具层执行。用户模型为单用户；管理端到执行端的连接一律由管理端发起，节点无需回连。一期（MVP）节点范围为本地宿主 + 远程 SSH 两类；本地容器 + 远程容器两类在二期交付。分发形态为 npm 插件包 + profile 模板。

## Glossary

- **DSH / Harness**：上游开源项目 deepseek-harness，一切皆插件的 Agent 运行时。
- **管理端（Manager）**：运行 DSH Web 应用与 DSHB 插件集合的单一进程，持有 agent loop、LLM 凭据、会话日志与全部 UI。
- **执行端 / 工作节点（Node）**：承载会话工具层执行（文件、命令、终端）的目标环境。
- **本地宿主节点（local-host）**：管理端进程所在环境，使用上游默认本地提供方。
- **本地容器节点（local-docker）**：管理端所在机器上的 Docker 容器（二期）。
- **远程 SSH 节点（remote-ssh）**：通过 SSH 连接的远程宿主机（一期）。
- **远程容器节点（remote-docker）**：远程宿主机上经 SSH 通道访问的 Docker 容器（二期）。
- **节点注册表（Node Registry）**：DSHB 新增的节点管理服务，负责节点档案的增删改查、凭据托管、连通性测试与健康状态。
- **执行世界（Execution World）**：DSH 能力接缝（`ctx.fs` / `ctx.subprocess` / `ctx.shell` / `ctx.terminals`）的一组提供方实现，决定会话的文件、命令、终端在哪里执行。
- **镜像路径（Mirror Path）**：管理端文件系统上的本地真实目录，与远程工作区路径一一绑定；会话 cwd 使用镜像路径以满足上游 workspace 注册表的本地 realpath 校验，路由层把镜像根下的操作翻译到节点侧真实路径。
- **Profile / Bundle / Patch**：DSH 官方组合机制；Bundle 声明 `dsh.bundle` 分发插件层，Profile 按序叠加 Bundle，用户的 `cordis.patch.yml` 可按 id 替换或插入配置行。
- **工作区（Workspace）**：DSH 侧栏中的项目目录条目，会话在工作区下创建。
- **会话（Session）**：DSH 的一次 Agent 对话，含持久会话日志。
- **目录选择 occupant**：DSH 目录选择流程（directoryFlow slot）的占位插件，拥有从打开到选定路径之间的全部交互。

## Requirements

### Requirement 1 — 管理端认证与网络暴露

**User Story:** AS 管理员，I want 管理端可绑定到非回环地址并带登录认证，so that 我可以从手机或局域网内其他电脑安全访问同一个管理端。

#### Acceptance Criteria

1. WHEN 管理端以非回环地址启动，系统 SHALL 在凭据未初始化时向首个访问者展示管理员注册页（用户名 + 密码，密码至少 8 个字符）。
2. WHEN 非回环请求到达且未携带有效会话，系统 SHALL 对页面请求重定向到登录页、对 API 与 WebSocket 握手返回 401。
3. WHILE 请求来自回环地址且 Host 为回环，系统 SHALL 免登录放行。
4. WHEN 用户提交正确凭据，系统 SHALL 下发 HttpOnly 签名会话 Cookie 并放行后续请求。
5. IF 同一客户端 IP 连续 5 次登录失败，系统 SHALL 锁定该 IP 的登录与改密接口 30 秒。
6. WHEN 管理员在服务器本机执行 auth-reset 命令，系统 SHALL 轮换会话签名密钥并作废全部已签发会话。
7. WHEN 管理端部署在反向代理之后，系统 SHALL 依据 TCP 对端地址与真实 Host 头判定回环身份，拒绝采信 X-Forwarded-For。

### Requirement 2 — 移动端浏览器适配

**User Story:** AS 用户，I want 在手机浏览器上使用管理端的完整会话功能，so that 我不在电脑前也能下发指令与查看结果。

#### Acceptance Criteria

1. WHILE 视口宽度小于 768px，系统 SHALL 将侧栏收纳为可手势呼出的抽屉，会话区占满全宽。
2. WHILE 视口宽度小于 768px，系统 SHALL 将设置与目录选择等弹窗呈现为底部浮层。
3. WHILE 使用桌面浏览器（鼠标指针）访问，系统 SHALL 保持上游桌面三栏布局不变。
4. WHEN 页面在刘海屏手机展示，系统 SHALL 避让屏幕安全区。
5. WHILE 触屏设备视口宽度在 768px 至 1023px 之间，系统 SHALL 将内容限宽居中展示。

### Requirement 3 — 上游功能保持与松耦合

**User Story:** AS 维护者，I want DSHB 不修改上游 DSH 源码，so that 上游版本升级时合并成本可控。

#### Acceptance Criteria

1. 系统 SHALL 以独立仓库交付，上游 DSH 以锁版本 npm 依赖引入。
2. 系统 SHALL 将 DSHB 的全部新能力实现为独立插件包，经 Bundle 与 cordis.patch.yml 组合进自定义 profile。
3. WHEN 需要改变上游行为，系统 SHALL 通过 cordis.patch.yml 按 id 替换目标配置行，且替换对象限于小型 API 包。
4. WHEN 上游发布新的 minor 版本，系统 SHALL 提供机械化升级流程：升级依赖版本、重建契约、运行快照与端到端测试。
5. 系统 SHALL 保持上游 Web 界面的既有页面与功能可用，DSHB 新界面经 slot 与插件机制注入。

### Requirement 4 — 节点注册表

**User Story:** AS 管理员，I want 在管理端维护一组工作节点档案，so that 添加工作区时可以直接选用已配置好的节点。

#### Acceptance Criteria

1. WHEN 管理员创建节点档案，系统 SHALL 记录节点类型、名称、连接参数与认证方式，一期支持本地宿主与远程 SSH 两类，二期扩展本地容器与远程容器两类。
2. WHEN 节点档案包含密码或私钥等秘密字段，系统 SHALL 将秘密写入 DSH 凭据服务（文件权限 0600），节点档案本身仅存引用。
3. WHEN 管理员请求测试节点连接，系统 SHALL 执行认证握手与执行链路自检并返回分类错误信息（认证 / 网络 / 主机密钥 / 超时）。
4. WHEN 首次连接某 SSH 节点，系统 SHALL 记录主机密钥指纹；IF 后续连接指纹发生变化，系统 SHALL 拒绝连接并提示可能存在的中间人风险。
5. WHEN 管理端展示节点列表，系统 SHALL 展示各节点的连通状态与最近检测结果。
6. WHEN 管理端主机的 `~/.ssh/config` 存在 Host 条目，系统 SHALL 支持一键导入为节点档案草稿。

### Requirement 5 — 节点感知的添加工作区流程

**User Story:** AS 用户，I want 添加工作区时先选择工作节点、再在该节点上选择或创建目录，so that 工作区与实际执行环境一一对应。

#### Acceptance Criteria

1. WHEN 用户点击添加工作区，系统 SHALL 先呈现节点选择步骤，列出节点注册表中的可用节点与本地宿主入口。
2. WHEN 用户选定节点，系统 SHALL 呈现该节点文件系统的目录浏览器，支持逐级浏览与直接输入路径。
3. WHEN 用户选定的路径在节点上不存在，系统 SHALL 提供在节点上创建该目录的入口，创建成功后采纳为工作区路径。
4. WHEN 远程节点的工作区创建成功，系统 SHALL 在管理端建立对应镜像路径并将工作区注册进 DSH 侧栏，标题包含节点归属标识。
5. WHEN（二期）用户选择容器节点的新建容器模式，系统 SHALL 收集自定义镜像与资源参数，执行拉取镜像、创建容器、等待就绪、容器内创建工作区路径的供给流程，全部成功后注册工作区。
6. IF 供给流程任一步骤失败，系统 SHALL 向用户报告失败阶段与原因，并清理已创建的半成品容器。

### Requirement 6 — 会话级执行世界路由

**User Story:** AS 用户，I want 在工作区下新建的会话自动在该工作区绑定的节点环境内执行，so that 文件读写、命令与终端都作用于正确环境。

#### Acceptance Criteria

1. WHEN 用户在绑定远程节点的工作区下新建会话，系统 SHALL 将该会话的文件、命令、终端操作路由到对应节点执行。
2. WHEN 会话 cwd 落某工作区的镜像路径下，系统 SHALL 用该工作区的节点路由判定执行位置，其余路径保持上游本地行为。
3. WHILE 会话在远程节点执行，系统 SHALL 向模型呈现节点侧真实路径作为文件路径与命令工作目录。
4. WHILE 本地宿主工作区的会话运行，系统 SHALL 保持上游本地提供方与沙箱行为不变。
5. IF 会话运行期间节点连接断开，系统 SHALL 在会话界面呈现可读的节点故障错误，并在连接恢复后允许继续会话。

### Requirement 7 — 统一管理端交互

**User Story:** AS 用户，I want 无论工作区位于哪个节点都在管理端同一个 Web 界面操作会话，so that 交互入口唯一、体验一致。

#### Acceptance Criteria

1. 系统 SHALL 将 agent loop、LLM 调用、会话日志与持久化集中于管理端进程。
2. 系统 SHALL 在管理端界面统一呈现各节点工作区的会话列表、消息流与审批交互。
3. 系统 SHALL 将模型 API 凭据仅保存在管理端凭据服务中。
4. 系统 SHALL 在架构上为按节点转发 LLM 出口预留扩展位，一期 LLM 请求固定由管理端发出。

### Requirement 8 — 远端执行安全

**User Story:** AS 管理员，I want 远端执行链路有明确的注入防护与审计，so that 节点操作可追踪、凭据不外泄。

#### Acceptance Criteria

1. WHEN 管理端向 SSH 节点下发命令，系统 SHALL 使用静态命令串模板，命令参数、环境变量与工作目录经编码后经数据通道传输，与命令串隔离。
2. WHEN 管理端向节点创建目录或传输文件，系统 SHALL 使用 SFTP 协议操作完成。
3. WHEN 管理端与节点间发生命令执行、文件写入、删除与移动操作，系统 SHALL 追加审计日志，记录时间、节点、操作类型与结果。
4. WHEN 节点连接建立，系统 SHALL 净化远端登录环境中与 DSH 相关的变量与凭据形变量名。
5. 系统 SHALL 将节点凭据的展示限制为存在性标识，凭据内容不出现在任何 API 响应中。

### Requirement 9 — 分发与升级

**User Story:** AS 部署者，I want 通过 npm 包与 profile 模板安装 DSHB，so that 安装与升级走 DSH 官方插件机制。

#### Acceptance Criteria

1. 系统 SHALL 提供声明 `dsh.bundle` 的 npm 插件包，经 `dsh plugin` 命令装入 profile。
2. 系统 SHALL 提供 DSHB profile 模板，按序叠加 dsh-base、dsh-web-app 与 DSHB 各 Bundle。
3. WHEN 插件包安装或升级，系统 SHALL 通过随包 patch 自动完成组合，无需手工编辑 profile 配置。
4. 系统 SHALL 锁定兼容的上游 DSH 版本范围，并在文档中标注已验证的上游版本。
