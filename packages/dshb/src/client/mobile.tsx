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

/** 纯视口宽度判定：与放宽后的 MOBILE_CSS 媒体查询一致（不依赖 pointer 类型）。 */
const NARROW_QUERY = '(max-width: 1023px)'

const FRAME_ATTR = 'data-dshb-mobile'
const COLLAPSED_ATTR = 'data-sidebar-collapsed'

const MOBILE_CSS = `
/* 仅按视口宽度判定，不绑定 pointer:coarse —— 触屏笔记本 / DevTools 响应式模式
   常报 pointer:fine，绑定 coarse 会让全部窄屏修复失效。抽屉相关选择器都挂在
   [data-dshb-mobile] 标记上，标记由 JS 的 coarse 判定添加，故放宽 CSS 不会误开抽屉。 */
@media (max-width: 1023px) {
  html, body { touch-action: pan-y pinch-zoom !important; overscroll-behavior-x: none !important; -webkit-text-size-adjust: 100% !important; text-size-adjust: 100% !important; }

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
    gap: 6px;
    overflow-x: auto !important;
    max-width: 100% !important;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  [${FRAME_ATTR}="stats"]::-webkit-scrollbar { display: none; }
  [${FRAME_ATTR}="stats"] > * { flex-shrink: 0 !important; white-space: nowrap !important; }
  [${FRAME_ATTR}="stats"] { gap: 6px !important; }
  [class*="composerStack"] { gap: 4px !important; }
  /* stats line 竖线分隔符(|)两边 margin 10px 太松，适度收紧 */
  [data-phase] [class*="_sep"] { margin: 0 3px !important; }

  /* 每轮回复下方的统计文字（footer）：收紧 actions 内部 gap 与气泡到 footer 间距，减少松散感 */
  [data-phase] [class*="_actions"] { gap: 4px !important; }
  [data-phase] [class*="_actions"] [class*="_timeEnd"] { gap: 4px !important; padding-left: 6px !important; }
  [data-phase] [class*="userRow"], [data-phase] [class*="assistantRow"] { gap: 4px !important; }
  /* 点号(·)左右 margin 10px 太松，收紧并抵消前后空格 */
  [data-phase] [class*="_runTimeDot"] { margin: 0 -2px !important; }
  /* footer 容器各项间距 16px 偏松 */
  [data-phase] [class*="_root"][class*="osXY9a"] { gap: 8px !important; }
  /* footer 统计行窄屏可横向滑动看全，不溢出页面 */
  [data-phase] [class*="_actions"] { max-width: 100% !important; overflow-x: auto !important; scrollbar-width: none; touch-action: pan-x pan-y !important; }
  [data-phase] [class*="_actions"]::-webkit-scrollbar { display: none; }

  /* 模型切换菜单：名称完整展示，长名称在菜单项内换行。 */
  [class*="_submenu_"] [class*="_itemLabel_"] {
    overflow: visible !important;
    text-overflow: clip !important;
    white-space: normal !important;
    overflow-wrap: anywhere;
  }

   /* 模型选择器（dsh-client-ui-model-selection，CSS 模块前缀 7KE1Ra_）：
      列表内模型名/描述默认 ellipsis 截断，改换行完整显示。除当前 hash 外，
      再加 modelName 语义匹配，防止上游升级换 hash 后规则失效。
      注意：必须用 break-word 而非 anywhere —— anywhere 让文字 min-content
      宽度≈1 字符，配合全局 * {min-width:0} 会把 flex 行内名字列压到 1 字符宽，
      出现"一字符就换行"。break-word 的 min-content 取最长词宽，只在真正
      放不下时才断词。 */
   [class*="7KE1Ra_modelName"],
   [class*="7KE1Ra_description"],
   [class*="modelName"] {
     white-space: normal !important;
     overflow-wrap: break-word;
     text-overflow: clip !important;
     overflow: visible !important;
   }

  /* 模型选择器弹窗：JS（installModelMenuPosition）在窄屏下改为 position:fixed
     视口级浮层（fixed 不受祖先 overflow 裁剪），这里仅做静态兜底（JS 未生效时
     仍从触发按钮左缘向右展开、宽度收进视口）。 */
  [class*="7KE1Ra_menu"],
  [class*="_menu"]:has([class*="modelName"]) {
    left: 0 !important;
    right: auto !important;
    width: calc(100vw - 32px) !important;
    min-width: 0 !important;
    max-width: calc(100vw - 32px) !important;
    overflow-y: auto !important;
    max-height: calc(100vh - 120px) !important;
  }

  /* 工具调用执行结果/代码/JSON：窄屏可横向滑动。details 抽屉宽 min(92%,420px)
     较窄，命令行输出/JSON 长行溢出被外层 overflow:hidden 裁剪看不到。命令行输出
     改 white-space:pre（保持原格式不折行，像终端）+ overflow-x:auto 横向滑动；
     min-width:0+max-width:100% 约束宽度触发滚动。 */
  [data-phase] [class*="resultBlockText"],
  [data-phase] [class*="payload"]:not([class*="errorPayload"]),
  [data-phase] [class*="sourceBlockContent"] {
    white-space: pre !important;
    min-width: 0 !important;
    max-width: 100% !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    touch-action: pan-x pan-y !important;
  }
  [data-phase] [class*="resultBlockText"]::-webkit-scrollbar,
  [data-phase] [class*="payload"]::-webkit-scrollbar,
  [data-phase] [class*="sourceBlockContent"]::-webkit-scrollbar { display: none !important; }

  /* JSON 预览/代码块/promptDiff：横向滑动（不折行，保持格式） */
  [data-phase] [class*="jsonPayload"],
  [data-phase] [class*="jsonPreview"],
  [data-phase] [class*="promptDiff"],
  [data-phase] [class*="overviewPreview"],
  [data-phase] [class*="resultBlocks"],
  [data-phase] pre {
    min-width: 0 !important;
    max-width: 100% !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    touch-action: pan-x pan-y !important;
  }
  [data-phase] [class*="jsonPayload"]::-webkit-scrollbar,
  [data-phase] [class*="jsonPreview"]::-webkit-scrollbar,
  [data-phase] [class*="promptDiff"]::-webkit-scrollbar,
  [data-phase] [class*="overviewPreview"]::-webkit-scrollbar,
  [data-phase] [class*="resultBlocks"]::-webkit-scrollbar,
  [data-phase] pre::-webkit-scrollbar { display: none !important; }

  /* dsh-client-ui-tool 工具卡片（Bash 等命令输出，class 前缀 o3BgMG_）：
     bodyScroll/ioSection 只有 overflow-y:auto，横向溢出传到 row{overflow:hidden}
     被裁剪且无法滑动。给输出容器链设 overflow-x:auto（不覆盖上游 overflow-y），
     让终端格式长行在卡片内横向滑动。 */
  [data-phase] [class*="bodyScroll"],
  [data-phase] [class*="ioCard"],
  [data-phase] [class*="ioSection"],
  [data-phase] [class*="terminalBody"],
  [data-phase] [class*="codeBody"] {
    min-width: 0 !important;
    max-width: 100% !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    touch-action: pan-x pan-y !important;
  }
  [data-phase] [class*="bodyScroll"]::-webkit-scrollbar,
  [data-phase] [class*="ioCard"]::-webkit-scrollbar,
  [data-phase] [class*="ioSection"]::-webkit-scrollbar,
  [data-phase] [class*="terminalBody"]::-webkit-scrollbar,
  [data-phase] [class*="codeBody"]::-webkit-scrollbar { display: none !important; }

  /* 终端组件（dsh-web-frontend，CSS 模块前缀 1gdtu_）：多行命令上游按行渲染成
     多个 _promptLine_>_command_ 元素，行级不能各自设 overflow（会变成每行独立
     滚动）。唯一横向滚动容器是公共祖先 _header_1gdtu_32（本就 overflow-y:auto）：
     行链 _prompt_/_promptLine_/_command_ 全部撑到 max-content 且 overflow 可见，
     长行内容溢出传入 _header_ 的 scrollWidth，所有行随 _header_ 同步滚动。
     _output_1gdtu_156（输出区）同理以其为唯一容器，_line_ 撑宽不裁剪。 */
  [data-phase] [class*="_header_1gdtu_"] {
    min-width: 0 !important;
    max-width: 100% !important;
    overflow-x: auto !important;
    overscroll-behavior-x: contain;
    touch-action: pan-x pan-y !important;
  }
  [data-phase] [class*="_prompt_1gdtu_"],
  [data-phase] [class*="_promptLine_1gdtu_"],
  [data-phase] [class*="_command_1gdtu_"] {
    min-width: max-content !important;
    max-width: none !important;
    overflow: visible !important;
    /* Android Chrome TextAutosizer 按块宽计算 font boosting，max-content 行宽不一
       导致各行字号参差；max-height 是其豁免条件，禁用放大并锁定继承字号。 */
    max-height: 999999px !important;
  }
  [data-phase] [class*="_command_1gdtu_"] {
    display: inline-block;
    text-overflow: clip !important;
    white-space: pre !important;
  }
  [data-phase] [class*="_copyButton_1gdtu_"] { position: sticky !important; right: 0; }
  [data-phase] [class*="_output_1gdtu_"] {
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    touch-action: pan-x pan-y !important;
  }
  [data-phase] [class*="_output_1gdtu_"]::-webkit-scrollbar { display: none !important; }
  [data-phase] [class*="_line_1gdtu_"] {
    min-width: max-content !important;
    overflow-x: visible !important;
    max-height: 999999px !important;
  }

  /* 复制按钮周边也允许纵向页面手势，避免代码/总结区域形成触控死区。 */
  [data-phase] [class*="_copyButton_"] { touch-action: manipulation !important; }
  [data-phase] [class*="_copyAnchor_"],
  [data-phase] [class*="_body_1ye18_"],
  [data-phase] [class*="_root_4qrvp_"] { touch-action: pan-x pan-y !important; }

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

  /* 首页/hero（无活跃会话，session header 不存在）的抽屉切换 FAB：
     浮在顶部相机带下方，避免与 hero 头部内容重叠 */
  [${FRAME_ATTR}="fab"] {
    position: absolute !important;
    top: calc(env(safe-area-inset-top, 0px) + 72px) !important;
    left: 10px !important;
    z-index: 21 !important;
    display: inline-flex !important;
    align-items: center; justify-content: center;
    width: 38px; height: 38px;
    padding: 0;
    border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12)) !important;
    border-radius: 50% !important;
    background: var(--dsw-alias-button-floating-fill, #ffffff) !important;
    color: var(--dsw-alias-label-primary, inherit) !important;
    cursor: pointer !important;
    box-shadow: 0 2px 12px rgba(0, 0, 0, .18) !important;
    -webkit-tap-highlight-color: transparent;
  }
}

/* 宽屏 / 鼠标指针：隐藏切换按钮 */
@media (min-width: 1024px), (pointer: fine) {
  [${FRAME_ATTR}="toggle"], [${FRAME_ATTR}="fab"] { display: none !important; }
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
      if (target.closest('button, a, [role="button"]') !== null) return
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
    // 统计行文本特征（"3 轮 · 5 步 · LLM 2.1s · 缓存命中 80%" 等），hashed class 无法直接选，按文本识别。
    // 含"轮/步/turns/steps"即可（footer 不含这些），无需额外排除 footer。
    const STATS_LINE_RE = /(\d+\s*轮|\d+\s*步|\bturns\b|\bsteps\b)/
    const isStatsText = (el: Element): boolean => {
      const text = (el.textContent ?? '').trim()
      if (text.length === 0 || text.length > 160) return false
      if (!STATS_LINE_RE.test(text)) return false
      if (el.querySelector('textarea, input, button, select, a') !== null) return false
      return true
    }
    const mark = (): void => {
      if (!narrow.matches) return
      // 清除失效标记：行容器仍含统计特征（轮/步）才保留
      document.querySelectorAll(`[${FRAME_ATTR}="stats"]`).forEach((el) => {
        if (!el.isConnected || !STATS_LINE_RE.test((el.textContent ?? '').trim())) el.removeAttribute(FRAME_ATTR)
      })
      // 候选：含统计特征的短文本元素（全文档搜索，含 composer 内的 stats line），取最浅容器标记
      // 排除 display:contents（无 box，overflow 无效，会误占最浅候选）
      const cands = Array.from(document.querySelectorAll('span, div')).filter((el) => {
        if (!isStatsText(el)) return false
        if (getComputedStyle(el).display === 'contents') return false
        return true
      })
      for (const el of cands) {
        if (el.hasAttribute(FRAME_ATTR)) continue
        let anc = el.parentElement
        let hasOuterCand = false
        while (anc) {
          if (cands.includes(anc)) { hasOuterCand = true; break }
          anc = anc.parentElement
        }
        if (!hasOuterCand) {
          // 标最浅含统计的容器本身（整行），使其可横向滚动
          if (!el.hasAttribute(FRAME_ATTR)) el.setAttribute(FRAME_ATTR, 'stats')
        }
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

/** 浮层 fixed 定位需管理的内联样式键，清理时逐一移除以交还上游 CSS。 */
const SHEET_PROPS = [
  'position', 'width', 'left', 'right', 'top', 'bottom',
  'min-width', 'max-width', 'max-height', 'overflow-y', 'box-sizing',
] as const

/**
 * 把挂在 composer 内部的绝对定位浮层统一改造成 position:fixed 视口级浮层：
 * 水平居中（左右各留 8px，绝不贴边/溢出），高度按视口比例封顶并内容滚动，
 * 触发元素上方空间足够则向上展开、否则向下展开，四边都约束在视口内。
 * fixed 不受祖先 overflow 裁剪（祖先带 transform 时失效）。
 */
function positionFixedSheet(
  el: HTMLElement,
  rootRect: DOMRect,
  maxWidth: number,
  maxHeightRatio: number,
): void {
  const margin = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.max(0, Math.min(maxWidth, vw - margin * 2))
  const left = Math.round((vw - width) / 2)
  const maxH = Math.round(vh * maxHeightRatio)
  const spaceAbove = rootRect.top - margin
  const spaceBelow = vh - rootRect.bottom - margin
  const expandUp = spaceAbove >= 140 && spaceAbove >= spaceBelow
  let top: number
  if (expandUp) {
    const h = Math.min(maxH, Math.max(spaceAbove, 140))
    top = rootRect.top - margin - h
  } else {
    top = rootRect.bottom + margin
  }
  top = Math.max(margin, top)
  el.style.setProperty('position', 'fixed', 'important')
  el.style.setProperty('box-sizing', 'border-box', 'important')
  el.style.setProperty('width', `${width}px`, 'important')
  el.style.setProperty('left', `${left}px`, 'important')
  el.style.setProperty('right', 'auto', 'important')
  el.style.setProperty('top', `${top}px`, 'important')
  el.style.setProperty('bottom', 'auto', 'important')
  el.style.setProperty('min-width', '0', 'important')
  el.style.setProperty('max-width', 'none', 'important')
  el.style.setProperty('max-height', `${maxH}px`, 'important')
  el.style.setProperty('overflow-y', 'auto', 'important')
}

/**
 * 一级 pane（Model/Effort 单元格小菜单）紧凑浮层：右缘对齐触发按钮右缘
 * （面板右缘 x = 按钮右缘 x，钳制在视口内 8px 起，避免宽面板超出屏幕左缘时
 * 被甩到左边贴边），向上展开、空间不足向下展开；宽度跟随内容
 * （max-content，封顶 min(420, vw-16)），避免小菜单被全宽 sheet 拉远到
 * 屏幕中间。测量与定位在同一任务内同步完成，无闪烁。
 */
function positionCompactPanel(el: HTMLElement, root: HTMLElement, rootRect: DOMRect): void {
  const margin = 8
  const vw = window.innerWidth
  // 锚定触发按钮本身（root 包着按钮，取按钮 rect 更准；换 hash 后按语义类找）
  const trigger =
    root.querySelector<HTMLElement>('[class*="7KE1Ra_trigger"], [class*="_trigger"]') ?? root
  const anchorRect = trigger === root ? rootRect : trigger.getBoundingClientRect()
  el.style.setProperty('position', 'fixed', 'important')
  el.style.setProperty('box-sizing', 'border-box', 'important')
  el.style.setProperty('left', '0', 'important')
  el.style.setProperty('top', '0', 'important')
  el.style.setProperty('right', 'auto', 'important')
  el.style.setProperty('bottom', 'auto', 'important')
  el.style.setProperty('width', 'max-content', 'important')
  el.style.setProperty('min-width', '0', 'important')
  el.style.setProperty('max-width', `${Math.min(420, vw - margin * 2)}px`, 'important')
  el.style.setProperty('max-height', 'none', 'important')
  el.style.setProperty('overflow-y', 'visible', 'important')
  const w = el.offsetWidth
  const h = el.offsetHeight
  const panelRightX = Math.min(anchorRect.right, vw - margin)
  const expandUp = anchorRect.top - margin - h >= margin
  const top = Math.max(margin, expandUp ? anchorRect.top - margin - h : anchorRect.bottom + margin)
  const left = Math.max(margin, panelRightX - w)
  el.style.setProperty('left', `${left}px`, 'important')
  el.style.setProperty('top', `${top}px`, 'important')
  el.style.setProperty('width', `${w}px`, 'important')
}

/**
 * 模型名多为纯连字符词（DeepSeek-V4-Flash-Vision-Exp）；white-space:normal 下
 * 每个 "-" 都是软断点，名字一旦超列宽就在第一个连字符处断行（"换行太早"）。
 * 把 "-" 就地换成不换行连字符 U+2011：放得下就整行显示，真超宽时仍由
 * overflow-wrap:break-word 兜底任意断。只改文本节点 data、不换节点，
 * 避免与 React 文本协调冲突；React 重渲染重置文本后由 MutationObserver
 * 重新应用（幂等：换过之后不再有 "-"）。
 */
function applyNonBreakingHyphens(menu: HTMLElement): void {
  for (const el of Array.from(menu.querySelectorAll<HTMLElement>('[class*="modelName"]'))) {
    const tn = el.firstChild
    if (tn && tn.nodeType === Node.TEXT_NODE && tn.nodeValue !== null && tn.nodeValue.includes('-')) {
      tn.nodeValue = tn.nodeValue.replace(/-/g, '\u2011')
    }
  }
}

/**
 * 模型名"整行显示、不换行、不截断"：窄屏下把名字列里的所有 .modelName 设为
 * nowrap，并按"最宽名字 vs 可用列宽"统一缩小字号（下限 11px，上限 14px），
 * 让最长的名字也恰好放得下——从根上消除"换行太早"。只测一次最宽名字
 * （scrollWidth 一次布局读取），缩放结果应用到全部名字，保持同一字号。
 * 调用方按 vw + 名字集合签名缓存，避免每次 DOM 变更都强制作废布局。
 */
function fitModelNameFont(menu: HTMLElement): void {
  const names = Array.from(menu.querySelectorAll<HTMLElement>('[class*="modelName"]'))
  if (names.length === 0) return
  const col = names[0].parentElement
  if (col === null) return
  const colW = col.clientWidth - 4
  if (colW <= 0) return
  const base = 14
  let longest = names[0]
  for (const n of names) {
    if ((n.textContent?.length ?? 0) > (longest.textContent?.length ?? 0)) longest = n
  }
  const prevWs = longest.style.whiteSpace
  longest.style.whiteSpace = 'nowrap'
  longest.style.fontSize = `${base}px`
  const natural = longest.scrollWidth
  longest.style.whiteSpace = prevWs
  longest.style.fontSize = ''
  const fs = natural > colW ? Math.max(11, Math.min(base, Math.round(base * (colW / natural)))) : base
  for (const n of names) {
    n.style.setProperty('white-space', 'nowrap', 'important')
    n.style.setProperty('font-size', `${fs}px`, 'important')
  }
}

/** 宽屏（窄屏判定不成立）时复位名字列内联样式，交还上游 CSS（nowrap+ellipsis）。 */
function clearModelNameFit(menu: HTMLElement | null | undefined): void {
  if (menu === null || menu === undefined) return
  for (const n of Array.from(menu.querySelectorAll<HTMLElement>('[class*="modelName"]'))) {
    n.style.removeProperty('white-space')
    n.style.removeProperty('font-size')
  }
}

/** 清除 positionFixedSheet 写入的内联样式，交还上游/移动端 CSS 兜底。 */
function clearFixedSheet(el: HTMLElement | null | undefined): void {
  if (el === null || el === undefined) return
  for (const key of SHEET_PROPS) el.style.removeProperty(key)
}

/**
 * 模型选择弹窗（dsh-client-ui-model-selection）是两级 pane 的同一个 `_7KE1Ra_menu`
 * 元素：一级 Model/Effort 单元格列表（cellLabel），点击后切到模型列表（modelName）
 * 或档位列表。上游默认 `position:absolute;right:0` 贴触发按钮右缘，触发按钮在
 * 可横向滚动的 stats 行内时菜单会整体出屏。两级 pane 都必须接管（不能只按
 * modelName 匹配，否则一级 pane 漏掉）。窄屏下：一级小菜单走紧凑浮层
 * （右缘贴按钮、向上展开，避免全宽 sheet 把小菜单拉到屏幕中间离按钮太远）；
 * 二级列表走视口级居中 fixed sheet（左右各 8px、高度 45% 视口封顶、
 * 内容滚动、上方空间不足时向下展开）。
 */
function installModelMenuPosition(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(NARROW_QUERY)
    // 多 tab 场景可能并存多个模型选择器（各自一个 _menu）；只处理可见的，
    // 避免 document.querySelector 命中隐藏 tab 的菜单而漏掉用户正在看的那个。
    const findMenus = (): HTMLElement[] => {
      const byHash = Array.from(document.querySelectorAll<HTMLElement>('[class*="7KE1Ra_menu"]'))
      if (byHash.length > 0) return byHash
      // 上游升级换 hash 后回退：语义类匹配（cellLabel 命中一级 pane，modelName 命中二级）
      return Array.from(document.querySelectorAll<HTMLElement>('[class*="_menu"]')).filter((el) =>
        el.querySelector('[class*="cellLabel"], [class*="modelName"]') !== null,
      )
    }
    const findTrigger = (menu: HTMLElement): HTMLElement | null => {
      if (menu.id) {
        const controlled = Array.from(document.querySelectorAll<HTMLElement>('[aria-controls]')).find(
          (el) => el.getAttribute('aria-controls') === menu.id,
        )
        if (controlled) return controlled
      }
      return document.querySelector<HTMLElement>('[class*="7KE1Ra_trigger"][aria-expanded="true"]')
    }
    let fittedVw = 0
    let fittedSig = -1
    let fittedMenus: HTMLElement[] = []
    const sync = (): void => {
      const menus = findMenus()
      if (!narrow.matches) {
        // Desktop: upstream place() owns menu positioning via inline left/top.
        // Only clear DSHB's !important overrides when transitioning FROM narrow
        // mode (fittedMenus non-empty). Clearing on every MutationObserver tick
        // would strip upstream's menuPos and drop the menu off-screen.
        if (fittedMenus.length > 0) {
          for (const menu of fittedMenus) {
            clearFixedSheet(menu)
            clearModelNameFit(menu)
          }
          fittedVw = 0
          fittedSig = -1
          fittedMenus = []
          window.dispatchEvent(new Event('resize'))
        }
        return
      }
      let vw = 0
      let sig = 0
      const modelMenus: HTMLElement[] = []
      for (const menu of menus) {
        // 0.1.5 renders the menu through createPortal(..., document.body), so
        // parentElement is body rather than the trigger root. Match aria-controls
        // to the portal menu id to find the exact trigger across multiple tabs.
        const trigger = findTrigger(menu)
        if (trigger === null) continue
        const rect = menu.getBoundingClientRect()
        // 跳过隐藏 tab / 未打开的菜单（0 尺寸或祖先 display:none）
        if (rect.width === 0 && rect.height === 0) continue
        const triggerRect = trigger.getBoundingClientRect()
        if (menu.querySelector('[class*="modelName"]')) {
          positionFixedSheet(menu, triggerRect, Number.POSITIVE_INFINITY, 0.45)
          applyNonBreakingHyphens(menu)
          modelMenus.push(menu)
          vw = window.innerWidth
          for (const n of menu.querySelectorAll<HTMLElement>('[class*="modelName"]')) {
            sig += n.textContent?.length ?? 0
          }
        } else {
          positionCompactPanel(menu, trigger, triggerRect)
        }
      }
      // 菜单关闭再打开时 React 会重建菜单元素（新元素没有任何内联样式），
      // 所以缓存必须含元素身份：vw / 名字集合 / 菜单实例任一变化都要重测，
      // 否则重开的菜单会漏掉 nowrap+缩字而再次换行。
      const needFit = modelMenus.some((m) => !fittedMenus.includes(m))
      if (vw > 0 && (needFit || vw !== fittedVw || sig !== fittedSig)) {
        for (const menu of modelMenus) fitModelNameFont(menu)
        fittedVw = vw
        fittedSig = sig
        fittedMenus = modelMenus
      }
    }
    sync()
    const mo = new MutationObserver(() => requestAnimationFrame(sync))
    mo.observe(document.documentElement, { childList: true, subtree: true })
    narrow.addEventListener('change', sync)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      mo.disconnect()
      narrow.removeEventListener('change', sync)
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, 'dshb-mobile: model menu position')
}

/**
 * 上下文用量弹窗（ContextMeter .JObwrW_panel，dsh-client-ui-conversation）上游是
 * `position:absolute; bottom:calc(100%+8px); right:0` 挂 .JObwrW_root 内。窄屏下
 * 改为 fixed 视口浮层，右缘锚定触发按钮右缘、向上展开（用户已验证该形态正常，勿改）。
 */
function installContextPanelPosition(ctx: ClientContext): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(NARROW_QUERY)
    const sync = (): void => {
      if (!narrow.matches) return
      const panels = document.querySelectorAll<HTMLElement>('[class*="JObwrW_panel"]')
      for (const panel of Array.from(panels)) {
        const root = panel.parentElement
        if (root === null || !root.className.includes('JObwrW_root')) continue
        const rootRect = root.getBoundingClientRect()
        if (rootRect.width === 0 && rootRect.height === 0) continue
        const gap = 8
        panel.style.setProperty('position', 'fixed', 'important')
        panel.style.setProperty('top', 'auto', 'important')
        panel.style.setProperty('bottom', `${window.innerHeight - rootRect.top + gap}px`, 'important')
        panel.style.setProperty('left', 'auto', 'important')
        panel.style.setProperty('right', `${Math.max(gap, window.innerWidth - rootRect.right)}px`, 'important')
        panel.style.setProperty('max-height', `${Math.max(160, rootRect.top - gap * 2)}px`, 'important')
        panel.style.setProperty('overflow-y', 'auto', 'important')
      }
    }
    sync()
    const mo = new MutationObserver(() => requestAnimationFrame(sync))
    mo.observe(document.documentElement, { childList: true, subtree: true })
    narrow.addEventListener('change', sync)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      mo.disconnect()
      narrow.removeEventListener('change', sync)
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, 'dshb-mobile: context panel position')
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

const PANEL_ICON_SVG =
  '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5"/>' +
  '<path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.5"/>' +
  '</svg>'

/**
 * 首页 / hero（无活跃会话）没有 session header，header 上的切换按钮不渲染；
 * 这里在 frame 上注入一个浮动切换按钮（FAB），仅 hero 且抽屉收起时显示。
 */
function installFab(ctx: ClientContext, toggleSidebar: () => void): void {
  ctx.effect(() => {
    const narrow = window.matchMedia(MOBILE_QUERY)
    const FAB_ATTR = 'fab'
    const heroPhase = (): boolean => document.querySelector('[data-phase="active"]') === null
    const drawerOpen = (): boolean => {
      const frame = getFrame()
      return frame !== null && !frame.hasAttribute(COLLAPSED_ATTR)
    }
    let fab: HTMLButtonElement | null = null
    const sync = (): void => {
      if (!narrow.matches || !heroPhase() || drawerOpen()) {
        if (fab !== null) {
          fab.remove()
          fab = null
        }
        return
      }
      const frame = getFrame()
      if (frame === null) return
      if (fab !== null && fab.parentElement === frame) return
      fab?.remove()
      fab = document.createElement('button')
      fab.type = 'button'
      fab.setAttribute(FRAME_ATTR, FAB_ATTR)
      fab.setAttribute('aria-label', '打开目录')
      fab.setAttribute('title', '打开目录')
      fab.innerHTML = PANEL_ICON_SVG
      fab.addEventListener('click', toggleSidebar)
      frame.appendChild(fab)
    }
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-phase', 'data-sidebar-collapsed', 'class'],
    })
    narrow.addEventListener('change', sync)
    return () => {
      mo.disconnect()
      narrow.removeEventListener('change', sync)
      fab?.remove()
    }
  }, 'dshb-mobile: hero fab')
}

/** 安装移动端适配：样式 + viewport + 抽屉标记 + 抽屉交互 + 切换按钮。 */
export function installMobile(ctx: ClientContext): void {
  installStyles(ctx)
  installViewport(ctx)
  installFrameMarker(ctx)
  installStatsLine(ctx)
  installModelMenuPosition(ctx)
  installContextPanelPosition(ctx)
  const layout = (ctx as unknown as { layout?: LayoutLike }).layout
  const slots = (ctx as unknown as { slots?: SlotsLike }).slots
  if (layout && typeof layout.toggleSidebar === 'function') {
    const toggleSidebar = (): void => layout.toggleSidebar()
    installDrawerInteractions(ctx, toggleSidebar)
    installFab(ctx, toggleSidebar)
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
