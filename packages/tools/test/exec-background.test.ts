/**
 * U70 · `exec` 的**后台那一形**（工具域那一半）——参数 · 回执 · 不绕闸门。
 *
 * 落在这里的判据（设计 · 工具执行与权限「`exec` 有「后台」那一形」）：
 * - **第一格 · 发起**——`exec` 的一个布尔参数**（不新造工具）**；给了它，这一条命令
 *   就**交出去**：工具当场回执（**认得出它的 id ＋ 它的输出文件路径**），
 *   **不在轮内等它**（沙箱一次都不被调）；
 * - **⚠️ 闸门照走**——后台那一形**不是绕过裁决的口子**：这一支跑在 `run` 里，
 *   而 `run` 只可能在闸门批准之后被调到（见 `dispatch.ts`）。本文件用「闸门拒绝」那一趟
 *   实测一遍：**拒绝之后，一次都没交出去**；
 * - **没接后台能力就不假装**——那次装配没这一件时照实回一句，**不静默退回前台**
 *   （退回＝把「交出去」偷偷改成「占着这一轮跑完」）；
 * - **前台一字不动**——不带这一个键时，沙箱拿到的选项与加它之前逐字相同。
 */

import { describe, expect, test } from 'bun:test'
import type { BackgroundFinish, BackgroundRuns, BackgroundStart, BackgroundStop } from '@magic/contracts'
import { EXEC_PARAMETERS } from '../src/exec-tool.ts'
import { collector, execCall, makeToolDeps } from './helpers.ts'

/** 一个后台登记的替身——记下每一次 `start` / `stop`，并按剧本回话。 */
function fakeRuns(options: {
  readonly start?: BackgroundStart
  readonly stop?: BackgroundStop
} = {}): { readonly runs: BackgroundRuns; readonly started: string[]; readonly stopped: string[] } {
  const started: string[] = []
  const stopped: string[] = []

  return {
    started,
    stopped,
    runs: {
      async start(cmd) {
        started.push(cmd)
        return options.start ?? { ok: true, id: 'bg-7', outputPath: '/run/bg/bg-7.log' }
      },
      async stop(id) {
        stopped.push(id)
        return options.stop ?? { ok: true, note: '已停掉' }
      },
      // **读面**（U89）——工具域一个字都不读它（这一支只管「起」与「停」）；
      // 它在这儿是因为**端口上就在**（谁实现 `BackgroundRuns` 谁就得答这一面）。
      running: () => [],
    },
  }
}

/** 带 `background: true` 的那一次调用。 */
function backgroundCall(cmd: string): { id: string; name: string; args: Record<string, unknown> } {
  return { id: 'call_bg', name: 'exec', args: { cmd, background: true } }
}

describe('U70 · 后台那一形的发起', () => {
  test('交出去 ⇒ 当场回 id ＋ 输出文件路径，**沙箱一次都不被调**', async () => {
    const fake = fakeRuns()
    const deps = makeToolDeps({ background: fake.runs })

    const outcome = await deps.runtime.invoke(backgroundCall('npm run dev'), {})

    expect(outcome.ok).toBe(true)
    // 三件都在回执里：id · 路径 · 怎么看进展
    expect(outcome.output).toContain('bg-7')
    expect(outcome.output).toContain('/run/bg/bg-7.log')
    expect(outcome.output).toContain('read')
    // **不在轮内跑**——沙箱没被碰过（这一形存在的全部理由）
    expect(deps.sandbox.execs.length).toBe(0)
    expect(fake.started).toEqual(['npm run dev'])
  })

  test('回执里钉住「安静 ≠ 结束」——模型不许拿没输出当跑完了', async () => {
    const deps = makeToolDeps({ background: fakeRuns().runs })

    const outcome = await deps.runtime.invoke(backgroundCall('sleep 1'), {})

    expect(outcome.output).toContain('别当它已经结束')
  })

  test('交不出去（起不来 / 文件开不了）⇒ ok:false，且说清是「没能交出去」', async () => {
    const deps = makeToolDeps({
      background: fakeRuns({ start: { ok: false, reason: '启动失败（cwd: /nope）：ENOENT' } }).runs,
    })

    const outcome = await deps.runtime.invoke(backgroundCall('whatever'), {})

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('没能交出去')
    expect(outcome.output).toContain('ENOENT')
    expect(deps.sandbox.execs.length).toBe(0)
  })

  test('没接后台能力 ⇒ 照实说「没接」，**不静默退回前台**', async () => {
    const deps = makeToolDeps()

    const outcome = await deps.runtime.invoke(backgroundCall('npm run dev'), {})

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('没有接后台能力')
    // 退回前台＝把「交出去」偷偷改成「占着这一轮跑完」，那正是这一条要防的
    expect(deps.sandbox.execs.length).toBe(0)
  })
})

