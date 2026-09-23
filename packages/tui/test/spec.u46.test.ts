/**
 * U46 · **退出按两次**——规格即测试。
 *
 * 规矩（设计 · 会话与运行管理「离开、停止与异常退出」＋ 终端交互「待确认的那一行」）：
 *
 * | 那一下 | 行为 |
 * | --- | --- |
 * | **工作中** Ctrl+C | 沿既有：中断**我这一轮**（本单不动） |
 * | **空闲** Ctrl+C（第一下） | **不退出**，输入行上方印一行 `再按一次 ctrl+c 退出` |
 * | **空闲** Ctrl+C（第二下） | 退出（沿既有收尾） |
 * | 两次之间**任何别的输入** | 清掉那一行，**不接受「再按一次」了** |
 *
 * **由头**：一个键在同一个状态下有时一次有时两次，用户没法预期——他得先判断「现在有没有
 * 成员在跑」才知道该按几下。统一成「按两次」之后只有一种退出，那一行内容随情况变。
 *
 * 本文件量三件：
 *
 * 1. **屏上那一行**——第一下之后它**在输入行上方**（不多不少就那一行），第二下才走；
 * 2. **它能被清掉**——这正是不走回执 `·` 那条路的理由（回执印一次就进 scrollback）；
 *    故另有一条钉「**不落记录、不进 scrollback**」（清得掉的才叫临时提示）；
 * 3. **工作中那一半不许被改坏**——按了仍是中断，且**不冒出那一行**（它不是退出的第一下）。
 *
 * ⚠️ **账与屏同源**那一半不在这儿量：它落在矮窗上（40×10），归 `spec.u31.test.ts`
 * 那条「动态帧一律短于终端」的矩阵——那儿已经把「按过一次」这一格加进去了。
 */

import { describe, expect, test } from 'bun:test'
import { dockHeightOf } from '../src/components/app.ts'
import { placeholderOf } from '../src/components/composer.ts'
import { HINT_EXIT_ARMED, HINT_IDLE } from '../src/view.ts'
import { event } from './events.ts'
import { createStage } from './screen.ts'
import type { ScreenOptions, Stage } from './screen.ts'

const WIDE: ScreenOptions = { columns: 100, rows: 30 }
const ARM = { kind: 'ctrl+c' } as const
/** 输入行那句空闲占位——量「那一行在它上方」用它当锚。 */
const IDLE_COMPOSER = `› ${placeholderOf('idle')}`

// ══ 一 · 空闲：第一下不退出 ═══════════════════════════════════════════

describe('空闲按一次 Ctrl+C ⇒ 不退出，只多出那一行', () => {
  test('**屏上多出一行**，且它在**输入行上方**（进也不是记录、退也不是状态行）', async () => {
    const stage = createStage()
    const before = await stage.screen(WIDE)

    expect(stage.press(ARM).exit).toBe(false) // 不退出（交回组件那一跳没给）
    const after = await stage.screen(WIDE)

    expect(before.has(HINT_EXIT_ARMED)).toBe(false)
    expect(after.has(HINT_EXIT_ARMED)).toBe(true)
    // **不多不少**：交互区长出来的正好这一行
    expect(after.dock.length).toBe(before.dock.length + 1)
    // 位置：**输入行上方**（常态下就是紧贴它的那一行——中间不夹别的东西）
    expect(after.rowOf(HINT_EXIT_ARMED)).toBe(after.rowOf(IDLE_COMPOSER) - 1)
    // 也没有把输入行或状态行挤出屏幕（工单点名看的那一条）
    expect(after.has(IDLE_COMPOSER)).toBe(true)
    // 状态行照旧（那两句是**常驻**提示，与这一行不冲突——设计明写：不许自己删）
    expect(after.statusLine).toContain(HINT_IDLE)
  })

  test('左下开着**选择器**时也照说（「空闲按一次不退出」不随右下开着什么而变）', async () => {
    const stage = createStage()
    // `/model` 那一屏：选择器接管了交互区——此刻按 ctrl+c 仍是**空闲**那一下，不是一个新岔口
    stage.type('/model')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('model.catalog', {
        entries: [
          { provider: 'minimax', model: 'MiniMax-M3' },
          { provider: 'local', model: 'qwen3' },
        ],
        current: { provider: 'minimax', model: 'MiniMax-M3' },
      }),
    ])

    expect(stage.press(ARM).exit).toBe(false)
    const frame = await stage.screen(WIDE)

    expect(frame.has(HINT_EXIT_ARMED)).toBe(true)
    // 它压在**选择器那一片之上**（那一格是交互区的顶边——三种用法下都在同一处）
    expect(frame.rowOf(HINT_EXIT_ARMED)).toBeLessThan(frame.rowOf('MiniMax-M3'))
    // 而那一片自己照旧画着（没被这一行顶掉）
    expect(frame.has('MiniMax-M3')).toBe(true)
  })

  test('第二下才走（两下之间没有别的输入）', async () => {
    const stage = createStage()

    expect(stage.press(ARM).exit).toBe(false)
    expect(stage.shell.getView().exitArmed).toBe(true)
    expect(stage.press(ARM).exit).toBe(true)
  })

  test('**不加时限**：隔多久都还算数——中间来几条与输入无关的事件，那一行不动', async () => {
    // 「不加时限」＝不设「2 秒内有效」（加了就是「按了没反应」的变体）。这条**没有定时器**
    // 可判，量的是它的另一面：那一行只由**用户**的输入决定去留，别的东西推不动它。
    const stage = createStage()
    stage.press(ARM)

    stage.feed([
      event('model.usage', { inputTokens: 1200, outputTokens: 3 }),
      event('model.call.end', {}),
    ])

    expect(stage.shell.getView().exitArmed).toBe(true)
    expect(stage.press(ARM).exit).toBe(true)
  })
})

