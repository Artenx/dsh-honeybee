import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * dshb 移动端屏幕适配（参考 dsh-web-mobile 实现，仅保留页面适配与目录抽屉
 * 切换，不含文件浏览 / 导出会话日志等功能按钮）。
 *
 * 机制与上游一致：dsh 客户端在窄屏会自动给 AppFrame 加 data-sidebar-collapsed
 * 折叠侧边栏；这里把侧边栏列（frame 的第一个 grid 子元素）用 CSS 抽屉化
 * （绝对定位 + transform 移出/滑入），并在会话头部注入一个切换按钮调用
 * ctx.layout.toggleSidebar()。窄屏判定与上游一致（<1024 且粗指针，避免桌面
 * 小窗误触发）。
 */
export const MOBILE_QUERY = '(max-width: 1023px) and (pointer: coarse)'

const FRAME_ATTR = 'data-dshb-mobile'
const COLLAPSED_ATTR = 'data-sidebar-collapsed'

const MOBILE_CSS = `
@media (max-width: 1023px) and (pointer: coarse) {
  html, body { touch-action: pan-y pinch-zoom !important; overscroll-behavior-x: none !important; }

  [${FRAME_ATTR}="frame"] {
    box-sizing: border-box !important;
    position: relative !important;
    grid-template-columns: minmax(0, 1fr) 0 0 !important;
    padding-top: env(safe-area-inset-top, 0px) !important;
  }

  /* 侧边栏列 -> 抽屉：默认移出屏幕，展开（无 collapsed）时滑入 */
  [${FRAME_ATTR}="frame"] > :first-child {
    position: absolute !important;
    inset: 0 auto 0 0 !important;
    width: max-content;
    max-width: 92vw;
    z-index: 40 !important;
    transform: translateX(-110%);
    transition: transform .28s ease-in-out;
    background: var(--dsw-alias-bg-base, #ffffff);
    padding-top: env(safe-area-inset-top, 0px) !important;
    border-right: none !important;
    touch-action: pan-y pinch-zoom !important;
  }
  [${FRAME_ATTR}="frame"]:not([${COLLAPSED_ATTR}]) > :first-child { transform: none !important; }
  @media (prefers-reduced-motion: reduce) {
    [${FRAME_ATTR}="frame"] > :first-child { transition: none !important; }
  }

  /* 拖拽手柄在触屏上无用 */
  [data-side="sidebar"], [data-side="details"] { display: none !important; }

  /* 对话区：去桌面滚动条占位，收窄 gutter，字号降一档 */
  [data-phase] [class*="_scrollBody"] { scrollbar-gutter: auto !important; scrollbar-width: none; }
  [data-phase] [class*="_scrollBody"]::-webkit-scrollbar { display: none !important; width: 0; height: 0; }
  [data-phase] [class*="_scroll"]:not([class*="_scrollBody"]):has(p) { padding-left: 20px; padding-right: 20px; font-size: 15px !important; }
  [data-phase] [class*="_scroll"]:not([class*="_scrollBody"]):has(p) p,
  [data-phase] [class*="_scroll"]:not([class*="_scrollBody"]):has(p) li,
  [data-phase] [class*="_scroll"]:not([class*="_scrollBody"]):has(p) [class*="_text_"] { font-size: 15px !important; }
  [data-phase] table { width: 100%; max-width: 100%; }
  [data-phase] th, [data-phase] td { max-width: none; min-width: 0; }
  [data-phase] [class*="_scroll"]:not([class*="_scrollBody"]) img { width: auto !important; max-width: 100% !important; height: auto !important; max-height: 220px !important; }
  [data-phase] [class*="_userStack"], [data-phase] [class*="_userStack"] [class*="_bubble"] { box-sizing: border-box; width: fit-content; max-width: 100%; }
  [data-phase] [class*="_actions"] { overflow: hidden; }

  /* 统计行（turns/steps/LLM/TPS）：窄屏横向滚动，指标可滑动看全 */
  [${FRAME_ATTR}="stats"] {
    display: flex !important;
    flex-wrap: nowrap !important;
    align-items: center;
    gap: 8px;
    overflow-x: auto !important;
    max-width: 100% !important;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  [${FRAME_ATTR}="stats"]::-webkit-scrollbar { display: none; }
  [${FRAME_ATTR}="stats"] > * { flex-shrink: 0 !important; white-space: nowrap !important; }

  /* 上下文用量弹窗（ContextMeter .JObwrW_panel）：上游 dsh-client-ui-trajectory 的
     [class*="panel"] 全局规则给它加了 max-width:100%!important，命中本弹窗，使宽度
     从 264px 塌缩到包含块(.root 28px)宽，内容竖排成竖条。窄屏解除该误伤。 */
  .JObwrW_panel { max-width: none !important; overflow-x: visible !important; }

  /* 头部：标题省略，tab 条横向滚动 */
  [${FRAME_ATTR}="frame"] [data-phase] header { padding-left: 44px; padding-right: 8px; }
  [${FRAME_ATTR}="frame"] [data-phase] header [class*="_crumbs"] { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap !important; }
  [${FRAME_ATTR}="frame"] [data-phase] header [role="tablist"] { flex-wrap: nowrap; gap: 0 16px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
  [${FRAME_ATTR}="frame"] [data-phase] header [role="tablist"]::-webkit-scrollbar { display: none; }
  [${FRAME_ATTR}="frame"] [data-phase] header [role="tablist"] > button { flex-shrink: 0; white-space: nowrap; }

  /* 设置对话框：窄屏近全宽 sheet（排除导出等普通对话框与目录选择器） */
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) {
    position: absolute !important;
    left: 8px !important;
    top: calc(env(safe-area-inset-top, 0px) + 12px) !important;
    width: calc(100vw - 16px) !important;
    max-width: calc(100vw - 16px) !important;
    height: auto !important;
    max-height: calc(100dvh - 24px - env(safe-area-inset-top, 0px)) !important;
    flex-direction: column !important;
    border-radius: 14px !important;
  }
  [aria-modal="true"]:not(:has(> :first-child > :last-child > button)) { max-width: calc(100vw - 32px) !important; }
  /* nav：横排换行（避免 CJK 标签竖排楼梯状），隐藏冗余 caption */
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :first-child {
    width: 100%;
    flex-direction: row !important;
    align-items: center;
    gap: 6px;
    padding: 10px 12px 8px;
  }
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :first-child > :first-child { display: none !important; }
  [aria-modal="true"] [class*="_navList"] { flex: 1 1 auto; min-width: 0; flex-direction: row !important; flex-wrap: wrap; gap: 6px; overflow: visible; }
  [aria-modal="true"] [class*="_navList"] > button { flex-shrink: 0; white-space: nowrap; }
  /* 外观模式卡片横排 */
  [aria-modal="true"] [class*="_cubeRow"] { gap: 6px; }
  [aria-modal="true"] [class*="_cubeRow"] > * { flex: 1 1 0; flex-direction: row !important; align-items: center; justify-content: center; gap: 6px; padding: 10px 8px; min-height: 0; }
  /* section 填充 sheet 宽度 */
  [aria-modal="true"] [class*="_section"] { width: 100% !important; max-width: none !important; }
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :last-child { flex: 1 1 auto; min-height: 0; }
  [aria-modal="true"]:has(> :first-child > :last-child > button):not(:has([role="navigation"])):not(:has([class*="ZuhsRW"])) > :last-child > :last-child { padding: 0 12px 24px; }

  /* 切换按钮：固定头部左侧 */
  [${FRAME_ATTR}="toggle"] {
    position: absolute !important;
    left: 8px !important;
    top: 12px !important;
    z-index: 2 !important;
    display: inline-flex !important;
    align-items: center; justify-content: center;
    width: 28px; height: 28px;
    padding: 0; border: none; background: none; cursor: pointer; color: inherit;
    -webkit-tap-highlight-color: transparent;
  }
}

/* 宽屏 / 鼠标指针：隐藏切换按钮 */
@media (min-width: 1024px), (pointer: fine) {
  [${FRAME_ATTR}="toggle"] { display: none !important; }
}
`

