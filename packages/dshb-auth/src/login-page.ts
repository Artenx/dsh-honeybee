export function loginPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>DSHB 登录</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0f1115; color: #e8eaf0; font-family: system-ui, -apple-system, "PingFang SC", sans-serif; }
.card { width: min(92vw, 360px); padding: 32px 28px; background: #171a21; border: 1px solid #262b36; border-radius: 12px; }
h1 { font-size: 20px; margin: 0 0 6px; }
p.sub { margin: 0 0 20px; font-size: 13px; color: #8b93a5; }
label { display: block; font-size: 13px; color: #aab1c0; margin: 14px 0 6px; }
input { width: 100%; box-sizing: border-box; padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid #2c3242; background: #0f1115; color: #e8eaf0; }
input:focus { outline: 2px solid #3b82f6; border-color: transparent; }
button { margin-top: 22px; width: 100%; padding: 12px; font-size: 15px; border: 0; border-radius: 8px; background: #3b82f6; color: #fff; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
.err { min-height: 18px; margin-top: 12px; font-size: 13px; color: #f87171; }
</style>
</head>
<body>
<div class="card">
<h1 id="title">DSHB 登录</h1>
<p class="sub" id="subtitle">DeepSeek Harness 管理端</p>
<form id="form">
<label for="username">用户名</label>
<input id="username" name="username" autocomplete="username" required>
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button id="submit" type="submit">登录</button>
<div class="err" id="error"></div>
</form>
</div>
<script>
(async () => {
  const res = await fetch('/api/auth/status')
  const status = await res.json()
  const form = document.getElementById('form')
  const title = document.getElementById('title')
  const subtitle = document.getElementById('subtitle')
  const submit = document.getElementById('submit')
  const error = document.getElementById('error')
  const password = document.getElementById('password')
  let mode = 'login'
  if (!status.initialized) {
    mode = 'register'
    title.textContent = '设置管理员账号'
    subtitle.textContent = '首次使用，请创建管理员账号（密码至少 8 位）'
    submit.textContent = '创建并登录'
    password.autocomplete = 'new-password'
  }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    submit.disabled = true
    error.textContent = ''
    try {
      const resp = await fetch('/api/auth/' + mode, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value,
          password: password.value,
        }),
      })
      const data = await resp.json()
      if (resp.ok && data.ok) {
        location.href = '/'
        return
      }
      error.textContent = data.error || ('请求失败（' + resp.status + '）')
    } catch {
      error.textContent = '网络错误，请重试'
    } finally {
      submit.disabled = false
    }
  })
})()
</script>
</body>
</html>`
}
