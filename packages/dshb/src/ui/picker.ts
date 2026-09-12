import { homedir } from 'node:os'
import { readdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import DirectoryPicker, { type DirectoryListing, type DirectoryEntry, type DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'

function entry(path: string, hidden: boolean): DirectoryEntry {
  return { name: path.split('/').filter(Boolean).pop() ?? '/', path, hidden }
}

export default class DshbDirectoryPicker extends DirectoryPicker {
  constructor(ctx: Context) {
    super(ctx)
  }

  capability(): DirectoryPickerBrowseCapability {
    return {
      kind: 'browse',
      list: async (path?: string): Promise<DirectoryListing> => {
        const target = path ?? homedir()
        const names = readdirSync(target, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
        const entries = names.map((name) => entry(`${target.replace(/\/+$/, '')}/${name}`, name.startsWith('.')))
        const crumbs: DirectoryEntry[] = []
        const parts = target.split('/').filter(Boolean)
        let acc = ''
        crumbs.push({ name: '/', path: '/', hidden: false })
        for (const part of parts) {
          acc += `/${part}`
          crumbs.push({ name: part, path: acc, hidden: false })
        }
        return { path: target, home: homedir(), crumbs, entries, truncated: false }
      },
      createDirectory: async (path: string, name: string): Promise<string> => {
        const { mkdirSync } = await import('node:fs')
        const created = `${path.replace(/\/+$/, '')}/${name}`
        mkdirSync(created, { recursive: true })
        return created
      },
    }
  }
}