function findFrame(): HTMLElement | null {
  return document.querySelector('[data-shell-overlay]')?.parentElement ?? null
}

function getFrame(): HTMLElement | null {
  return document.querySelector(`[${FRAME_ATTR}="frame"]`) ?? findFrame()
}

/** viewport-fit=cover：让 safe-area-inset 生效，内容避开刘海/状态栏。 */
function installViewport(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(MOBILE_QUERY)
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (viewport === null) return () => {}
    const original = viewport.content
    const sync = (): void => {
      viewport.content = narrow.matches
        ? 'width=device-width, initial-scale=1, viewport-fit=cover'
        : original
    }
    sync()
    narrow.addEventListener('change', sync)
    return () => {
      narrow.removeEventListener('change', sync)
      viewport.content = original
    }
  }, 'dshb-mobile: viewport')
}

function installStyles(ctx: ClientContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dshb-mobile'
    tag.textContent = MOBILE_CSS
    document.head.appendChild(tag)
    // 保持在 head 最后，确保覆盖宿主样式
    setTimeout(() => { if (tag.isConnected) document.head.appendChild(tag) }, 0)
    return () => { tag.remove() }
  }, 'dshb-mobile: styles')
}

/** 给 AppFrame 打标记（drawer CSS 选择器挂载点），窄屏才打。 */
function installFrameMarker(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(MOBILE_QUERY)
    let frame: HTMLElement | null = null
    const clear = (): void => {
      if (frame !== null) frame.removeAttribute(FRAME_ATTR)
      frame = null
    }
    const ensure = (): void => {
      if (!narrow.matches) return
      frame = findFrame()
      if (frame !== null && !frame.hasAttribute(FRAME_ATTR)) frame.setAttribute(FRAME_ATTR, 'frame')
    }
    ensure()
    const mo = new MutationObserver(ensure)
    mo.observe(document.documentElement, { childList: true, subtree: true })
    const onChange = (): void => { if (narrow.matches) ensure(); else clear() }
    narrow.addEventListener('change', onChange)
    return () => {
      mo.disconnect()
      narrow.removeEventListener('change', onChange)
      clear()
    }
  }, 'dshb-mobile: frame marker')
}

