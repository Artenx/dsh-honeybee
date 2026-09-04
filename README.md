# DSH-HoneyBee（DSHB）

<p align="center">
  <a href="README.en.md">English</a> | <a href="README.md">简体中文</a>
</p>

<p align="center">
  <strong>基于 deepseek-harness 的云端 Agent 工作台，随时随地开始实现你的想法</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT" /></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square" alt="dsh-plugin" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/upstream-dsh%400.1.1--rc.2-blue?style=flat-square" alt="upstream dsh 0.1.1-rc.2" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.13-339933?style=flat-square" alt="node >=22.13" />
  <img src="https://img.shields.io/badge/status-developing-orange?style=flat-square" alt="status" />
</p>

DSHB 支持一个 web 入口同时驱动多台云主机或 Docker 容器的执行环境：agent loop、LLM 调用、会话与持久化集中在统一 web 入口；文件、命令、终端等工具层任务被透明地分发到本地或云端节点（或容器）上执行。插件交付，无修改上游源码。同时适配手机浏览器，移动操作随手可及。

> 面向 DSH 生态的纯插件交付：全部能力以 DSH 插件包（bundle）实现，经 profile + `cordis.patch.yml` 组合装配，可跟随上游版本升级。

---

## 特性

- **多节点执行**：本地宿主、本地 Docker、远程 SSH 宿主机、远程 Docker 四类工作节点；连接一律由管理端发起
- **镜像路径 + 执行世界路由器**：每个远程工作区在管理端持有一个本地镜像目录作为会话 cwd（满足上游 workspace 的 realpath 校验），`ctx.fs` / `ctx.subprocess` / `ctx.shell` / `ctx.terminals` 被路由器翻译到节点侧真实路径执行
- **容器生命周期管理**：创建带镜像的 Docker 节点自动供给容器，支持「拉起 / 重启 / 停止」；节点在线状态由心跳（SSH 握手 + daemon + 容器 running）三层校验
- **按需拉取产物**：容器 / 远端产生的文件点击即从节点实时读取下载，无需回写本地镜像，中文内容按 UTF-8 正确展示
- **凭据托管**：SSH 密码 / 私钥 / passphrase 由管理端统一托管，测试连接使用表单中的即时值
- **节点管理 Web UI**：节点增删改查、测试连接、Docker 容器控制、目录树式添加工作区，并适配手机浏览器（配合 dsh-web-mobile）
- **单管理员认证**：登录页 + 会话 Cookie，限制网络暴露入口

## 架构

DSHB 分管理端与执行端：

```
┌──────────────────────────── 管理端（单一 DSH 进程）───────────────────────────┐
│  dshb-auth 认证 │ dshb-ui 节点管理/添加工作区 │ dshb-core 节点注册表/心跳      │
│  dshb-router 世界路由（替换 ctx.fs/shell/subprocess）                          │
└───────────────┬──────────────────────────────────────────────┬──────────────┘
                │ dshb-exec-ssh（SSH exec 行协议 / SFTP / PTY）  │ dshb-exec-docker（Docker Engine API）
        ┌───────▼────────┐  ┌─────────▼────────┐  ┌────────────▼────────────┐
        │ 远程 SSH 宿主    │  │ 本地 Docker 容器 │  │ 远程 Docker 容器（SSH 通道）│
        └────────────────┘  └─────────────────┘  └─────────────────────────┘
```

- **管理端**：统一 Web 入口，负责认证授权、下发会话指令、收集会话返回内容，适配电脑与手机浏览器；agent loop、LLM 调用、会话日志与持久化全部集中于此
- **执行端（工作节点）**：运行在本地或远程宿主机 / 容器内，接受指令执行文件、命令、终端任务并返回结果

核心机制是「镜像目录 + 路由器」：远程文件操作被路由到节点侧真实路径；`dshb-router` 自带的 `cordis.patch.yml` 会禁用宿主默认 `bash-sandbox` / `fs-sandbox` / `subprocess` 并替换为路由版本，因此无需改动上游源码即可接入远端与容器。

## 组件

| 包 | 作用 |
| --- | --- |
| [dshb](packages/dshb) | 聚合包——一条命令安装全部 DSHB 插件 |
| [dshb-auth](packages/dshb-auth) | 管理端认证与网络暴露（登录页 / 会话 Cookie / loopback 放行） |
| [dshb-core](packages/dshb-core) | 节点注册表（`ctx.nodeRegistry`）、凭据托管、心跳、产物按需下载路由 |
| [dshb-router](packages/dshb-router) | 执行世界路由器——`ctx.fs` / `ctx.subprocess` / `ctx.shell` 按镜像路径分流 |
| [dshb-exec-ssh](packages/dshb-exec-ssh) | 远程 SSH 执行世界（exec 行协议 / SFTP / PTY over ssh2） |
| [dshb-exec-docker](packages/dshb-exec-docker) | Docker 容器执行世界（Docker Engine API + exec/文件/PTY）+ 容器供给 |
| [dshb-ui](packages/dshb-ui) | 节点管理设置页、节点感知的「添加工作区」occupant |

