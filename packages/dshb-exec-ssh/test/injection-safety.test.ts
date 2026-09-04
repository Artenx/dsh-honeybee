import { describe, expect, it } from 'vitest'
import { encodeRunnerPayload, REMOTE_RUNNER_COMMAND, REMOTE_RUNNER_SCRIPT, isRunnerSafe } from '../src/runner.js'

describe('行协议注入安全（设计正确性属性 8，需求 8.1）', () => {
  it('命令串是静态字面量（固定内容，不含用户数据）', () => {
    expect(typeof REMOTE_RUNNER_COMMAND).toBe('string')
    expect(REMOTE_RUNNER_COMMAND).not.toContain('rm -rf')
    expect(REMOTE_RUNNER_COMMAND).not.toContain('whoami')
    expect(REMOTE_RUNNER_COMMAND).not.toContain('`')
  })
  it('命令串含 base64 依赖', () => {
    expect(REMOTE_RUNNER_SCRIPT).toContain('base64')
  })
  it('命令串含 env -i 净化', () => {
    expect(REMOTE_RUNNER_SCRIPT).toContain('env -i')
  })
  it('argv 含 shell 元字符不进命令串（进 stdin 数据通道）', () => {
    const evil = ['bash', '-c', '$(rm -rf /); echo hacked; `whoami`']
    const buf = encodeRunnerPayload({ argv: evil, cwd: '/tmp', env: {} })
    expect(REMOTE_RUNNER_COMMAND).not.toContain('rm -rf')
    expect(REMOTE_RUNNER_COMMAND).not.toContain('whoami')
    const decoded = buf.toString('base64')
    expect(buf.length).toBeGreaterThan(0)
  })
  it('isRunnerSafe 区分静态与篡改命令', () => {
    expect(isRunnerSafe(REMOTE_RUNNER_COMMAND)).toBe(true)
    expect(isRunnerSafe('sh -c "evil"')).toBe(false)
    expect(isRunnerSafe('rm -rf /')).toBe(false)
  })
  it('env 含特殊值不进命令串（经 base64 编码进 stdin）', () => {
    const buf = encodeRunnerPayload({ argv: ['echo'], cwd: '/', env: { EVIL: '$(whoami); rm -rf /' } })
    expect(REMOTE_RUNNER_COMMAND).not.toContain('whoami')
    expect(REMOTE_RUNNER_COMMAND).not.toContain('rm -rf')
    expect(buf.length).toBeGreaterThan(0)
  })
  it('payload 结构含结束标记', () => {
    const buf = encodeRunnerPayload({ argv: ['echo'], cwd: '/', env: {} })
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    expect(lines[lines.length - 1]).toBe('.')
  })
})
