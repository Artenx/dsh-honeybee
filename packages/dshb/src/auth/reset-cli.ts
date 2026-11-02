import { sanitizeUsername, sharedCredentialStore } from './credentials.js'

/**
 * 独立的凭据重置 CLI（`dshb-auth-reset`）。
 *
 * 历史上它是 `dsh --profile web auth-reset` 子命令，由 dshb-web-startup 替换
 * 上游 web-startup 实现。该替换会让 webServer 行（inject: [webStartup]）在
 * 运行时启用/停用插件的补丁重载中连带重建，拆断桌面端正在使用的连接
 * （0.1.33 及之前桌面端"启用即断连"的根因）。上游 web-startup 与本替换版
 * 功能等价（--host/--port/--trusted-host/--no-open 全部一致），因此 0.1.34
 * 起不再替换，auth-reset 降级为本独立命令。
 */
export function runAuthResetCli(argv: readonly string[]): never {
  const store = sharedCredentialStore()
  if (!store.isInitialized()) {
    console.error('dshb-auth-reset: 尚未初始化管理员账号')
    process.exit(1)
  }
  let password: string | undefined
  let username: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--password') password = argv[++i]
    else if (argv[i] === '--username') username = argv[++i]
  }
  if (password === undefined && username === undefined) {
    console.error('dshb-auth-reset: 需要 --password <新密码> 和/或 --username <新用户名>')
    process.exit(1)
  }
  if (password !== undefined && password.length < 8) {
    console.error('dshb-auth-reset: 密码至少 8 个字符')
    process.exit(1)
  }
  if (username !== undefined) {
    username = sanitizeUsername(username)
    if (!username) {
      console.error('dshb-auth-reset: 用户名不能为空')
      process.exit(1)
    }
  }
  if (password !== undefined) store.changePassword(username ?? store.username!, password)
  else store.changeUsername(username!)
  console.log('dshb-auth-reset: 已更新凭据并轮换会话密钥，全部已签发会话作废')
  process.exit(0)
}

const invokedDirectly = process.argv[1]?.endsWith('reset-cli.js') === true
  || process.argv[1]?.endsWith('dshb-auth-reset') === true
if (invokedDirectly) runAuthResetCli(process.argv.slice(2))
