import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../../src/client/auth.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('auth settings section environment', () => {
  it.each(['dsh-app:', 'file:'])('does not install the auth section in the Desktop shell (%s)', (protocol) => {
    vi.stubGlobal('location', { protocol })
    const plugin = vi.fn()
    const ctx = { get: () => ({}), plugin } as unknown as ClientContext

    apply(ctx)

    expect(plugin).not.toHaveBeenCalled()
  })

  it.each(['http:', 'https:'])('registers the auth section in the web app (%s)', (protocol) => {
    vi.stubGlobal('location', { protocol })
    const plugins: Array<{ apply: (ctx: ClientContext) => void }> = []
    const ctx = {
      get: () => ({}),
      plugin: (plugin: { apply: (ctx: ClientContext) => void }) => plugins.push(plugin),
    } as unknown as ClientContext

    apply(ctx)

    const register = vi.fn()
    const inject = vi.fn((_name: string, contribution: () => void) => contribution())
    plugins[0]?.apply({ slots: { inject, register } } as unknown as ClientContext)

    expect(inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      { name: 'settings.section', id: 'auth', order: 100, label: expect.any(Function) },
      expect.any(Function),
    )
  })
})
