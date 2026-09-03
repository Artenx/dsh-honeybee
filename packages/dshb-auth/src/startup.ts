import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'web-startup'

export const inject = ['cmdlineArgs']

export const WEB_STARTUP_SERVICE = 'webStartup'

export interface WebStartupValues {
  openBrowser: boolean
  host?: string
  port?: number
  trustedHosts: string[]
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
`,
    )
}

export function apply(ctx: Context): void {
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
