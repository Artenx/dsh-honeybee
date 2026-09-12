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

[Project Knowledge Summary]
- Date: 2026-09-12
- Context: Agent 合并 6 个子包为单一 `@artenx/dshb` 以适配社区插件市场收录（聚合包不被 awesome-dsh-plugin 收录，只收单插件）
- Category: Operations & Deployment
- Instructions:
  - 现仓库只有 `packages/dshb` 单包；npm 当前版本为 `@artenx/dshb@0.1.1`（含包内 README、只声明 DSH 0.1.5-rc.1 兼容并移除 type-only runtime peer）；旧 6 个 `dshb-*@0.0.5` 及 `@artenx/dshb@0.0.5/0.1.0` 已 deprecate，迁移指向 `dsh plugin --profile web add @artenx/dshb`
  - 生产 profile（/root/.dsh/profiles/web）`bundles` 仅 `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @artenx/dshb]`；`@artenx/dshb` link 指向 `/app/packages/dshb`；旧 `dshb-*` 软链接已重指向 `/app/_neutralized`（空目录）避免旧代码被加载
  - 构建：`pnpm build`（根）构建 packages/dshb（唯一 workspace 包）；服务器无构建环境，改本地构建后 `tar lib cordis.patch.yml package.json` 传服务器解压到 `/root/.dshb/dsh-honeybee/packages/dshb`
  - 服务器宿主 node 仅 v16（puppeteer-core 25 需 ≥18，无法跑浏览器测试）；dshb2 容器有 pnpm 11.25 + node 22；浏览器验证靠用户真实浏览器或临时 `node:22-bookworm` 容器装 chromium
  - DSH client-modules 通过 `require.resolve(<loader entry name>/package.json)` 发现 client bundle：cordis.patch 里 client 承载条目（dshb-ui）的 `name` 必须是裸包 `@artenx/dshb`（非子路径 `@artenx/dshb/ui`），子路径 spec 解析失败会被静默跳过致 client bundle 不入 boot graph；根 `.` 导出 ui 的 apply 供服务端加载
  - ssh2 Client 的 'error' 必须用持久 `on('error')`（非 `once`）：握手失败首 error 被 once 捕获后监听器移除，teardown 期间同连接第二个 error 变未处理事件致进程崩溃（dshb-exec-ssh/connection.ts connectOnce）
  - GitHub 推送用 PAT（Artenx 账号，值存于 agent 运行环境，不在仓库文件中记录）；awesome-dsh-plugin PR #4905 已开（CI 通过，待评审合并）；`dsh-plugin` topic 已设置，dshmarketplace.dev / dsh-plugin.org 自动扫描收录
