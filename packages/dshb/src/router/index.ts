import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { decorateFileSystem } from './decorate-fs.js'
import { decorateSubprocess } from './decorate-subprocess.js'
import { decorateShell } from './decorate-shell.js'
import { sharedWorldResolver } from './resolve.js'

export const name = 'dshb-router'

export const inject = ['fs', 'subprocess', 'shell']

export function apply(ctx: Context): void {
  ctx.provide('dshbRouter', sharedWorldResolver())
  decorateFileSystem(ctx.fs)
  decorateSubprocess(ctx.subprocess)
  decorateShell(ctx.shell)
  decorateTerminalController(ctx)
}

interface TerminalAgentLike {
  session: { header: { cwd: string } }
}

interface TerminalControllerLike {
  execution(agent: TerminalAgentLike): { subprocess: SubprocessRuntime; sandboxPolicy: unknown }
}

function decorateTerminalController(ctx: Context): void {
  ctx.inject(['terminalController'], (terminalCtx: Context) => {
    const controller = (terminalCtx as unknown as { terminalController: TerminalControllerLike }).terminalController
    const originalExecution = controller.execution.bind(controller)

    controller.execution = (agent) => {
      const execution = originalExecution(agent)
      const ref = sharedWorldResolver().resolve(agent.session.header.cwd)
      if (ref.kind === 'local') return execution
      if (ref.kind === 'unrouted') throw new Error(`node ${ref.nodeId} world not available`)

      const subprocess = Object.create(execution.subprocess) as SubprocessRuntime
      subprocess.terminalEnvironment = ref.provider.subprocess.terminalEnvironment.bind(ref.provider.subprocess)
      subprocess.resolveExecutable = ref.provider.subprocess.resolveExecutable.bind(ref.provider.subprocess)
      return { ...execution, subprocess }
    }
  })
}

export { sharedWorldResolver } from './resolve.js'
export type { ExecutionWorldProvider, WorkspaceBindings, WorldRegistry, WorldRef, NodeTestReport } from './types.js'
