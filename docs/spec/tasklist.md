# 需求实施计划 — DSH-HoneyBee（DSHB）

对应需求文档 `requirements.md`（R1–R9）与设计文档 `design.md`。一期范围：本地宿主 + 远程 SSH；二期：本地容器 + 远程容器。测试类子任务标记 * 为可选，本次实施跳过。

**P0 调研与仓库骨架**

- [x] 1. 初始化 DSHB 独立仓库与构建骨架（对应需求 3.1/3.2/9.1）
  - 在 `/workspace/dsh-honeybee/` 创建独立 git 仓库：pnpm workspace、tsconfig.base、tsdown 构建、vitest 配置
  - `packages/` 下建立 dshb-auth / dshb-core / dshb-router / dshb-exec-ssh / dshb-ui 空包（各含 `dsh.bundle` 声明的 package.json 骨架）
  - `profiles/dshb/` 下编写 profile 模板：按序叠加 dsh-base + dsh-web-app + dsh-web-mobile + dshb-*
  - package.json 锁定上游 `@deepseek-ai/dsh` 版本范围并记录已验证版本
- [x] 2. 跑通上游组装与插件开发循环（对应需求 3.3/3.4）
  - `dsh --profile web --dump-config` 导出完整插件树，确认三处 patch 目标行 id（startup、fs-sandbox/subprocess/bash-sandbox、directory-picker-auto）
  - 编写 hello-world bundle 验证 patch 热重载与 `dsh plugin add` 安装链路
  - 编写契约测试：断言三个 patch 目标行 id 存在于上游构建产物（升级时第一发现点）
- [x] 3. 检查点 - 确保所有测试通过，profile 可启动并打开 Web UI

**P1 认证与节点骨架（一期）**

- [x] 4. 实现 dshb-auth 的 startup 替换与网络绑定（对应需求 1.1/1.3/1.7）
  - patch 按 id 替换 `dsh-web-app/startup` 行，允许 `--host 0.0.0.0`
  - 回环判定仅依据 TCP 对端地址 + Host 头，拒绝采信 X-Forwarded-For
- [x] 5. 实现 dshb-auth 认证路由与会话（对应需求 1.1/1.2/1.4/1.5/1.6）
  - `/api/auth/*`：register（仅凭据未初始化时开放）/ login / logout / change-password / change-username
  - scrypt（随机盐，64 字节）密码散列 + HMAC-SHA256 签名 Cookie（HttpOnly，14 天），凭据文件 0600
  - 认证中间件保护 `/api/*`、第三方 RPC 路由与 WebSocket 握手；同 IP 5 次失败锁 30 秒
  - 认证通过后 Host/Origin 改写为回环放行特权 API；`auth-reset` CLI 轮换密钥作废全部会话
- [x] 6. 实现 dshb-auth 前端（对应需求 1.1，需求 2 兼容）
  - 登录/注册页 client 插件 + 设置面板"认证"页（退出/改名/改密）
  - `webServer.tapIndex` 注入脚本覆盖 `connection.isLoopback`，修复远程浏览器下 settings mirror
- [ ]* 6.1 为认证编写单元测试（scrypt/Cookie 签名/限速/回环判定）
- [x] 7. 实现 dshb-core 节点注册表（对应需求 4.1/4.2/4.5）
  - `ctx.nodeRegistry` 服务：create/update/remove/list/get/test/status
  - 档案存 `$DSH_HOME/dshb/nodes.json`（0600），秘密字段写入上游 credentials 服务仅存 credentialId，API 响应只含 hasSecret 标识
- [x] 8. 实现 SSH 连接参数解析与导入（对应需求 4.4/4.6）
  - `~/.ssh/config` 解析（别名/User/Port/IdentityFile/ProxyJump）为节点档案草稿
  - TOFU 主机密钥库 `known_hosts.json`（0600）：首连记录、变更拒绝
- [ ]* 8.1 属性测试：档案 CRUD 后节点唯一性不变量（设计正确性属性 1）
- [x] 9. 检查点 - 确保所有测试通过，认证链路在局域网访问下可用

**P2 SSH 执行世界（一期）**

- [x] 10. 实现 dshb-router 路由器（对应需求 6.1/6.2/6.4）
  - 纯函数 `resolveWorld(path)`：命中镜像根返回节点世界，否则透传上游本地实现
  - `RouterFileSystem extends SandboxedFileSystem`、`RouterSubprocess extends LocalSubprocessRuntime`、`RouterShell extends SandboxBashExecutor`；patch 禁用 dsh-base 三行并插入路由器
  - `ExecutionWorldProvider` 接口定义（fs/subprocess/shell/terminal/ensureDir/testConnection）
