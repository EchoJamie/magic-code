/**
 * U46 · **退出按两次**（U68 挪位与加时限）——规格即测试。
 *
 * 规矩（设计 · 会话与运行管理「离开、停止与异常退出」＋ 终端交互「待确认的那一行」，
 * **落哪与时限 2026-09-25 改定**）：
 *
 * | 那一下 | 行为 |
 * | --- | --- |
 * | **工作中** Ctrl+C | 沿既有：中断**我这一轮**（U46/U68 都不动） |
 * | **空闲** Ctrl+C（第一下） | **不退出**，**状态行之下**印一行 `再按一次 ctrl+c 退出` ＋ **起 1.5 秒的钟** |
 * | **1.5 秒内**再按 | 退出（沿既有收尾） |
 * | **1.5 秒到** | **撤掉那一行、同时取消那次监听**——**再按是一次新的** |
 * | 两次之间**任何别的输入** | 清掉那一行（连钟），**不接受「再按一次」了** |
 *
 * **由头**：一个键在同一个状态下有时一次有时两次，用户没法预期——他得先判断「现在有没有
 * 成员在跑」才知道该按几下。统一成「按两次」之后只有一种退出，那一行内容随情况变。
 *
 * **U68 两处改定**（本文件跟着改，别照着旧口径读）：
 *
 * 1. **落哪**——原先在**输入行上方**（交互区顶边），现在在**状态行之下、缩进对齐状态行**。
 *    由头：那一行**不是关于输入的**，放上面会打断「输入行 ↔ 状态行」那一对、还独占一行
 *    挤进输入区；
 * 2. **时限**——原先「不加时限」，现在 **1.5 秒**。由头：它是**那一刻回执**（「你按了一次
 *    Ctrl+C」是刚发生的事），不是常驻一格。**原先那条理由是错的**（把归类的错当成了
 *    交互的错）。
 *
 * 本文件量五件：
 *
 * 1. **屏上那一行**——第一下之后它**在状态行之下**（缩进对齐、不多不少就那一行）；
 * 2. **时限**——1.5 秒内再按才走；到点自己撤，且**再按是新的一次**；
 * 3. **它能被清掉**——这正是不走回执 `·` 那条路的理由（回执印一次就进 scrollback）；
 *    故另有一条钉「**不落记录、不进 scrollback**」；
 * 4. **工作中那一半不许被改坏**——按了仍是中断，且**不冒出那一行**；
 * 5. **账与屏同源**——那一行的那一行高度**进的是「活动区之外那一块」那笔账**
 *    （`chromeHeightOf`，U68 起；交互区那笔账里没有它了）。
 *
 * ⚠️ **矮窗那一半不在这儿量**：它落在 40×10，归 `spec.u31.test.ts` 那条「动态帧一律短于
 * 终端」的矩阵——那儿已经把「按过一次」这一格加进去了。
 */

import { describe, expect, test } from 'bun:test'
import { chromeHeightOf, dockHeightOf } from '../src/components/app.ts'
import { placeholderOf } from '../src/components/composer.ts'
import { EXIT_ARM_MS } from '../src/shell.ts'
import { HINT_EXIT_ARMED, HINT_IDLE } from '../src/view.ts'
import { event } from './events.ts'
import { createStage } from './screen.ts'
import type { Frame, ScreenOptions, Stage } from './screen.ts'

const WIDE: ScreenOptions = { columns: 100, rows: 30 }
const ARM = { kind: 'ctrl+c' } as const
/** 输入行那句空闲占位——量「输入行 ↔ 状态行那一对没被打断」用它当锚。 */
const IDLE_COMPOSER = `› ${placeholderOf('idle')}`

/** 睡过去——「时限」那两条判据真要等钟走完（`EXIT_ARM_MS` 是产品那一侧的数）。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 钟到点之后多给的余量（定时器不是实时的，判据要给 `setTimeout` 一点余地）。 */
const SLACK_MS = 250

// ══ 一 · 空闲：第一下不退出，那一行落在状态行之下 ══════════════════════

