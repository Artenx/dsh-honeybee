import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

interface WorkspaceItem {
  workspaceId: string
  title: string
  path: string
}

interface WorkspaceSnapshotLike {
  items: readonly WorkspaceItem[]
}

interface WorkspacesLike {
  list: {
    getSnapshot(): WorkspaceSnapshotLike
    subscribe(listener: () => void): () => void
  }
}

let injectedRegistry: WorkspacesLike | undefined

export function setWorkspaceRegistry(reg: WorkspacesLike): void {
  injectedRegistry = reg
}

function resolveWorkspaceByTitle(title: string): WorkspaceItem | undefined {
  const wks = injectedRegistry
  if (!wks) return undefined
  const items = wks.list.getSnapshot().items
  return items.find((w) => w.title === title)
}

const ROW_INJECT_FLAG = 'data-dshb-instr-row-bound'
const MENU_INJECT_FLAG = 'data-dshb-instr-menu-bound'
const MENU_ITEM_FLAG = 'data-dshb-instr-menu-item'

function mountInstructionDialog(workspaceId: string, workspaceTitle: string): void {
  if (!workspaceId) return

  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-overlay-mask,rgba(0,0,0,.45))'

  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-label', `修改 ${workspaceTitle} 的项目指令`)
  dialog.style.cssText = 'box-sizing:border-box;width:min(92vw,600px);max-height:85vh;overflow:auto;padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)'

  const title = document.createElement('h2')
  title.textContent = `项目指令 - ${workspaceTitle}`
  title.style.cssText = 'margin:0 0 10px;font-size:16px'

  const description = document.createElement('div')
  description.textContent = '此内容会注入该工作区的新对话。已有对话继续使用创建时的指令快照。'
  description.style.cssText = 'margin-bottom:10px;font-size:12px;color:var(--dsw-alias-label-secondary)'

  const textarea = document.createElement('textarea')
  textarea.placeholder = '留空则不注入指令...'
  textarea.spellcheck = false
  textarea.style.cssText = 'box-sizing:border-box;width:100%;min-height:280px;resize:vertical;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:13px monospace'

  const status = document.createElement('div')
  status.style.cssText = 'min-height:18px;margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary)'

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:14px'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = '取消'
  cancel.style.cssText = 'height:36px;padding:0 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer'
  const save = document.createElement('button')
  save.type = 'button'
  save.textContent = '保存'
  save.style.cssText = 'height:36px;padding:0 16px;border:0;border-radius:18px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer'

  const close = (): void => overlay.remove()
  cancel.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  dialog.addEventListener('click', (event) => event.stopPropagation())
  textarea.addEventListener('input', () => {
    const bytes = new TextEncoder().encode(textarea.value).length
    status.textContent = `${bytes} / 32768 字节`
    status.style.color = bytes > 32768 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)'
  })
  save.addEventListener('click', () => {
    void (async () => {
      const bytes = new TextEncoder().encode(textarea.value).length
      if (bytes > 32768) {
        status.textContent = `指令超过 32768 字节限制（当前 ${bytes} 字节）`
        status.style.color = 'var(--dsw-alias-state-error-primary)'
        return
      }
      save.disabled = true
      save.textContent = '保存中...'
      try {
        const revision = Number(overlay.dataset.revision ?? '0')
        const response = await fetch(`/api/dshb/instructions/${workspaceId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: textarea.value, expectedRevision: revision }),
        })
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string }
          status.textContent = body.error ?? `保存失败 (${response.status})`
          status.style.color = 'var(--dsw-alias-state-error-primary)'
          return
        }
        close()
      } catch {
        status.textContent = '保存失败'
        status.style.color = 'var(--dsw-alias-state-error-primary)'
      } finally {
        save.disabled = false
        save.textContent = '保存'
      }
    })()
  })

  actions.append(cancel, save)
  dialog.append(title, description, textarea, status, actions)
  overlay.append(dialog)
  document.body.append(overlay)

  status.textContent = '加载中...'
  void fetch(`/api/dshb/instructions/${workspaceId}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`读取失败 (${response.status})`)
      return response.json() as Promise<{ text?: string; revision?: number }>
    })
    .then((body) => {
      textarea.value = body.text ?? ''
      overlay.dataset.revision = String(body.revision ?? 0)
      textarea.dispatchEvent(new Event('input'))
      textarea.focus()
    })
    .catch((error: unknown) => {
      status.textContent = error instanceof Error ? error.message : '读取失败'
      status.style.color = 'var(--dsw-alias-state-error-primary)'
    })
}

export function registerWorkspaceInstructionMenu(ctx: ClientContext): void {
  const wks = (ctx as unknown as { workspaces?: WorkspacesLike }).workspaces
  if (wks) setWorkspaceRegistry(wks)

  let activeWorkspaceTitle = ''

  const findWorkspaceRow = (el: Node | null): HTMLElement | null => {
    let node = el instanceof HTMLElement ? el : null
    while (node) {
      if (node.className && typeof node.className === 'string' && node.className.includes('projectRow')) {
        return node
      }
      node = node.parentElement
    }
    return null
  }

  const getRowTitle = (row: HTMLElement): string | null => {
    const titleEl = row.querySelector('[class*="title"]')
    if (!titleEl) return null
    return titleEl.textContent ?? null
  }

  const injectMenuItem = (menuContainer: HTMLElement): void => {
    if (menuContainer.getAttribute(MENU_INJECT_FLAG) || menuContainer.querySelector(`[${MENU_ITEM_FLAG}]`)) return
    menuContainer.setAttribute(MENU_INJECT_FLAG, '1')

    const existingItems = menuContainer.querySelectorAll('button, [role="menuitem"]')
    let refItem: Element | null = null
    for (const item of Array.from(existingItems)) {
      const text = item.textContent ?? ''
      if (text.includes('重命名') || text.includes('Rename')) {
        refItem = item
        break
      }
    }
    if (!refItem) refItem = existingItems[existingItems.length - 1]
    if (!refItem) return

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('role', 'menuitem')
    btn.setAttribute(MENU_ITEM_FLAG, '1')
    if (refItem instanceof HTMLElement) {
      btn.className = refItem.className || ''
      btn.style.cssText = refItem.style.cssText
    }
    for (const className of Array.from(btn.classList)) {
      if (/danger|delete/i.test(className)) btn.classList.remove(className)
    }
    btn.style.color = 'var(--dsw-alias-label-primary)'
    btn.style.display = 'flex'
    btn.style.alignItems = 'center'
    btn.style.gap = '8px'

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('width', '16')
    icon.setAttribute('height', '16')
    icon.setAttribute('viewBox', '0 0 16 16')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('aria-hidden', 'true')
    icon.style.flex = 'none'
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M3 11.75V13h1.25l7.37-7.37-1.25-1.25L3 11.75Zm9.59-7.34a.66.66 0 0 0 0-.94l-1.06-1.06a.66.66 0 0 0-.94 0l-.83.83 1.25 1.25.83-.83.75.75Z')
    path.setAttribute('fill', 'currentColor')
    icon.append(path)
    const label = document.createElement('span')
    label.textContent = '修改指令'
    btn.append(icon, label)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      const ws = activeWorkspaceTitle ? resolveWorkspaceByTitle(activeWorkspaceTitle) : undefined
      mountInstructionDialog(ws?.workspaceId ?? '', activeWorkspaceTitle || 'Unknown')
    })

    refItem.parentElement?.insertBefore(btn, refItem.nextSibling)
  }

  const observer = new MutationObserver(() => {
    const projectRows = document.querySelectorAll('[class*="projectRow"]')
    for (const row of Array.from(projectRows)) {
      const rowEl = row as HTMLElement
      if (rowEl.getAttribute(ROW_INJECT_FLAG)) continue
      rowEl.setAttribute(ROW_INJECT_FLAG, '1')
      const iconBtns = rowEl.querySelectorAll('button[class*="iconButton"]')
      for (const btn of Array.from(iconBtns)) {
        const label = btn.getAttribute('aria-label') ?? ''
        if (label.includes('workspace') || label.includes('操作') || label.includes('actions')) {
          btn.addEventListener('click', () => {
            const title = getRowTitle(rowEl)
            if (title) activeWorkspaceTitle = title
          })
        }
      }
    }

    const menuItems = document.querySelectorAll('[role="menuitem"]')
    for (const item of Array.from(menuItems)) {
      const text = item.textContent ?? ''
      if (text.includes('删除') || text.includes('Delete') || text.includes('重命名') || text.includes('Rename')) {
        const container = item.closest('[role="menu"]') ?? item.parentElement
        if (container instanceof HTMLElement && !container.getAttribute(MENU_INJECT_FLAG)) {
          const row = findWorkspaceRow(container)
          if (row) {
            const title = getRowTitle(row)
            if (title) activeWorkspaceTitle = title
          }
          injectMenuItem(container)
        }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