/**
 * 抽屉打开时覆盖内容区的半透明遮罩，点击关闭；Escape 同样关闭；
 * 点击抽屉内的会话/导航项后关闭抽屉。
 */
function installDrawerInteractions(ctx: ClientContext, toggleSidebar: () => void): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(MOBILE_QUERY)
    let backdrop: HTMLElement | null = null
    const drawerOpen = (): boolean => {
      const frame = getFrame()
      return narrow.matches && frame !== null && !frame.hasAttribute(COLLAPSED_ATTR)
    }
    const sync = (): void => {
      if (drawerOpen() && backdrop === null) {
        backdrop = document.createElement('div')
        backdrop.setAttribute(`${FRAME_ATTR}-backdrop`, '')
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:39;background:rgba(0,0,0,.4);-webkit-tap-highlight-color:transparent;'
        backdrop.addEventListener('click', () => toggleSidebar())
        document.body.appendChild(backdrop)
      } else if (!drawerOpen() && backdrop !== null) {
        backdrop.remove()
        backdrop = null
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[aria-modal="true"]') !== null) return
      if (drawerOpen()) toggleSidebar()
    }
    const onClick = (event: MouseEvent): void => {
      if (!drawerOpen()) return
      const target = event.target
      if (!(target instanceof Element)) return
      const drawer = document.querySelector(`[${FRAME_ATTR}="frame"] > :first-child`)
      if (drawer === null || !drawer.contains(target)) return
      if (target.closest('[class*="sessionRow"] button') !== null) return
      if (target.closest('[class*="newSession"], [class*="sessionRow"], [role="treeitem"], [class*="searchResult"]') !== null) toggleSidebar()
    }
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [COLLAPSED_ATTR] })
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('click', onClick, true)
    narrow.addEventListener('change', sync)
    return () => {
      mo.disconnect()
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('click', onClick, true)
      narrow.removeEventListener('change', sync)
      backdrop?.remove()
    }
  }, 'dshb-mobile: drawer interactions')
}