## 安装

### 前置要求

- Node.js >= 22.13
- pnpm >= 11
- 一份可运行的 DSH 环境（已验证上游 `@deepseek-ai/dsh@0.1.1-rc.2`）
- 若在云端使用 Docker 容器（local-docker / remote-docker 节点），需要目标宿主机上的 Docker 基础环境（Docker Engine + daemon）由你提前安装好，本工具不会代为安装

### 一键部署（curl）

一条命令同时安装标准 DSH 与全部 DSHB 插件到 `web` profile；若检测到环境里已有 `dsh`，会跳过 DSH 安装、只装 DSHB：

```sh
curl -fsSL https://raw.githubusercontent.com/Artenx/dsh-honeybee/main/scripts/bootstrap.sh | bash
```

脚本会：检测 `dsh`（已存在则跳过，不存在则用锁定的 `@deepseek-ai/dsh@0.1.1-rc.2`）→ 克隆本仓库 → `pnpm build` → 逐个安装 DSHB 插件 + `dsh-web-mobile`。安装完成后按脚本提示启动 `dsh web`。

常用覆盖项：`DSH_HOME`（默认 `~/.dsh`）、`PROFILE`（默认 `web`）、`DSH_VERSION`（默认 `0.1.1-rc.2`）：

```sh
DSH_HOME="$HOME/.dsh-prod" PROFILE=prod \
  curl -fsSL https://raw.githubusercontent.com/Artenx/dsh-honeybee/main/scripts/bootstrap.sh | bash
```

### 从源码安装（开发模式）

```sh
# 1. 安装依赖并构建全部包
pnpm install
pnpm build

# 2. 一条命令装入 web profile
./scripts/install.sh
# 等价于：逐个 dsh plugin --profile web add packages/dshb-{auth,core,router,exec-ssh,exec-docker,ui}
#         再加 dsh-web-mobile

# 3. 重启管理端
dsh web
```

也提供了预组合 profile（`profiles/dshb`），把全部包声明为 workspace 依赖并列出 bundles，仓库内 `pnpm install` 后即可作为 profile 直接运行。

### 聚合包（npm 发布后）

```sh
dsh plugin --profile web add dshb
```

聚合包 `dshb` 依赖全部子包，其 `cordis.patch.yml` 合并了各子包的 patch 行（union），一条命令完成组合；子包发布到 npm 后依赖自动从 registry 解析。

### 将 DSH 自身容器化（可选）

DSH 管理端本身也可以跑在 Docker 容器里。若同时需要 **local-docker 节点驱动宿主机上的容器**，启动 DSH 容器时必须挂载宿主机的 Docker socket：

```bash
docker run -d \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -p 3000:3000 \
  -v "$HOME/.dsh:/root/.dsh" \
  <dsh-image> dsh web
```

- local-docker 节点通过 `docker.sock` 直接调用宿主机 Docker Engine API，**DSH 容器内无需安装 docker CLI**；remote-docker / remote-ssh 节点走 SSH，与此无关
- 若宿主机 daemon 暴露在 TCP 上，用 `DOCKER_HOST`（如 `tcp://host:2375`）注入环境变量，DSH 容器与执行通道都会遵循
- **local-host 节点始终指向 DSH 进程所在的环境**：容器化部署时它指容器自身；要在宿主机执行文件/命令，请使用 remote-ssh 指向宿主机，或用 local-docker 进入容器

## 使用

1. 启动管理端 `dsh web`，浏览器打开控制台，完成首次登录
2. 进入 **设置 → 工作节点**，添加节点：
   - 远程节点填写 SSH 主机 / 端口 / 用户名与认证信息，可先「测试连接」
   - Docker 节点填写镜像地址与资源限制，保存后自动拉起容器；容器就绪前节点显示「容器拉起中」
3. 在会话区或侧栏「添加工作区」，选择**在线**节点并从目录树选取远端目录作为工作区
4. 在会话中直接对工作区读写文件、执行命令——操作被路由到节点侧执行
5. 对话下方的产物文件在容器 / 远端工作区上点击即按需下载查看

## 文档

- [需求文档](docs/spec/requirements.md)（EARS 规范，9 组需求）
- [技术设计](docs/spec/design.md)（架构、组件、数据模型、正确性不变量、测试策略）
- [实施计划](docs/spec/tasklist.md)（P0–P5 分阶段任务列表）

## 开发

```sh
pnpm install
pnpm build          # 构建全部包（tsdown：node ESM + client CJS bundle）
pnpm typecheck      # 类型检查
pnpm test           # vitest 单元测试
```

### 升级上游

```sh
./scripts/upgrade.sh [版本号]     # 默认拉取 latest dist-tag
```

自动 bump 全部 `package.json` → install → build → typecheck → test。

## 许可证

[MIT](LICENSE)
