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
  - 生产 profile（宿主 `/root/.dsh/profiles/web`，容器 `/data/dsh/profiles/web`）当前 `bundles` 为 `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @artenx/dshb]`；`@artenx/dshb` link 指向 `/app/packages/dshb`；旧 `dshb-*` 软链接已重指向 `/app/_neutralized`（空目录）避免旧代码被加载
  - 构建：`pnpm build`（根）构建 packages/dshb（唯一 workspace 包）；服务器无构建环境，改本地构建后 `tar lib cordis.patch.yml package.json` 传服务器解压到 `/root/.dshb/dsh-honeybee/packages/dshb`
  - 服务器宿主 node 仅 v16（puppeteer-core 25 需 ≥18，无法跑浏览器测试）；生产 DSH 运行于 `dshb2` 容器，宿主 `/root/.dsh` 挂载到容器 `/data/dsh`、仓库挂载到 `/app`，容器有 pnpm 11.25 + node 22；插件须在容器中执行 `dsh plugin --profile web add <package>`，宿主全局 npm 安装不会加入 DSH profile
  - pnpm 11 安装 profile 插件时若报 `ERR_PNPM_IGNORED_BUILDS`，在 profile 的 `pnpm-workspace.yaml` 中将提示的既有 DSH 原生依赖加入 `allowBuilds: true` 后重跑安装；成功后 DSH CLI 会自动把声明 `dsh.bundle` 的包加入 bundles
  - DSH client-modules 通过 `require.resolve(<loader entry name>/package.json)` 发现 client bundle：cordis.patch 里 client 承载条目（dshb-ui）的 `name` 必须是裸包 `@artenx/dshb`（非子路径 `@artenx/dshb/ui`），子路径 spec 解析失败会被静默跳过致 client bundle 不入 boot graph；根 `.` 导出 ui 的 apply 供服务端加载
  - ssh2 Client 的 'error' 必须用持久 `on('error')`（非 `once`）：握手失败首 error 被 once 捕获后监听器移除，teardown 期间同连接第二个 error 变未处理事件致进程崩溃（dshb-exec-ssh/connection.ts connectOnce）
  - GitHub 推送用 PAT（Artenx 账号，值存于 agent 运行环境，不在仓库文件中记录）；awesome-dsh-plugin PR #4905 已合并（2026-09-13）；`dsh-plugin` topic 已设置，dshmarketplace.dev / dsh-plugin.org 自动扫描收录

[Project Knowledge Summary]
- Date: 2026-09-13
- Context: Agent 发布 @artenx/dshb@0.1.3 并梳理 awesome-dsh-plugin 市场同步机制
- Category: Operations & Deployment
- Instructions:
  - 生产/说明：本 agent 环境当前无有效 GitHub 凭据（`git credential fill` 经 `/app/agent/bin/agent git-credential-helper` 返回 32 位占位值，github.com 返回 401），无法 push 或开 PR；需用户提供 PAT 或重新认证。npm 凭据有效（`npm whoami`=artenx）
  - npm 自 2026-09 起对启用 2FA 的账号采用分阶段发布（staged publishing）：`pnpm publish` 可能只暂存并返回成功文案，`npm publish` 对其重发会报 409 `Cannot publish over previously staged version`；该报错也可能只是 CDN 传播竞态，需用 token 查权威数据 `GET https://registry.npmjs.org/<pkg>?write=true` 的 `dist-tags`/`versions` 才能确认真实发布状态
  - 查询/处理暂存：`pnpm stage list` / `npm stage list`（npm≥11，API `GET /-/stage`）；批准用 `npm stage approve <stage-id>`，必须维护者 2FA（`--otp`），带 bypass 2FA 的 GAT 不免除批准
  - awesome-dsh-plugin 同步机制：条目来自 `data/plugins/<owner>__<repo>--<subpath>.yml`（本插件为 `Artenx__dsh-honeybee--packages-dshb.yml`）；`.github/workflows/build-site.yml` 每日 02:23 UTC 全量探测 `probe-npm`（记录 registry `dist-tags.latest`）/`probe-readmes`/`probe-stars` 等，再经 `publish-catalog.mjs` 发布 npm 包 `dsh-plugin-catalog`；因此 **版本号、README、星标会自动同步**，但 YAML 里的一行描述属静态内容，只有改 YAML 的 PR 才会更新
  - 发布 npm 新版本后无需向 awesome 列表重新提交；若要让列表描述体现新特性，需另提改 YAML 描述的小 PR

[Project Knowledge Summary]
- Date: 2026-09-23
- Context: Agent 排查用户报告的 "web boot: N entries did not activate"（30 个 client 插件 pending）时定位到 DSHB 前端 boot-race 兼容层的脆弱匹配
- Category: Troubleshooting & Debugging
- Instructions:
  - "web boot: N entries did not activate" 来自浏览器侧 `@deepseek-ai/dsh-client-web` 的 `AppWebEntry.assertEntriesActive`（`packages/client/web/src/boot.ts`）；pending 项是 client 侧 Cordis 服务缺失，常见根因是 api-remotes 动态 `remote.*` 命名空间未就绪，级联致 session/workspace controller 及全部 UI 插件 pending，并非 DSHB 插件注册失败
  - `dshb-auth` 的 `registerFrontendBootRaceWorkaround` 在 `assertEntriesActive` 前插入 8s 延迟规避该竞态；替换锚点不可写死 minified 标识符（换 DSH 构建后标识符变化会静默 no-op），须按形状正则匹配：`/await ([A-Za-z_$][\w$]*)\.await\(\),this\.assertEntriesActive\(([A-Za-z_$][\w$]*)\)/`
  - 排查：在 profile 的 `node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js` 中 grep `assertEntriesActive`，核对实际 minified 调用形态
