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
  return html.replace('</head>', `${loopbackCompatScript()}</head>`)
}
