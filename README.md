# DSH-HoneyBee（DSHB）

<p align="center">
  <img src="assets/dshb-logo.jpg" alt="DSHB" width="80" />
</p>

<p align="center">
  <a href="README.en.md">English</a> | <a href="README.md">简体中文</a>
</p>

<p align="center">
  <strong>基于 deepseek-harness 的云端 Agent 工作台，随时随地开始实现你的想法</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT" /></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square" alt="dsh-plugin" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/upstream-dsh%400.2.1--rc.2-blue?style=flat-square" alt="upstream dsh 0.2.1-rc.2" /></a>
  <img src="https://img.shields.io/badge/status-developing-orange?style=flat-square" alt="status" />
</p>

一个 Web 入口同时驱动多台云主机或 Docker 容器。Agent 对话、LLM 调用、会话与持久化集中在管理端，文件读写、命令执行、终端操作透明分发到本地或远端节点执行。插件交付，不修改上游源码。适配手机浏览器，移动操作随手可及。

> 桌面版说明：DSH 桌面应用内部启动的是 `web` profile，dsh-honeybee 可直接在桌面应用的 **Plugins** 页安装。桌面版下 WebServer 仍绑定 `127.0.0.1`，本机回环请求自动放行认证门，因此桌面端无需登录即可使用；“认证”设置项仅在网页版显示。

---

## 特性

- **多节点执行**：本地宿主、本地 Docker、远程 SSH、远程 Docker 四类工作节点，连接由管理端统一发起
- **容器生命周期管理**：创建带镜像的 Docker 节点自动供给容器，支持拉起 / 重启 / 停止
- **按需拉取产物**：远端产生的文件点击即下载查看，无需回写本地
- **凭据托管**：SSH 密码 / 私钥由管理端统一托管
- **节点管理 UI**：节点增删改查、测试连接、目录树式添加工作区，内置移动端屏幕适配
- **工作区项目指令**：通过工作区操作菜单查看、修改并保存该工作区的项目指令，指令随同步传播到其他设备
- **多设备双向同步**：工作节点、工作区与会话在安装了本插件的多个 DSH 实例间自动双向同步（每 5 分钟调度，可随时停止），远端会话更新按事件增量传输，大附件走磁盘级流式通道
- **单管理员认证**：登录页 + 会话 Cookie，限制网络暴露入口

## 安装

### 前置要求

- Node.js >= 22.13
- pnpm >= 11
- 一份可运行的 DSH 环境
- 使用 Docker 节点需目标宿主机预装 Docker Engine

### npm 安装（推荐）

```sh
dsh plugin --profile web add @artenx/dshb
```

安装后重启对应 DSH Web profile。

桌面应用用户：打开 DSH 桌面应用 → **Settings → Plugins → More**，搜索 `@artenx/dshb` 并安装；**安装或升级后请重启一次桌面客户端**，使插件的服务端与界面同时生效。

### 一键源码部署

```sh
curl -fsSL https://raw.githubusercontent.com/Artenx/dsh-honeybee/main/scripts/bootstrap.sh | bash
```

脚本自动检测 `dsh`（已存在则跳过，不存在则使用固定版本）、克隆仓库、构建并安装单一 `@artenx/dshb` 插件。完成后按提示启动对应 DSH Web profile。

常用覆盖项：`DSH_HOME`（默认 `~/.dsh`）、`PROFILE`（默认 `web`）：

```sh
DSH_HOME="$HOME/.dsh-prod" PROFILE=prod \
  curl -fsSL https://raw.githubusercontent.com/Artenx/dsh-honeybee/main/scripts/bootstrap.sh | bash
```

### 从源码安装

```sh
pnpm install
pnpm build
# 装入 web profile
./scripts/install.sh
dsh --profile web
```

## 使用

1. 启动 `dsh web`（浏览器）并完成首次登录，或打开 DSH 桌面应用直接使用（桌面版自动放行本机回环请求）
2. 进入 **设置 → 工作节点**，添加节点（SSH 或 Docker），可先「测试连接」
3. 在会话区「添加工作区」，选择在线节点并从目录树选取远端目录
4. 在会话中直接读写文件、执行命令——操作自动路由到节点侧执行
5. 对话下方的产物文件点击即按需下载查看
6. 多设备使用：在另一台设备的 DSH 上安装本插件并添加同步节点（SSH 指向本机），工作节点、工作区与会话即自动双向同步；远端会话更新只传输增量内容

## 同步

- **添加同步节点**：设置 → 同步节点 → 新建，填写对端 SSH 信息与远端 Web 端口，保存后可「测试 SSH 握手」，并通过 SSH 自动探测对端的 DSH 目录、profile 与 Web 端口
- **自动同步**：同步时机选「每 5 分钟」后，工作节点、工作区与会话按调度自动双向同步；同步进行中可随时「停止同步」
- **同步范围**：远端会话有更新时，下次同步只传输尾部增量事件；大附件通过磁盘级流式通道传输，不占用同步内存预算
- **会话归档**：同步覆盖本地版本前，本地未同步的修改会自动归档保留，可在会话归档列表恢复

## 文档

- [需求文档](docs/spec/requirements.md)
- [技术设计](docs/spec/design.md)
- [实施计划](docs/spec/tasklist.md)

## 许可证

[MIT](LICENSE)