describe('U70 · 后台那一形照旧过闸门', () => {
  test('闸门拒绝 ⇒ 一次都没交出去（后台不是绕过裁决的口子）', async () => {
    const fake = fakeRuns()
    const deps = makeToolDeps({ background: fake.runs, decider: 'reject' })

    const outcome = await deps.runtime.invoke(backgroundCall('rm -rf /'), {})

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('已拒绝——未执行')
    expect(fake.started).toEqual([])
    expect(deps.sandbox.execs.length).toBe(0)
    // **问过**——后台那一位没有把闸门短路掉（替身不留事件，留的是它自己那份询问痕）
    expect(deps.gate.requests.length).toBe(1)
    expect(deps.gate.requests[0]?.call.args['background']).toBe(true)
    // 走的是**同一条**「请求 → 闸门 → 执行 → 回填」：请求那一条事件照发（`tool.call`）
    expect(deps.sink.byKind('tool.call').length).toBe(1)
  })
})

describe('U70 · 前台那一形一字不动', () => {
  test('不带 background ⇒ 走沙箱（与加它之前逐字相同）', async () => {
    const fake = fakeRuns()
    const deps = makeToolDeps({ background: fake.runs })

    const outcome = await deps.runtime.invoke(execCall('echo hi'), {})

    expect(outcome.ok).toBe(true)
    expect(deps.sandbox.execs.map((one) => one.cmd)).toEqual(['echo hi'])
    expect(fake.started).toEqual([])
  })

  test('`background` 给成假值（false / 非布尔）⇒ 照前台走，不猜', async () => {
    const fake = fakeRuns()
    const deps = makeToolDeps({ background: fake.runs })

    await deps.runtime.invoke({ id: 'c1', name: 'exec', args: { cmd: 'a', background: false } }, {})
    await deps.runtime.invoke({ id: 'c2', name: 'exec', args: { cmd: 'b', background: 'yes' } }, {})

    expect(deps.sandbox.execs.map((one) => one.cmd)).toEqual(['a', 'b'])
    expect(fake.started).toEqual([])
  })

  test('参数模式仍是叠在 EXEC_PARAMETERS 之上——那个对象本身没被改（它归 U69）', () => {
    // ⚠️ **判的是「关系」，不是一份冻结的键名**（U69 合入时改的这条）：
    // 原写法把键名写死（`['cmd']` / `['cmd','background']`），U69 往 `EXEC_PARAMETERS`
    // 里添了 `timeoutMs` 之后它当场红——**红的不是"叠加被破了"，是"名单过期了"**。
    // 这个用例真正要守的是**叠加关系**：`background` 不进那个对象，只叠在送给模型的那一份上。
    expect(Object.keys(EXEC_PARAMETERS.properties)).not.toContain('background')

    const deps = makeToolDeps()
    const parameters = deps.runtime.definitions()[0]?.parameters
    expect(Object.keys(parameters?.properties ?? {})).toEqual([
      ...Object.keys(EXEC_PARAMETERS.properties),
      'background',
    ])
  })

  test('闸门放行的那一趟照旧把结果回填（后台那位不掺和别的工具）', async () => {
    const seen = collector()
    const deps = makeToolDeps({ background: fakeRuns().runs })

    await deps.runtime.invoke(backgroundCall('x'), { onOutput: seen.push })

    // 后台那一形：没有流式增量可报（它压根不等输出）
    expect(seen.deltas).toEqual([])
    expect(deps.sink.byKind('tool.result').length).toBe(1)
  })
})

// 类型层探针（tsc 校验；`bun test` 只剥类型，不做检查）——
// 替身与契约端口同形：夹具换实现时当场在编译期现形
type _FakeMatchesPort = ReturnType<typeof fakeRuns>['runs'] extends BackgroundRuns ? true : never
const _probe: _FakeMatchesPort = true
void _probe
void (undefined as unknown as BackgroundFinish)
