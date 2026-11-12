import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyAuth } from './auth.js'
import { apply as applyUi } from './ui.js'

export const inject = ['connection', 'workspaces', 'slots', 'layout', 'conversation', 'sessions', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  applyAuth(ctx)
  applyUi(ctx)
}
