/**
 * `exec` 的超时语义（2026-11 定）——**默认两分钟；到点没跑完就转后台**，不是杀掉。
 *
 * 判据三件：
 * ① 不填 `timeoutMs` ⇒ 沙箱收到 120_000（与 Claude Code 的 Bash 同一个数）；
 * ② 显式 `null` ⇒ 仍然「一直等」（那一档没被取消，只是不再是缺省）；
 * ③ 沙箱报「转后台」⇒ 回执说清「还在跑 + 编号 + 输出文件」，且 `ok:false`（这一趟没有一次成功的执行）。
 */
import { describe, expect, test } from 'bun:test'
import type { ExecResult } from '@magic/contracts'
import { makeToolDeps } from './helpers.ts'

const adopted = (): ExecResult => ({
  ok: false,
  reason: 'timeout',
  timeoutMs: 120_000,
  message: '命令超过 120000ms 未结束，已转后台（bg-7）',
  stdout: '编译中…\n',
  stderr: '',
  background: { id: 'bg-7', outputPath: '/run/bg-7.log' },
})

describe('exec 超时：缺省两分钟，到点转后台', () => {
  test('不填 timeoutMs ⇒ 沙箱收到 120000；显式 null 仍是不设上界', async () => {
    const deps = makeToolDeps()

    await deps.runtime.invoke({ id: 'c1', name: 'exec', args: { command: 'ls' } }, {})
    await deps.runtime.invoke({ id: 'c2', name: 'exec', args: { command: 'ls', timeoutMs: null } }, {})
    await deps.runtime.invoke({ id: 'c3', name: 'exec', args: { command: 'ls', timeoutMs: 2500 } }, {})

    expect(deps.sandbox.execs.map(one => one.opts.timeoutMs)).toEqual([120_000, null, 2500])
  })

  test('接了后台能力 ⇒ 让沙箱「到点交出去」；没接 ⇒ 照旧按进程组收掉', async () => {
    const withBackground = makeToolDeps({ background: {
      start: async () => ({ ok: false, reason: '本用例不起新进程' }),
      running: () => [],
      stop: async () => ({ ok: true, note: '' }),
      adopt: async () => ({ ok: false, reason: '本用例不接管' }),
    } })
    await withBackground.runtime.invoke({ id: 'c1', name: 'exec', args: { command: 'make' } }, {})
    expect(withBackground.sandbox.execs[0]?.opts.onTimeout).toBe('background')
    expect(typeof withBackground.sandbox.execs[0]?.opts.adopt).toBe('function')

    const without = makeToolDeps()
    await without.runtime.invoke({ id: 'c2', name: 'exec', args: { command: 'make' } }, {})
    expect(without.sandbox.execs[0]?.opts.onTimeout).toBe('kill')
    expect(without.sandbox.execs[0]?.opts.adopt).toBeUndefined()
  })

  test('宿主只实现 start、没实现 adopt ⇒ 照旧按进程组收掉（不假定它会接管）', async () => {
    const deps = makeToolDeps({ background: {
      start: async () => ({ ok: false, reason: '本用例不起新进程' }),
      running: () => [],
      stop: async () => ({ ok: true, note: '' }),
      // 契约上 adopt 是可选的：只实现 start 的宿主第一趟超时不该撞成 TypeError
    } })
    await deps.runtime.invoke({ id: 'c1', name: 'exec', args: { command: 'make' } }, {})
    expect(deps.sandbox.execs[0]?.opts.onTimeout).toBe('kill')
    expect(deps.sandbox.execs[0]?.opts.adopt).toBeUndefined()
  })

  test('沙箱报「已转后台」⇒ 回执说清还在跑、编号与输出文件；ok:false', async () => {
    const deps = makeToolDeps({ exec: { make: adopted() } })

    const outcome = await deps.runtime.invoke({ id: 'c1', name: 'exec', args: { command: 'make' } }, {})

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('命令超过 120000ms 还没结束，已转后台继续跑：编号 bg-7')
    expect(outcome.output).toContain('/run/bg-7.log')
    // 已读到的正文照旧带回
    expect(outcome.output).toContain('编译中…')
    // 事实行说「未结束」而不是「退出 N」
    expect(outcome.output).toContain('[未结束，已转后台 bg-7 · /work/proj]')
  })

  test('转后台那一句不许与「失败」混为一谈：不说「被杀」「被掐断」', async () => {
    const deps = makeToolDeps({ exec: { make: adopted() } })

    const outcome = await deps.runtime.invoke({ id: 'c1', name: 'exec', args: { command: 'make' } }, {})

    expect(outcome.output).not.toContain('被掐断')
    expect(outcome.output).not.toContain('已拒绝')
  })
})
