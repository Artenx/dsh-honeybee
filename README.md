# DSH-HoneyBee（DSHB）

基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）二次开发的多节点 Agent 工作台。

## 概述

DSHB 划分为管理端与执行端：

- **管理端**：统一 Web 入口（单一 DSH 进程），负责认证授权、下发会话指令、收集会话返回内容，同时适配电脑与手机浏览器。agent loop、LLM 调用、会话日志与持久化全部集中在管理端。
- **执行端（工作节点）**：运行在本地或远程宿主机 / 容器中，接受会话指令，执行文件、命令、终端等工具层任务，结果返回管理端。节点类型：本地宿主、本地 Docker 容器、远程 SSH 宿主机、远程 Docker 容器；所有连接由管理端发起。

核心机制：镜像路径 + 执行世界路由器。每个远程工作区在管理端持有一个本地镜像目录作为会话 cwd（满足上游 workspace 的 realpath 校验），路由器把镜像根下的 `ctx.fs` / `ctx.subprocess` / `ctx.shell` / `ctx.terminals` 操作翻译到节点侧真实路径执行。

## 设计原则

- **纯插件交付**：全部能力以 DSH 插件包（bundle）实现，经 profile + `cordis.patch.yml` 组合，不修改上游源码，便于跟随上游版本升级。
- **单用户**：管理端认证为单管理员模型。
- **一期范围**：本地宿主 + 远程 SSH 节点；Docker 两类节点（含自定义镜像新建容器供给流水线）在二期交付。

## 文档

- [需求文档](docs/spec/requirements.md)（EARS 规范，9 组需求）
- [技术设计](docs/spec/design.md)（架构、组件、数据模型、正确性不变量、测试策略）
- [实施计划](docs/spec/tasklist.md)（P0–P5 分阶段任务列表）

## 状态

规格阶段。代码实现按实施计划推进。

## License

MIT
