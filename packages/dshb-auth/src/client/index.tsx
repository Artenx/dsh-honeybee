import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CSSProperties, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'

export const inject = ['connection']

const SECTION_ID = 'auth'
const MESSAGE_MS = 5000

function useUsername(): [string | undefined, (username: string) => void] {
  const [username, setUsername] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/auth/status')
        if (!res.ok) return
        const data = (await res.json()) as { username?: string }
        if (!cancelled && typeof data.username === 'string') setUsername(data.username)
      } catch {
        // best-effort
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return [username, setUsername]
}

type Notice = { kind: 'ok' | 'error'; text: string; owner: 'username' | 'password' | 'account' }

export function AuthSection(_props: PropsRuntime<'settings.section'>): ReactElement {
  const [username, setUsername] = useUsername()
  const [newUsername, setNewUsername] = useState('')
  const [usernamePassword, setUsernamePassword] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)

  const flash = useCallback((n: Notice | undefined) => {
    setNotice(n)
    if (n !== undefined) setTimeout(() => setNotice(undefined), MESSAGE_MS)
  }, [])

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      window.location.href = '/login'
    } catch {
      setBusy(false)
      setConfirmingSignOut(false)
      flash({ kind: 'error', text: '退出失败，请重试', owner: 'account' })
    }
  }, [flash])

  const changePassword = useCallback(async () => {
    if (newPassword !== confirm) {
      flash({ kind: 'error', text: '两次输入的新密码不一致', owner: 'password' })
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: oldPassword, password: newPassword }),
      })
      const data = (await res.json()) as { error?: string }
      if (res.ok) {
        setOldPassword('')
        setNewPassword('')
        setConfirm('')
        flash({ kind: 'ok', text: '密码已修改', owner: 'password' })
      } else {
        flash({ kind: 'error', text: data.error ?? '修改失败，请重试', owner: 'password' })
      }
    } catch {
      flash({ kind: 'error', text: '修改失败，请重试', owner: 'password' })
    } finally {
      setBusy(false)
    }
  }, [oldPassword, newPassword, confirm, flash])

  const changeUsername = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/auth/change-username', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: newUsername, currentPassword: usernamePassword }),
      })
      const data = (await res.json()) as { error?: string }
      if (res.ok) {
        setNewUsername('')
        setUsernamePassword('')
        if (newUsername) setUsername(newUsername)
        flash({ kind: 'ok', text: '用户名已更新', owner: 'username' })
      } else {
        flash({ kind: 'error', text: data.error ?? '修改失败，请重试', owner: 'username' })
      }
    } catch {
      flash({ kind: 'error', text: '修改失败，请重试', owner: 'username' })
    } finally {
      setBusy(false)
    }
  }, [newUsername, usernamePassword, flash, setUsername])

  const inputStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    border: '1px solid var(--dsw-border, #3a4050)',
    borderRadius: 6,
    fontSize: 14,
    fontFamily: 'inherit',
    background: 'var(--dsw-input-bg, transparent)',
    color: 'inherit',
  }
  const buttonStyle: CSSProperties = {
    padding: '8px 16px',
    borderRadius: 6,
    fontSize: 14,
    fontFamily: 'inherit',
    cursor: 'pointer',
    border: '1px solid transparent',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 420 }}>
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>账号</h2>
        <p style={{ fontSize: 13, opacity: 0.7, margin: '0 0 12px' }}>
          {username !== undefined ? `当前登录：${username}` : '当前登录：管理员'}
        </p>
        <button
          type="button"
          onClick={() => setConfirmingSignOut(true)}
          disabled={busy}
          style={{ ...buttonStyle, background: 'none', borderColor: 'var(--dsw-danger, #d4380d)', color: 'var(--dsw-danger, #d4380d)' }}
        >
          退出登录
        </button>
        {confirmingSignOut && (
          <div role="alertdialog" aria-label="确认退出登录" style={{ marginTop: 10, padding: '12px 14px', border: '1px solid var(--dsw-border, #3a4050)', borderRadius: 8, maxWidth: 320 }}>
            <div style={{ fontSize: 13, marginBottom: 10 }}>退出登录将回到登录页</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setConfirmingSignOut(false)} disabled={busy} style={{ ...buttonStyle, padding: '4px 12px', background: 'none', borderColor: 'var(--dsw-border, #3a4050)' }}>
                取消
              </button>
              <button type="button" onClick={() => void signOut()} disabled={busy} style={{ ...buttonStyle, padding: '4px 12px', background: 'var(--dsw-danger, #d4380d)', color: '#fff' }}>
                确认退出
              </button>
            </div>
          </div>
        )}
        {notice?.owner === 'account' && (
          <p style={{ fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-ok, #237804)' : 'var(--dsw-danger, #d4380d)', margin: '8px 0 0' }}>{notice.text}</p>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>修改用户名</h2>
        <form onSubmit={(e) => { e.preventDefault(); void changeUsername() }} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            新用户名
            <input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} autoComplete="username" style={inputStyle} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            当前密码
            <input type="password" value={usernamePassword} onChange={(e) => setUsernamePassword(e.target.value)} autoComplete="current-password" style={inputStyle} />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" disabled={busy} style={{ ...buttonStyle, background: 'var(--dsw-accent, #3b82f6)', color: '#fff' }}>修改用户名</button>
            {notice?.owner === 'username' && <span style={{ fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-ok, #237804)' : 'var(--dsw-danger, #d4380d)' }}>{notice.text}</span>}
          </div>
        </form>
      </section>

      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>修改密码</h2>
        <form onSubmit={(e) => { e.preventDefault(); void changePassword() }} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            当前密码
            <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoComplete="current-password" style={inputStyle} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            新密码
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" style={inputStyle} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            确认新密码
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" style={inputStyle} />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" disabled={busy} style={{ ...buttonStyle, background: 'var(--dsw-accent, #3b82f6)', color: '#fff' }}>修改密码</button>
            {notice?.owner === 'password' && <span style={{ fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-ok, #237804)' : 'var(--dsw-danger, #d4380d)' }}>{notice.text}</span>}
          </div>
        </form>
      </section>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as { isLoopback?: boolean } | undefined
  if (connection !== undefined) {
    Object.defineProperty(connection, 'isLoopback', { configurable: true, get: () => true })
  }
  ctx.plugin({
    inject: ['slots', 'settingsScope'],
    apply: (sub: ClientContext): void => {
      sub.slots.inject('settings.section', () =>
        sub.slots.register({ name: 'settings.section', id: SECTION_ID, order: 100, label: () => '认证' }, AuthSection),
      )
    },
  })
}