/** 对话/输入框下方的统计行（turns/steps/LLM/TPS）：hashed class 无法直接选，按文本特征标记后由 CSS 横向滚动，避免溢出。 */
function installStatsLine(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(MOBILE_QUERY)
    // 统计行文本特征（"3 轮 · 5 步 · LLM 2.1s · 缓存命中 80%" 等），hashed class 无法直接选，按文本识别
    const STAT_RE = /(\d+\s*轮|\d+\s*步|tok\/s|缓存命中|首\s*token|工具调用|LLM\s*\d|\bturns\b|\bsteps\b)/
    const isStatsText = (el: Element): boolean => {
      const text = (el.textContent ?? '').trim()
      if (text.length === 0 || text.length > 160) return false
      if (!STAT_RE.test(text)) return false
      if (el.querySelector('textarea, input, button, select, a') !== null) return false
      return true
    }
    const mark = (): void => {
      if (!narrow.matches) return
      // 清除失效/不再匹配的标记
      document.querySelectorAll(`[${FRAME_ATTR}="stats"]`).forEach((el) => {
        if (!el.isConnected || !isStatsText(el)) el.removeAttribute(FRAME_ATTR)
      })
      // 候选：含统计特征的短文本元素，取最浅容器（统计行整行）标记
      const cands = Array.from(document.querySelectorAll('[data-phase] *')).filter(isStatsText)
      for (const el of cands) {
        if (el.hasAttribute(FRAME_ATTR)) continue
        let anc = el.parentElement
        let hasOuterCand = false
        while (anc && anc.closest('[data-phase]') !== null) {
          if (cands.includes(anc)) { hasOuterCand = true; break }
          anc = anc.parentElement
        }
        if (!hasOuterCand) el.setAttribute(FRAME_ATTR, 'stats')
      }
    }
    mark()
    const mo = new MutationObserver(() => { if (narrow.matches) mark() })
    mo.observe(document.documentElement, { childList: true, subtree: true })
    narrow.addEventListener('change', mark)
    return () => {
      mo.disconnect()
      narrow.removeEventListener('change', mark)
    }
  }, 'dshb-mobile: stats line')
}

interface LayoutLike { toggleSidebar(): void }
interface SlotsLike {
  inject(name: string, fn: () => unknown): unknown
  register(spec: Record<string, unknown>, component: unknown): unknown
}

/** 目录抽屉切换按钮（仅切换，不含文件浏览/日志导出等功能按钮）。 */
function DrawerToggle({ toggleSidebar }: { toggleSidebar: () => void }) {
  return (
    <button type="button" data-dshb-mobile="toggle" aria-label="打开目录" title="打开目录" onClick={() => toggleSidebar()}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  )
}

/** 安装移动端适配：样式 + viewport + 抽屉标记 + 抽屉交互 + 切换按钮。 */
export function installMobile(ctx: ClientContext): void {
  installStyles(ctx)
  installViewport(ctx)
  installFrameMarker(ctx)
  installStatsLine(ctx)
  const layout = (ctx as unknown as { layout?: LayoutLike }).layout
  const slots = (ctx as unknown as { slots?: SlotsLike }).slots
  if (layout && typeof layout.toggleSidebar === 'function') {
    installDrawerInteractions(ctx, () => layout.toggleSidebar())
  }
  if (slots && layout) {
    slots.inject('conversation.session.header.actions', () =>
      slots.register(
        {
          name: 'conversation.session.header.actions',
          id: 'dshb-mobile-toggle',
          order: 10,
          inject: () => ({ toggleSidebar: () => layout.toggleSidebar() }),
        },
        DrawerToggle,
      ),
    )
  }
}
