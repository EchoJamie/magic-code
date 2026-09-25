/**
 * U06 · 取消 —— 三个时点的中止，各归各位。
 *
 * 口径（U05 已锚 · 任务书复述）——`signal` 中止 → 沙箱侧 `ok:true` ＋ exit 137
 * （**命令被信号终止＝命令失败一例**）；**取消事实由 `signal.aborted` 判定**；
 * 超时才是 `ok:false, reason:'timeout'`。U07 备案把闸门那一环的交接交给本域：
 * 「工具域可经 `invoke` 的 `signal` **竞速**」。
 *
 * 三个时点：
 * ① **入口即中止**——连问都不问（用户刚按了 Ctrl-C，再弹一个「要不要跑 rm -rf」是骚扰）；
 * ② **在途裁决被中止**——问了但不等了（**不挂起**是这一例的主题）；
 * ③ **执行中被中止**——沙箱按 137 回报，本域据 `signal.aborted` 归「已取消」。
 *
 * ⚠️ 已知限度（随用例钉住，免得被当 bug 修错）：②之后权限域那一侧的询问**仍悬着**——
 * 本域拿不到它的请求 id（配对键是**请求事件** id，由权限域自己铸），无从答复。
 * 「未答复裁决＝按拒绝落账」是阶段 2 恢复期议题（技术方案 · 恢复 ④）。
 */

import { describe, expect, test } from 'bun:test'
import { execCall, makeToolDeps, waitFor } from './helpers.ts'

describe('U06 · 取消', () => {
  test('入口即中止 → 不问闸门、不执行；链仍收尾（请求 → 结果）', async () => {
    const deps = makeToolDeps()
    const controller = new AbortController()
    controller.abort()

    const outcome = await deps.runtime.invoke(execCall('rm -rf build'), { signal: controller.signal })

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('已取消——未执行')
    expect(deps.gate.requests).toHaveLength(0) // 没骚扰用户
    expect(deps.sandbox.execs).toHaveLength(0) // 也没执行

    // 「模型请求过」是事实，链照样收尾——不留「有 tool.call 无 tool.result」的在途态
    expect(deps.sink.events.map((e) => e.kind)).toEqual(['tool.call', 'tool.result'])
    expect(deps.sink.byKind('tool.result')[0]?.data.call).toBe(outcome.callRef)
  })

  test('在途裁决被中止 → 不挂起，以「已取消」回填、不执行', async () => {
    const deps = makeToolDeps({ decider: 'manual' })
    const controller = new AbortController()

    const pending = deps.runtime.invoke(execCall('ls'), { signal: controller.signal })
    await waitFor(() => (deps.gate.requests.length === 1 ? true : undefined), '闸门问起来')
    expect(deps.gate.pending).toHaveLength(1)

    controller.abort()
    const outcome = await pending

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('已取消——未执行')
    expect(deps.sandbox.execs).toHaveLength(0)
    expect(deps.sink.byKind('tool.result')[0]?.data.ok).toBe(false)

    // 已知限度：权限域那一侧的询问仍悬着（见文件头注）
    expect(deps.gate.pending).toHaveLength(1)
  })

  test('执行中被中止 → 沙箱按 137 回报，本域归「已取消」', async () => {
    const controller = new AbortController()
    const deps = makeToolDeps({
      exec: (_cmd, opts) => {
        opts.onOutput?.({ channel: 'stdout', text: '半截' })
        controller.abort() // 命令在途时被叫停
        return { ok: true, exit: 137, stdout: '半截', stderr: '' }
      },
    })

    const outcome = await deps.runtime.invoke(execCall('sleep 99'), { signal: controller.signal })

    expect(deps.sandbox.execs[0]?.opts.signal).toBe(controller.signal) // 信号确实传到沙箱
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('已取消——命令被中止\n半截')
    // 取消前已产出的输出照常带回（U05 口径）——增量也照发
    expect(deps.sink.byKind('tool.output.delta')).toHaveLength(1)
  })

  test('命令自己死成 137 ≠ 取消（同码不同界，靠 signal 判定）', async () => {
    const deps = makeToolDeps({ exec: { x: { ok: true, exit: 137, stdout: '', stderr: '' } } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('[exit 137]')
  })

  test('取消 ≠ 超时：超时照旧归 reason，**抬头不混进取消那一句**', async () => {
    const controller = new AbortController()
    const deps = makeToolDeps({
      exec: {
        x: { ok: false, reason: 'timeout', message: '命令超时（200ms）未完成——已终止', timeoutMs: 200, stdout: '', stderr: '' },
      },
    })

    // 信号也中止了（用户按了 Ctrl+C）**同时**到点——两支互斥由构造保证：
    // 超时那一支只可能来自沙箱的自持计时器，故这一趟说的是「超时」那一句，
    // 不是「已取消」（同一次里不会两句都出现，见 `composeOutcome` 那一支的注）。
    const outcome = await deps.runtime.invoke(execCall('x'), { signal: controller.signal })

    expect(outcome.output).toBe('已超时——命令跑过了、被掐断（200ms 到点）')
  })
})
