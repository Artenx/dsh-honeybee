import type { Context } from '@deepseek-ai/cordis'
import { sharedCredentialStore } from './credentials.js'
import { LoginRateLimiter } from './ratelimit.js'
import { registerAuthRoutes } from './routes.js'

export const name = 'dshb-auth'

export const inject = ['webServer']

export function apply(ctx: Context): void {
  registerAuthRoutes(ctx, sharedCredentialStore(), new LoginRateLimiter())
}