// ══ 二 · 那一行能被清掉（所以它不走回执那条路）═══════════════════════

describe('两次之间**任何别的输入** ⇒ 那一行没了、也不再退出', () => {
  test('敲一个字：那一行消失、没退出，那一个字照常落进草稿', async () => {
    const stage = createStage()
    stage.press(ARM)

    stage.type('甲')

    const frame = await stage.screen(WIDE)

    expect(frame.has(HINT_EXIT_ARMED)).toBe(false) // 那一行没了
    expect(frame.has(`› 甲`)).toBe(true) // 而草稿正常（这一轮输入不受影响）
    expect(stage.shell.getView().exitArmed).toBe(false)
    // **也不接受「再按一次」了**：再按一下只是**重新起算**，不是退出
    expect(stage.press(ARM).exit).toBe(false)
    expect(stage.shell.getView().exitArmed).toBe(true)
  })

  test('`esc`（不落草稿的键）同样把它清掉', async () => {
    const stage = createStage()
    stage.press(ARM)
    stage.press({ kind: 'escape' })

    expect(stage.shell.getView().exitArmed).toBe(false)
    expect((await stage.screen(WIDE)).has(HINT_EXIT_ARMED)).toBe(false)
  })

  test('**不落记录、不进 scrollback**——它不是回执（回执印一次就清不掉了）', async () => {
    const stage = createStage()
    stage.type('先交代一句')
    stage.press({ kind: 'enter' })
    stage.press(ARM)

    const frame = await stage.screen(WIDE)
    const view = stage.shell.getView()

    expect(frame.has(HINT_EXIT_ARMED)).toBe(true) // 屏上有
    // 记录区里没有它（那一行在两块**之间**那一格里，不是记下来的事）
    expect(frame.record.filter((line) => line.text.includes(HINT_EXIT_ARMED))).toEqual([])
    // 视图那一侧同理：定局那侧与本轮都没有它——它是**画出来的**，不是**记下来的**
    expect(view.rows.filter((row) => JSON.stringify(row).includes(HINT_EXIT_ARMED))).toEqual([])
    // 整份缓冲里一条 `·` 回执都没多（这条路一个字节都不添）
    expect(frame.screen.lines.filter((line) => line.trimStart().startsWith('· '))).toEqual([])
  })
})

// ══ 三 · 工作中那一半不许被改坏 ═══════════════════════════════════════

describe('工作中按 Ctrl+C ⇒ 仍是中断本轮（不退出、也不冒那一行）', () => {
  /** 这一轮跑起来了（工具在跑 ⇒ 状态行报 `ctrl+c 中断`）。 */
  const working = (): Stage => {
    const stage = createStage()
    stage.feed([
      event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
      event('turn.start', {}),
    ])

    return stage
  }

  test('发 `turn.interrupt`，不退；那一行**不冒出来**（它不是退出的第一下）', async () => {
    const stage = working()

    expect(stage.press(ARM).exit).toBe(false)
    expect((await stage.screen(WIDE)).has(HINT_EXIT_ARMED)).toBe(false)
    expect(stage.commands()).toEqual([{ type: 'turn.interrupt' }])
  })

  test('接管中按 Ctrl+C 也照旧（全局键，接管不吞）', async () => {
    const stage = createStage()
    stage.feed([
      event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
      event(
        'tool.decision.request',
        { call: 71, name: '跑测试', material: '命令 bun test', weight: 'light' },
        { id: 88 },
      ),
    ])

    expect(stage.press(ARM).exit).toBe(false)
    expect(stage.commands()).toEqual([{ type: 'turn.interrupt' }])
  })
})

// ══ 四 · 账与屏：那一行占一行（挂上 +1 · 撤掉回 0）════════════════════

describe('账与屏同源', () => {
  test('交互区的高度账**跟着那一行走**（挂上 +1 · 撤掉回 0）', () => {
    const stage = createStage()
    const base = dockHeightOf(stage.shell.getView(), WIDE.columns)

    stage.press(ARM)
    expect(dockHeightOf(stage.shell.getView(), WIDE.columns)).toBe(base + 1)

    stage.type('x')
    expect(dockHeightOf(stage.shell.getView(), WIDE.columns)).toBe(base)
  })
})
