# DSH-HoneyBee 文档索引

## 项目文档

- [系统架构](ARCHITECTURE.md)：DSHB 组件边界、会话同步和加密离线归档。
- [接口定义](INTERFACES.md)：节点、同步 peer、会话归档、离线包 API 与来源版本。
- [开发指南](DEVELOPER_GUIDE.md)：构建、测试和类型检查命令。
- [同步基础模块](模块/Sync-Foundation.md)：节点/会话同步、冲突归档恢复和加密离线迁移。
- [Hybrid Logical Clock](专有概念/Hybrid-Logical-Clock.md)：同步版本排序规则。

## 规格文档

- [同步需求](../specs/2026-10-21-cloud-sync/requirements.md)
- [同步技术设计](../specs/2026-10-21-cloud-sync/design.md)
- [同步实施任务清单](../specs/2026-10-21-cloud-sync/tasklist.md)

跨实例节点/会话同步、A→B→C 来源回环去重、loopback SSH 密码/私钥认证及 `.dshb-sync` 加密离线往返均有集成测试覆盖。任务 8 的全量测试、类型检查和发布构建验证已完成。
