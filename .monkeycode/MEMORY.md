# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-09-07
- Context: 用户要求发布 npm 包，Agent 完成 7 个包的首次发布
- Category: Operations & Deployment
- Instructions:
  - npm 账号：artenx；发布需 Granular Access Token（Read and write + 2FA bypass），web login 的经典 token 无发布权限（npm 新政策）
  - 包间依赖是 workspace:*，必须用 `pnpm --filter <name> publish --access public --no-git-checks` 发布（pnpm 会替换 workspace:*），npm publish 会原样发布导致安装失败
  - 裸名 `dshb` 被 npm 仿冒保护拒绝（与 shx/ssh2/tshy 太相似），聚合包已改名 `@artenx/dshb`；6 个子包保持裸名：dshb-auth、dshb-core、dshb-router、dshb-exec-ssh、dshb-exec-docker、dshb-ui
  - 首发版本 0.0.1；发布顺序：先子包后聚合包；发布前确认各包 lib/ 产物存在
  - token 存于 ~/.npmrc（权限 600），凭据不得在聊天或代码中展示
