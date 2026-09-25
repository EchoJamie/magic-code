/**
 * U69 · 超时 —— 「命令跑过了、被掐断」，与取消**同一口径**。
 *
 * 修的是 [[缺陷/D39 exec 超时说成「未能执行」且丢掉已有输出]]。原先超时那一支走的是
 * `!result.ok` 的兜底，于是三样都错：**说成「未能执行」**（＝伪造零副作用，设计明文禁）、
 * **已有输出全丢**（`exec.ts` 收尸时两道流已经排空，只是值没带出来）、
 * **漏一个裸英文词**（那句里的 `（timeout）`）。
 *
 * 三条判据（D39 的待办 · 本文件逐条咬住）：
 * ① 超时那条**不带**「未能执行」字样；
 * ② **已有输出在**结果里（两道流都在）；
 * ③ 与**取消**那一支的抬头**互斥、各说全**。
 *
 * 注意口径的分界（别把两支修成一支）：**取消**说的是「谁叫停的」（调用方自持的 `signal`），
 * **超时**说的是「哪条上界到点了」（沙箱自持计时器报回来的 `timeoutMs`）——
 * 两支都保留「跑过了、被掐断、输出照在」，不保留的是各自那一句事实的**出处**。
 *
 * 沙箱那一侧的形态（真收命、真排空、真带出来）归 `packages/execution/test/exec.test.ts`；
 * 本文件用的是**替身给的形态**——它验的是工具域有没有把那份形态**转述对**。
 */

import { describe, expect, test } from 'bun:test'
import type { ExecResult } from '@magic/contracts'
import { OUTPUT_CANCELED_RUNNING, execTimedOutOutput } from '../src/messages.ts'
import { execCall, execCallWith, makeToolDeps } from './helpers.ts'

/** 契约里**超时那一支**的形态——本文件通篇只说这一支。 */
type TimeoutResult = Extract<ExecResult, { ok: false; reason: 'timeout' }>

/** 一次超时——带着真跑出来的那两行（夹具给的形态照契约来）。 */
function timedOut(over: Partial<TimeoutResult> = {}): TimeoutResult {
  return {
    ok: false,
    reason: 'timeout',
    message: '命令超时（2000ms）未完成——已终止',
    timeoutMs: 2000,
    stdout: '第一行\n第二行\n',
    stderr: '一个警告\n',
    ...over,
  }
}