describe('空闲按一次 Ctrl+C ⇒ 不退出，那一行在**状态行之下**', () => {
  test('落哪：**状态行之下**、**缩进对齐状态行**，且输入行与状态行之间**没多出东西**', async () => {
    const stage = createStage()
    const before = await stage.screen(WIDE)

    expect(stage.press(ARM).exit).toBe(false) // 不退出（交回组件那一跳没给）
    const after = await stage.screen(WIDE)

    expect(before.has(HINT_EXIT_ARMED)).toBe(false)
    expect(after.has(HINT_EXIT_ARMED)).toBe(true)

    // —— 落哪（U68 的要害）——
    const hint = after.rowOf(HINT_EXIT_ARMED)
    const status = after.statusRow
    // ① **在状态行之下**——不是上面，也不是两条线之间
    expect(hint).toBeGreaterThan(status)
    // ② **紧贴它的下一格**：状态行之下仍是屏底，那一行就是最后一条（不另加线、不空一行）
    expect(hint).toBe(status + 1)
    // ③ **缩进对齐状态行**：两个行首落在同一列（状态行左位那格是 `paddingX: 1`）
    const indent = (row: number): number => after.textAt(row).length - after.textAt(row).trimStart().length

    expect(indent(hint)).toBe(indent(status))
    expect(indent(hint)).toBe(1)

    // —— 那一对没被打断：输入行与状态行之间**只有下沿那条线**，没有第三样东西 ——
    const composer = after.rowOf(IDLE_COMPOSER)
    const between = after.screen.lines.slice(composer + 1, status)
    expect(between.every((line) => /^─+$/u.test(line.trim()) || line.trim() === '')).toBe(true)
    expect(between.filter((line) => /^─+$/u.test(line.trim())).length).toBe(1)
    // 也没有把输入行或状态行挤出屏幕（工单点名看的那一条）
    expect(after.has(IDLE_COMPOSER)).toBe(true)
    // 状态行照旧（那两句是**常驻**提示，与这一行不冲突——设计明写：不许自己删）
    expect(after.statusLine).toContain(HINT_IDLE)
    // ⚠️ 状态行**自己那一格没被换掉**：取错一格（取成待确认那一行）这条当场红
    expect(after.statusLine).not.toContain(HINT_EXIT_ARMED)
  })

  test('**交互区一行都不长**——那一行不是交互区的一格了（U68 挪出去的那一半）', async () => {
    const stage = createStage()
    const before = await stage.screen(WIDE)

    stage.press(ARM)
    const after = await stage.screen(WIDE)

    // 两条线之间那一块**一行不多**（U46 那版在这儿 +1——那正是「挤进输入区」）
    expect(after.dock.length).toBe(before.dock.length)
    // 输入行与状态行**都在原来的行号上**（屏只在下头多长出一行）
    expect(after.rowOf(IDLE_COMPOSER)).toBe(before.rowOf(IDLE_COMPOSER))
    expect(after.statusRow).toBe(before.statusRow)
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
    // 位置**不随左下开着什么而变**：还是状态行之下那一格
    expect(frame.rowOf(HINT_EXIT_ARMED)).toBe(frame.statusRow + 1)
    // 而那一片自己照旧画着（没被这一行顶掉）
    expect(frame.has('MiniMax-M3')).toBe(true)
  })

  test('第二下才走（两下之间没有别的输入、在 1.5 秒内）', async () => {
    const stage = createStage()

    expect(stage.press(ARM).exit).toBe(false)
    expect(stage.shell.getView().exitArmed).toBe(true)
    expect(stage.press(ARM).exit).toBe(true)
  })
})

// ══ 二 · 时限 1.5 秒（U68 加的 · 原先写着「不加时限」）═══════════════════

