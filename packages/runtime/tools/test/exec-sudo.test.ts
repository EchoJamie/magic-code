/**
 * `exec` 的 sudo 专用认证（U129）——**认证先于执行**，失败时原命令一个字节都不跑。
 */

import { describe, expect, test } from 'bun:test'
import type { SudoAuth, SudoAuthResult } from '@magic/contracts'
import { execCall, makeToolDeps } from './helpers.ts'

const plan = { command: 'sudo ls /root', run: 'sudo -n ls /root', program: 'ls' }

function auth(result: SudoAuthResult): { readonly port: SudoAuth; readonly calls: { command: string; cwd?: string }[] } {
  const calls: { command: string; cwd?: string }[] = []
  return {
    calls,
    port: {
      async authenticate(request) {
        calls.push({ command: request.command, ...(request.cwd === undefined ? {} : { cwd: request.cwd }) })
        return result
      },
    },
  }
}

describe('exec 的 sudo 认证', () => {
  test('认证通过 → 执行 `sudo -n …`（不是模型原句）', async () => {
    const fake = auth({ ok: true })
    const deps = makeToolDeps({ sudo: plan, sudoAuth: fake.port, exec: { 'sudo -n ls /root': { ok: true, exit: 0, stdout: 'bin\n', stderr: '' } } })

    const outcome = await deps.runtime.invoke(execCall('sudo ls /root'), {})

    expect(fake.calls).toEqual([{ command: 'sudo ls /root', cwd: '/work/proj' }])
    expect(deps.sandbox.execs.map((one) => one.cmd)).toEqual(['sudo -n ls /root'])
    expect(outcome.ok).toBe(true)
    expect(outcome.output).toBe('[退出 0 · /work/proj]\nbin\n')
  })

  test('重定向保留到 sudo -n 执行行（shell 以当前用户执行，不改 sudo 目标）', async () => {
    const fake = auth({ ok: true })
    const redirected = { command: 'sudo ls > out.txt', run: 'sudo -n ls > out.txt', program: 'ls' }
    const deps = makeToolDeps({ sudo: redirected, sudoAuth: fake.port, exec: { 'sudo -n ls > out.txt': { ok: true, exit: 0, stdout: '', stderr: '' } } })

    const outcome = await deps.runtime.invoke(execCall('sudo ls > out.txt'), {})

    expect(fake.calls).toEqual([{ command: 'sudo ls > out.txt', cwd: '/work/proj' }])
    expect(deps.sandbox.execs.map((one) => one.cmd)).toEqual(['sudo -n ls > out.txt'])
    expect(outcome.ok).toBe(true)
  })

  test('认证失败 → 不启动原命令，回执如实说「未执行」', async () => {
    const fake = auth({ ok: false, reason: 'failed', detail: 'Sorry, try again.' })
    const deps = makeToolDeps({ sudo: plan, sudoAuth: fake.port })

    const outcome = await deps.runtime.invoke(execCall('sudo ls /root'), {})

    expect(deps.sandbox.execs).toEqual([])
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('sudo 认证没通过')
    expect(outcome.output).toContain('命令未执行')
    expect(outcome.output).not.toContain('correct-password')
  })

  test('用户取消 → 命令不执行', async () => {
    const fake = auth({ ok: false, reason: 'cancelled' })
    const deps = makeToolDeps({ sudo: plan, sudoAuth: fake.port })

    const outcome = await deps.runtime.invoke(execCall('sudo ls /root'), {})

    expect(deps.sandbox.execs).toEqual([])
    expect(outcome.output).toContain('已取消 sudo 认证')
    expect(outcome.output).toContain('命令未执行')
  })

  test('没有认证通道 → 不执行，并说清楚是通道没接', async () => {
    const deps = makeToolDeps({ sudo: plan })

    const outcome = await deps.runtime.invoke(execCall('sudo ls /root'), {})

    expect(deps.sandbox.execs).toEqual([])
    expect(outcome.output).toContain('没有接入 sudo 密码组件')
  })
})