- [ ]* 10.1 属性测试：镜像根外路径行为与上游本地实现一致（设计正确性属性 2/6）
- [x] 11. 实现 dshb-exec-ssh 连接层（对应需求 8.4）
  - ssh2 单连接复用；密码/私钥/passphrase/ssh-agent/ProxyJump 多跳
  - 远端登录环境 `env -i` 净化（剔除 `DSH_*` 与凭据形变量名）
  - 指数退避自动重连（上限 5 次），断连期间调用返回分类错误（对应需求 6.5）
- [x] 12. 实现 dshb-exec-ssh 命令与文件通道（对应需求 6.3/8.1/8.2）
  - exec 静态字面量 runner + argv/env/cwd 单行 base64 行协议经 stdin 传输（兼容 bash 3.2 与 BSD base64）
  - SFTP 协议级 fs 提供方：读/原子写/列目录/stat/mkdir/删除
  - rg 自举：远端探测、缺失时经 SFTP 上传管理端自带 ripgrep
  - PTY 终端后端（create/resize/kill）
- [ ]* 12.1 安全回归测试：argv 含 shell 元字符时命令串保持静态字面量（设计正确性属性 8）
- [ ]* 12.2 live 测试：对真实 sshd（含两跳 ProxyJump）覆盖 fs 全方法/collect/PTY
- [x] 13. 检查点 - 确保所有测试通过，SSH 世界在真实节点可用

**P3 工作区流程（一期）**

- [x] 14. 实现 dshb-ui 节点管理设置页（对应需求 4.1/4.3/4.5/4.6）
  - 节点 CRUD 表单（一期：local-host 内置 + remote-ssh）、连接测试按钮（分类错误提示）、健康状态展示、ssh config 一键导入
- [x] 15. 实现 dshb-ui 节点感知添加工作区 occupant（对应需求 5.1/5.2/5.3/5.4）
  - 接管 directoryFlow slot：第一步节点选择，第二步节点内目录浏览（list/createDirectory 动词转发到目标节点）
  - 创建本地镜像目录 `mirrors/<nodeId>/<slug>`，调用上游 workspace 注册，落盘工作区绑定（镜像路径 → 节点 + 远端路径）
  - 侧栏工作区标题含节点归属标识
- [ ] 16. 实现会话路由集成与审计（对应需求 6.1/6.5/7.1/7.2/8.3）
  - 工作区绑定查询服务接入路由器；会话 cwd 命中镜像根即绑定该会话执行世界
  - 审计日志 `$DSH_HOME/dshb/audit.log`：exec/write/remove/move 操作追加记录
  - 模型视角路径翻译：displayPath 与 pwd 呈现节点侧真实路径
- [ ]* 16.1 属性测试：远程会话模型可见路径全为节点侧真实路径（设计正确性属性 3）
- [ ] 17. e2e：注册登录 → 添加 SSH 节点 → 添加远程工作区（含自动建目录）→ 新建会话执行命令 → 断言远端生效且日志集中于管理端
- [ ] 18. 检查点 - 确保所有测试通过

**P4 移动端与分发收尾（一期）**

- [ ] 19. 移动端适配收尾（对应需求 2.1–2.5）
  - 依赖 dsh-web-mobile；dshb-auth 登录页与 dshb-ui 新组件按抽屉/底部浮层范式补齐 <768px 样式
  - 双视口（1280px / 375px）Web 快照基线：登录页、节点选择、目录浏览、会话页
- [ ] 20. 聚合 bundle 与升级流程（对应需求 3.4/9.2/9.3/9.4）
  - `dshb` 聚合包：cordis.patch.yml 随包插入全部 DSHB 行，`dsh plugin --profile web add dshb` 一条命令安装
  - 升级脚本：bump 上游版本 → 重建 → 契约测试 + 快照/e2e；README 标注已验证上游版本
- [ ] 21. 检查点 - 一期收口：全量测试绿，手机浏览器登录并完整使用远程会话

**P5 Docker 节点（二期）**

- [ ] 22. 实现 dshb-exec-docker 本地容器世界（对应需求 4.1 二期项、5.5）
  - Docker Engine API client（`node:http` 直连 socket）；fs/subprocess/shell/terminal 提供方（`docker exec` / `docker cp` / exec+tar 流）
  - 镜像基线检查：缺 bash/ps/base64 时自动 apk/apt 补齐，失败明确报错
- [ ] 23. 实现远程容器世界与供给流水线（对应需求 5.5/5.6）
  - SSH 通道转发远端 Docker API
  - 供给流水线：拉镜像 → 创建容器 → 等待就绪 → 容器内建工作区路径 → 注册；失败报告阶段并清理半成品
  - occupant 容器选项：已存在容器 / 新建容器（自定义镜像、cpus/memory 资源参数）
- [ ]* 23.1 属性测试：供给失败时无残留容器与绑定记录（设计正确性属性 7）
- [ ] 24. 检查点 - 确保所有测试通过，四类节点全通
