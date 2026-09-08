const MOBILE_CSS = `
<style id="dshb-mobile-fix">
@media (max-width:768px),(display-mode:standalone),(max-device-width:860px){
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
._command_10eou_122{min-width:max-content;max-width:none;overflow:visible;white-space:pre;text-overflow:unset;max-height:999999px}
._prompt_10eou_76,._promptLine_10eou_84{min-width:max-content;max-height:999999px}
._output_10eou_162{overflow-x:auto;overflow-y:auto;-webkit-overflow-scrolling:touch}
._root_4qrvp_1{width:100%;min-width:0;overflow-x:auto}
._container_4qrvp_30{width:auto;min-width:100%;max-width:none}
._expandedTopLevel_4qrvp_39{width:auto;min-width:100%;max-width:none}
._body_biesw_72{overflow-x:auto;-webkit-overflow-scrolling:touch}
._body_srovd_36{overflow-x:auto;-webkit-overflow-scrolling:touch}
._body_s66q0_51{overflow-x:auto;-webkit-overflow-scrolling:touch}
._line_10eou_186{min-width:max-content;overflow-x:visible;max-height:999999px}
._line_biesw_81{min-width:max-content}
._line_srovd_44{min-width:max-content}
._line_s66q0_60{min-width:max-content}
._block_10eou_7{padding-left:0;overflow-x:auto}
._header_10eou_38{margin-left:0;overflow-x:auto}
}
</style>`

export function loopbackCompatScript(): string {
  return `<script>
;(function () {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function' && typeof crypto.getRandomValues === 'function') {
    crypto.randomUUID = function () {
      var b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      var h = ''
      for (var i = 0; i < 16; i++) {
        if (i === 4 || i === 6 || i === 8 || i === 10) h += '-'
        var hex = b[i].toString(16)
        if (hex.length < 2) hex = '0' + hex
        h += hex
      }
      return h
    }
  }
  function installIsLoopbackOverride() {
    var loader = window.__ModuleLoader__
    if (!loader || loader.__dshbIsLoopbackHooked) return false
    if (loader.mode !== 'live') return false
    loader.__dshbIsLoopbackHooked = true
    var origLoad = loader.load.bind(loader)
    loader.load = function (handoff) {
      var factory = handoff && handoff.factory
      if (typeof factory === 'function') {
        handoff.factory = function (require) {
          var exports = factory(require)
          var apply = exports && exports.apply
          if (typeof apply === 'function') {
            exports.apply = function (ctx) {
              var result = apply(ctx)
              try {
                var connection = ctx && ctx.get && ctx.get('connection')
                if (connection) {
                  Object.defineProperty(connection, 'isLoopback', { configurable: true, get: function () { return true } })
                }
              } catch (e) {}
              return result
            }
          }
          return exports
        }
      }
      return origLoad(handoff)
    }
    return true
  }
  function tryInstall() { if (!installIsLoopbackOverride()) setTimeout(tryInstall, 0) }
  tryInstall()
})()
;(async function () {
  try {
    var res = await fetch('/api/auth/status')
    var data = await res.json()
    if (window.location.pathname !== '/login' && !data.authenticated) {
      window.location.replace('/login')
      return
    }
  } catch (e) {}
})()
</script>`
}

export function installLoopbackCompat(html: string): string {
  return html.replace('</head>', `${MOBILE_CSS}${loopbackCompatScript()}</head>`)
}
