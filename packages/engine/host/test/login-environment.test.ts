import { expect, test } from 'bun:test'
import { readLoginEnvironment } from '../src/login-environment.ts'

test('采到登录 shell 的环境：source 标 login-shell，PATH 与 HOME 在', () => {
  const inherited = { SHELL: '/bin/sh', PATH: '/usr/bin:/bin', HOME: '/tmp/magic-home' }
  const read = readLoginEnvironment(inherited)
  expect(read.shell).toBe('/bin/sh')
  expect(read.source).toBe('login-shell')
  expect(read.env['PATH']).toBeString()
  expect(read.env['HOME']).toBeString()
})

test('采集失败回落传入环境，并标出它从哪来', () => {
  const inherited = { SHELL: '/no-such-shell-magic', PATH: '/usr/bin:/bin', HOME: '/tmp/magic-home' }
  const read = readLoginEnvironment(inherited)
  expect(read.source).toBe('inherited')
  expect(read.env).toBe(inherited)
})

test('显式关闭采集（测试/调试）——不读真实启动文件', () => {
  const inherited = { SHELL: '/bin/sh', PATH: '/usr/bin:/bin', HOME: '/tmp/magic-home', MAGIC_SHELL_ENV: 'inherited' }
  const read = readLoginEnvironment(inherited)
  expect(read.source).toBe('inherited')
  expect(read.env).toBe(inherited)
})

test('没有 $SHELL 时按系统账户的 shell 兜底，不拿空串去 spawn', () => {
  const read = readLoginEnvironment({ PATH: '/usr/bin:/bin', HOME: '/tmp/magic-home', MAGIC_SHELL_ENV: 'inherited' })
  expect(read.shell.startsWith('/')).toBe(true)
})
