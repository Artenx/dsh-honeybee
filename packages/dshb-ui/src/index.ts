import type { Context } from '@deepseek-ai/cordis'
import { decorateDirectoryPicker } from './decorate-picker.js'

export const name = 'dshb-ui'

export const inject = ['directoryPicker']

export function apply(ctx: Context): void {
  decorateDirectoryPicker(ctx.directoryPicker)
}
