const MOBILE_CSS = `
<style id="dshb-mobile-fix">
@media (max-width:1023px),(display-mode:standalone){
html{-webkit-text-size-adjust:100%!important;text-size-adjust:100%!important}
[class*="_command_10eou_"]{min-width:max-content!important;max-width:none!important;overflow:visible!important;white-space:pre!important;text-overflow:clip!important;max-height:999999px!important}
[class*="_prompt_10eou_"],[class*="_promptLine_10eou_"]{min-width:max-content!important;max-height:999999px!important}
[class*="_header_10eou_"]{min-width:0!important;max-width:100%!important;overflow-x:auto!important;overscroll-behavior-x:contain;touch-action:pan-x pan-y!important}
[class*="_output_10eou_"]{overflow-x:auto!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y!important}
[class*="_line_10eou_"]{min-width:max-content!important;overflow-x:visible!important;max-height:999999px!important}
[class*="_copyButton_10eou_"]{position:sticky!important;right:0}
[class*="7KE1Ra_modelName"],[class*="7KE1Ra_description"],[class*="modelName"]{white-space:normal!important;overflow-wrap:anywhere;text-overflow:clip!important;overflow:visible!important}
[class*="7KE1Ra_menu"],[class*="_menu"]:has([class*="modelName"]){min-width:calc(100vw - 48px)!important;max-width:calc(100vw - 48px)!important}
[class*="_copyButton_"]{touch-action:manipulation!important}
[class*="_copyAnchor_"],[class*="_body_1ye18_"],[class*="_root_4qrvp_"]{touch-action:pan-x pan-y!important}
[class*="_root_4qrvp_1"]{width:100%!important;min-width:0!important;overflow-x:auto!important}
[class*="_container_4qrvp_"]{width:auto!important;min-width:100%!important;max-width:none!important}
[class*="_expandedTopLevel_4qrvp_"]{width:auto!important;min-width:100%!important;max-width:none!important}
[class*="_body_biesw_"],[class*="_body_srovd_"],[class*="_body_s66q0_"]{overflow-x:auto!important;-webkit-overflow-scrolling:touch}
[class*="_line_biesw_"],[class*="_line_srovd_"],[class*="_line_s66q0_"]{min-width:max-content!important}
[class*="_block_10eou_"]{padding-left:0!important;overflow-x:auto!important}
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