describe('U69 · 超时与取消同一口径', () => {
  test('① 抬头不带「未能执行」——它是「跑过了、被掐断」，不是「压根没执行」', async () => {
    const deps = makeToolDeps({ exec: { x: timedOut() } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.ok).toBe(false)
    // 逐字钉住抬头——措辞一改，这里就红，改的人得回来看 D39
    expect(outcome.output.split('\n')[0]).toBe('已超时——命令跑过了、被掐断（2000ms 到点）')
    expect(outcome.output).not.toContain('未能执行')
    // 也不许换成别的说法蒙混——默认的失败那一句长这样，出现即说明又走回兜底了
    expect(outcome.output).not.toContain('exec 未能执行')
  })

  test('② 已有输出照常带回——两道流都在，且**排在抬头之后**', async () => {
    const deps = makeToolDeps({ exec: { x: timedOut() } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.output).toBe(
      '已超时——命令跑过了、被掐断（2000ms 到点）\n第一行\n第二行\n\n[stderr]\n一个警告\n',
    )
  })

  test('② 一个字都没吐出来时——只留抬头，不硬凑一行空正文', async () => {
    const deps = makeToolDeps({ exec: { x: timedOut({ stdout: '', stderr: '' }) } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.output).toBe('已超时——命令跑过了、被掐断（2000ms 到点）')
  })

  test('② 截断标记照旧带上（超时的命令也可能话太多）', async () => {
    const deps = makeToolDeps({ exec: { x: timedOut({ truncated: true }) } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.output).toContain('[输出已截断（上限')
  })

  test('③ 与取消互斥：两边各自的抬头，谁也冒充不了谁', async () => {
    const timed = makeToolDeps({ exec: { x: timedOut() } })
    const controller = new AbortController()
    // 取消那一支要**执行中被叫停**：信号在沙箱里中止（入口即中止是另一句
    // 「已取消——未执行」，压根没跑，与本条不是一回事）
    const canceled = makeToolDeps({
      exec: () => {
        controller.abort()
        return { ok: true, exit: 137, stdout: '半截', stderr: '' }
      },
    })

    const timedOutcome = await timed.runtime.invoke(execCall('x'), {})
    const canceledOutcome = await canceled.runtime.invoke(execCall('x'), {
      signal: controller.signal,
    })

    const timedHead = timedOutcome.output.split('\n')[0] ?? ''
    const canceledHead = canceledOutcome.output.split('\n')[0] ?? ''

    // 各说全：超时那句带着**真报了的上界**，取消那句带着**叫停这件事**
    expect(timedHead).toBe(execTimedOutOutput(2000))
    expect(canceledHead).toBe(OUTPUT_CANCELED_RUNNING)

    // 互斥：两句不互含——同一次收尾只会落进其中一句，不会两句都出现
    expect(timedHead).not.toContain(canceledHead)
    expect(canceledHead).not.toContain(timedHead)
    expect(timedOutcome.output).not.toContain(OUTPUT_CANCELED_RUNNING)
    expect(canceledOutcome.output).not.toContain(execTimedOutOutput(2000))
  })

  test('③ 取消**同时**到点：说的是超时那一句，不会两句打架', async () => {
    const controller = new AbortController()
    // 用户这一下 Ctrl+C 与上界到点撞在同一次执行里——沙箱报回来的是**超时**那一形
    // （自持计时器先落的定），调用方的信号也已中止。这种时候只许出一句。
    const deps = makeToolDeps({
      exec: () => {
        controller.abort()
        return timedOut()
      },
    })

    const outcome = await deps.runtime.invoke(execCall('x'), { signal: controller.signal })

    expect(outcome.output).not.toContain('已取消')
    expect(outcome.output.split('\n')[0]).toBe(execTimedOutOutput(2000))
  })

  test('抬头里的数取自**结果里真报了的**那条上界，不是本域自己记的那份', async () => {
    // 沙箱报的是「300」而调用方填的是 2000——两份对不上时，屏上该说的是**真报了的那份**
    // （调用方自己记的那份可能与之不符：换过沙箱实现、或压根不是它给的上界）
    const deps = makeToolDeps({
      exec: {
        x: {
          ok: false,
          reason: 'timeout',
          message: '命令超时（300ms）未完成——已终止',
          timeoutMs: 300,
          stdout: '',
          stderr: '',
        },
      },
    })

    const outcome = await deps.runtime.invoke(execCallWith({ cmd: 'x', timeoutMs: 2000 }), {})

    expect(outcome.output).toBe('已超时——命令跑过了、被掐断（300ms 到点）')
  })

  test('不带 `[exit N]`——退出码是收命的产物（137），抬头已经把事实说全了', async () => {
    const deps = makeToolDeps({ exec: { x: timedOut() } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.output).not.toContain('[exit')
  })

  test('不出现裸英文词——旧报文里那个 `（timeout）` 是漏出去的中英夹杂', async () => {
    const deps = makeToolDeps({ exec: { x: timedOut() } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.output).not.toContain('timeout')
    expect(outcome.output).not.toMatch(/[一-鿿]（[a-z]+）/) // 中文里夹一个裸英文词
  })

  test('结果那一侧照实落库（`ok:false`）——模型与记录看到的是同一份话', async () => {
    const deps = makeToolDeps({ exec: { x: timedOut() } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(deps.sink.byKind('tool.result')[0]?.data.ok).toBe(false)
    expect(deps.sink.byKind('tool.result')[0]?.data.output).toEqual({ text: outcome.output })
  })
})
