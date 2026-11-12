# DSH HoneyBee (@artenx/dshb)

Turn DSH into an always-available, multi-device Agent workbench.

把 DSH 变成随时可用的多设备 Agent 工作台。

Add remote machines as execution nodes to your local DSH, then work with them as if they were local — sessions, file directories, and terminals all just work. Sync data between multiple DSH instances that have this plugin installed, and when deployed on a cloud server, the Web app supports login authentication.

将远程机器添加为本地 DSH 的执行节点后，即可像操作本地内容一样使用它们——会话环境、文件目录、终端开箱即用。支持在多个安装了本插件的 DSH 实例之间同步数据；部署在云服务器上时，Web 端支持登录认证。

## Highlights / 核心能力

- **Remote nodes as if local / 远程节点本地化操作** — Route filesystem, shell, subprocess, and PTY operations to local, SSH, or Docker execution nodes.文件系统、Shell、子进程与 PTY 操作可路由到本地、SSH 或 Docker 执行节点。
- **Remote sessions on demand / 远程会话按需打开** — Browse a remote node's sessions in your local sidebar and open them natively with one click.在本地侧边栏浏览远程节点的会话，一键原生打开。
- **Instance-to-instance sync / 实例间数据同步** — Keep sessions, workspaces, and project instructions in sync across DSH instances.会话、工作区与项目指令在 DSH 实例间保持同步。
- **Login protection for the Web app / Web 端登录认证** — An authentication gate with credential custody protects browser access.认证门禁与凭据托管保护浏览器端访问。
- **Mobile-aware management UI / 移动端管理界面** — Manage nodes and settings from a phone-friendly UI.手机友好的节点与设置管理界面。

## Install / 安装

```sh
dsh plugin --profile web add @artenx/dshb
```

Restart the corresponding DSH Web profile after installation. 安装后重启对应的 DSH Web profile。

Desktop app: install from **Settings → Plugins → More** in the DSH desktop app; the plugin takes effect on next startup. 桌面端在 **设置 → 插件 → 更多** 中安装，重启后生效。

The Authentication settings entry appears in the browser-based Web app. The DSH desktop shell uses the `dsh-app://` protocol and omits this entry; its loopback requests are admitted automatically. 认证设置入口仅在浏览器版 Web 应用中出现；桌面端使用 `dsh-app://` 协议，回环请求自动放行，因此不含该入口。

## Requirements / 环境要求

- Node.js 22.13 or newer
- DeepSeek Harness 0.1.7-rc.1, 0.2.1-rc.2, or 0.2.2-rc.1 (Web or Desktop)

Source code and complete documentation: https://github.com/Artenx/dsh-honeybee
源码与完整文档：https://github.com/Artenx/dsh-honeybee
