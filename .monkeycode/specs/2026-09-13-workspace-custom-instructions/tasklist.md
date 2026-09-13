# 需求实施计划

- [x] 1. 实现工作区指令与会话快照存储
  - [x] 1.1 定义 WorkspaceInstructionRecord、SessionInstructionSnapshot 和存储错误类型，实现 UTF-8 字节限制、摘要与 revision 校验（需求 1.2、1.4、1.5、4.1、4.4）
  - [x] 1.2 实现工作区配置的读取、原子更新、清空和 revision 冲突处理（需求 1.1-1.4、6.4、6.5）
  - [x] 1.3 实现 SessionId 快照 create-if-absent、读取、父会话继承和清理（需求 3.3-3.5、4.1-4.5、7.1-7.3）
  - [x] 1.4 为存储边界、不可变性、并发冲突和生命周期编写单元测试（正确性属性 1、3、4、5、6）

- [x] 2. 实现工作区项目指令 REST API
  - [x] 2.1 注册 GET/PUT workspace instruction 路由并复用 DSHB auth gate（需求 1.1-1.5）
  - [x] 2.2 校验 WorkspaceId、请求体、expectedRevision 和 UTF-8 字节长度，映射 400、404、409 响应（需求 1.4、1.5、6.1）
  - [x] 2.3 为读取、保存、清空、冲突、超限和未知工作区编写路由测试（需求 1.1-1.5）

- [x] 3. 实现新对话项目指令注入器
  - [x] 3.1 在 agent/pre-step 识别首次直接用户消息，通过 cwd 解析 WorkspaceId 并创建快照（需求 3.1-3.5、6.1-6.3）
  - [x] 3.2 渲染 durable user-role system-reminder 消息，转义闭合标签并写入 source metadata（需求 4.2-4.4、5.1-5.5）
  - [x] 3.3 实现 resume、surface 缺失重注入、空快照和子代理继承（需求 4.2-4.5、7.1-7.3）
  - [x] 3.4 为首次交互、blank session、旧会话冻结、resume、空配置和子代理继承编写集成测试（正确性属性 1、2、4-7）
  - [x] 3.5 检查点：确保所有测试通过,如有疑问请询问用户

- [x] 4. 实现项目指令设置页
  - [x] 4.1 实现客户端 API 与 reactive workspace 列表接入（需求 2.1、2.2）
  - [x] 4.2 注册“项目指令”settings.section，实现工作区选择、多行编辑、字节计数和保存状态（需求 2.1、2.2、2.4）
  - [x] 4.3 实现 dirty 切换确认、revision 冲突和错误反馈（需求 2.3、2.5）
  - [x] 4.4 为设置页读取、编辑、保存、切换确认和错误状态编写组件测试（需求 2.1-2.5）

- [x] 5. 完成组合接入与回归验证
  - [x] 5.1 将 store、API、injector 和 client section 接入 @artenx/dshb 组合与 exports（覆盖全部需求）
  - [x] 5.2 验证本地、SSH、Docker workspace 及 workspace rename/delete 行为（需求 6.1-6.5）
  - [x] 5.3 运行完整测试、类型检查、构建和发布包内容检查（覆盖全部需求）
  - [x] 5.4 检查点：确保所有测试通过,如有疑问请询问用户
