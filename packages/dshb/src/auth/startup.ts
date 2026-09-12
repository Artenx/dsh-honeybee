import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'
import { sanitizeUsername, sharedCredentialStore } from './credentials.js'

export const name = 'web-startup'

export const inject = ['cmdlineArgs']

export const WEB_STARTUP_SERVICE = 'webStartup'

export interface WebStartupValues {
  openBrowser: boolean
  host?: string
  port?: number
  trustedHosts: string[]
}

function runAuthReset(args: readonly string[]): never {
  const store = sharedCredentialStore()
  if (!store.isInitialized()) {
    console.error('auth-reset: 尚未初始化管理员账号')
    process.exit(1)
  }
  let password: string | undefined
  let username: string | undefined
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--password') password = args[++i]
    else if (args[i] === '--username') username = args[++i]
  }
  if (password === undefined && username === undefined) {
    console.error('auth-reset: 需要 --password <新密码> 和/或 --username <新用户名>')
    process.exit(1)
  }
  if (password !== undefined && password.length < 8) {
    console.error('auth-reset: 密码至少 8 个字符')
    process.exit(1)
  }
  if (username !== undefined) {
    username = sanitizeUsername(username)
    if (!username) {
      console.error('auth-reset: 用户名不能为空')
      process.exit(1)
    }
  }
  if (password !== undefined) store.changePassword(username ?? store.username!, password)
  else store.changeUsername(username!)
  console.log('auth-reset: 已更新凭据并轮换会话密钥，全部已签发会话作废')
  process.exit(0)
}

function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option(
      '--trusted-host <authority...>',
      'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)',
    )
    .addHelpText(
      'after',
      `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 0.0.0.0           serve on all interfaces (DSHB: auth plugin guards access)
  dsh --profile web auth-reset --password <新密码>   reset admin credentials and revoke all sessions
`,
    )
}

export function apply(ctx: Context): void {
  const args = ctx.cmdlineArgs?.get() ?? []
  if (args[0] === 'auth-reset') runAuthReset(args)
  const program = webCommand()
  program.action(() => {
    const options = program.opts()
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    const values: WebStartupValues = {
      openBrowser: options.open,
      ...(options.host !== undefined && { host: options.host }),
      ...(options.port !== undefined && { port: Number(options.port) }),
      trustedHosts: options.trustedHost ?? [],
    }
    ctx.provide(WEB_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