describe('1.5 秒的时限', () => {
  test('**到点自己撤**——那一行没了、屏上回到常态（连「再按」那道门一起取消）', async () => {
    const stage = createStage()
    const before = await stage.screen(WIDE)

    stage.press(ARM)
    expect(stage.shell.getView().exitArmed).toBe(true)

    await sleep(EXIT_ARM_MS + SLACK_MS)
    const after = await stage.screen(WIDE)

    expect(stage.shell.getView().exitArmed).toBe(false) // 监听取消了
    expect(after.has(HINT_EXIT_ARMED)).toBe(false) // 那一行自己撤了
    // 屏上回到挂上之前那样：非空行数一样、状态行还在原处
    const filled = (frame: Frame): number => frame.screen.lines.filter((line) => line.trim() !== '').length

    expect(filled(after)).toBe(filled(before))
    expect(after.statusRow).toBe(before.statusRow)
  })

  test('**超时之后再按是「新的一次」**——只重新挂上，**不退**', async () => {
    const stage = createStage()
    stage.press(ARM)
    await sleep(EXIT_ARM_MS + SLACK_MS)

    // 这一下**不是**「第二次」：它重新起算
    expect(stage.press(ARM).exit).toBe(false)
    expect(stage.shell.getView().exitArmed).toBe(true)
    expect((await stage.screen(WIDE)).has(HINT_EXIT_ARMED)).toBe(true)

    // 而这一次**在钟内**再按才走（「新的一次」也有它自己的 1.5 秒）
    expect(stage.press(ARM).exit).toBe(true)
  })

  test('**钟内的第二下照样走**（时限不是「更严」，是「回执该有的样子」）', async () => {
    const stage = createStage()
    stage.press(ARM)
    await sleep(EXIT_ARM_MS - SLACK_MS) // 还在钟内

    expect(stage.press(ARM).exit).toBe(true)
  })
})

// ══ 三 · 那一行能被清掉（所以它不走回执那条路）═══════════════════════

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

  test('**清掉之后那支钟也不再管这一格**：重新挂上的那一次，钟从新那一下起算', async () => {
    // 由头：只清行、不收钟的话，第一支钟到点会把**后来重新挂上的**那一次误撤掉
    // ——「明明刚按过，它却自己没了」。
    const stage = createStage()
    stage.press(ARM)
    await sleep(EXIT_ARM_MS / 2) // 老的那支钟走了一半
    stage.type('甲') // 清掉（连钟一起）
    stage.press(ARM) // 重新挂上——这一支钟是**新起的**

    // 老钟的到点时刻（第一下之后 1.5s）落在这一段里；而新钟（第二下之后 1.5s）还没到
    await sleep(EXIT_ARM_MS - EXIT_ARM_MS / 2 + SLACK_MS)

    expect(stage.shell.getView().exitArmed).toBe(true) // 新挂着的那一次没被误撤
    expect((await stage.screen(WIDE)).has(HINT_EXIT_ARMED)).toBe(true)
    expect(stage.press(ARM).exit).toBe(true) // 而且它照旧作数
  })

  test('**不落记录、不进 scrollback**——它不是回执（回执印一次就清不掉了）', async () => {
    const stage = createStage()
    stage.type('先交代一句')
    stage.press({ kind: 'enter' })
    stage.press(ARM)

    const frame = await stage.screen(WIDE)
    const view = stage.shell.getView()

    expect(frame.has(HINT_EXIT_ARMED)).toBe(true) // 屏上有
    // 记录区里没有它（那一行在状态行之下，不是记下来的事）
    expect(frame.record.filter((line) => line.text.includes(HINT_EXIT_ARMED))).toEqual([])
    // 视图那一侧同理：定局那侧与本轮都没有它——它是**画出来的**，不是**记下来的**
    expect(view.rows.filter((row) => JSON.stringify(row).includes(HINT_EXIT_ARMED))).toEqual([])
    // 整份缓冲里一条 `·` 回执都没多（这条路一个字节都不添）
    expect(frame.screen.lines.filter((line) => line.trimStart().startsWith('· '))).toEqual([])
  })
})

// ══ 四 · 工作中那一半不许被改坏 ═══════════════════════════════════════

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

// ══ 五 · 账与屏：那一行占一行（挂上 +1 · 撤掉回 0）════════════════════

describe('账与屏同源', () => {
  test('**「活动区之外那一块」的账**跟着那一行走（挂上 +1 · 撤掉回 0）', () => {
    const stage = createStage()
    const base = chromeHeightOf(stage.shell.getView())

    stage.press(ARM)
    expect(chromeHeightOf(stage.shell.getView())).toBe(base + 1)

    stage.type('x')
    expect(chromeHeightOf(stage.shell.getView())).toBe(base)
  })

  test('**交互区那笔账里没有它了**（U68 挪出去的那一半）', () => {
    const stage = createStage()
    const base = dockHeightOf(stage.shell.getView(), WIDE.columns)

    stage.press(ARM)

    expect(dockHeightOf(stage.shell.getView(), WIDE.columns)).toBe(base)
    // 而屏上那一行**真画着**（不是「两边都少算一行」那种假绿）
    expect(stage.shell.getView().exitArmed).toBe(true)
  })
})
