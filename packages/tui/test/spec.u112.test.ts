/**
 * 规格即测试 · **符号 ＋ 动效（一套）＋ 状态行可配**（U112）。
 *
 * 出处：设计 · 终端交互「符号 ＋ 动效：一套」（含取字准则、逐条取舍、字形白名单、三条例）
 * 与「状态行可配置：给一列可选项，不给脚本」。
 *
 * ## 这一层量的是「屏」，不是「视图对象」
 *
 * 那两节写的全是**用户看得见的东西**：「助手正文去记号」「`▸ ✓ 名(参数)`」「状态格分形状」
 * 「进行中在动、成/败定住」——这些话在视图对象里一个字都读不出来。故走真链路真终端
 * （`createStage` → `AppView` → Ink → `@xterm/headless` → 屏幕矩阵 ＋ 每格的色），
 * 与 `spec.log.test.ts` / `sessions.test.ts` 同一套取景。
 *
 * ## 骨架（三条例 · 设计原文）
 *
 * ① **表示「正在发生」的那一行/那一位可以动**（2026-10-01 口径说准：工具行那一位 ·
 * 思考行 · 状态格 · 计划步这四处；**身份符号 `›` `▸` `⋯` `│` 永不动**）；
 * ② **「动 → 静」就是完成信号**；③ **一切动效
 * 可停**（减少动效 · 不可见/等答/错误/空闲 ⇒ 停），**不用闪烁**，**不为动效新增第二个
 * 常驻计时器**。
 */

import { describe, expect, test } from 'bun:test'
import { GLYPH_WHITELIST, MARKS } from '../src/marks.ts'
import { stateMark } from '../src/view.ts'
import { BREATH_MS, PULSE_MS, breathColor, breathOf, pulseOf } from '../src/motion.ts'
import { event } from './events.ts'
import { createStage } from './screen.ts'
import type { Frame } from './screen.ts'

const AT = 1_700_000_000_000

/** 取景那一屏多大——工具行折行与状态行降级都跟它有关。 */
const SCREEN = { columns: 100, rows: 30 } as const

/** 起一个壳（空手——这一层多数用例只要一个能画的地方）。 */
function live() {
  return createStage()
}

/** 一次工具调用的两条事件（发起 ＋ 结果）——`result` 不给就不落地（跑动着）。 */
function toolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  result?: { readonly ok: boolean; readonly text: string },
) {
  const call = event('tool.call', { name, args }, { id: 71 })

  return result === undefined
    ? [call]
    : [
        call,
        event('tool.result', { call: 71, ok: result.ok, output: { text: result.text } }, { id: 72 }),
      ]
}

/** 一条行的**色**（那一格吃的是什么色）——`null` ＝ 默认色。 */
function fgAt(frame: Frame, row: number, column: number): string | null {
  return frame.cellsOf(row)[column]?.fg ?? null
}

// ══ 一 · 记号：身份与状态两维 ═════════════════════════════════════════

describe('记号 · 身份与状态两维（U112）', () => {
  test('助手正文**去记号**：`⏺` 不上屏，正文**顶格**（首行与续行都在同一条线上）', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'text', text: '第一行的话\n第二行的话' })])

    const frame = await stage.screen()

    expect(frame.has('⏺')).toBe(false)
    // **顶格**：两行都在第 1 列起（记号一去，垫它的那两格也跟着去）
    expect(frame.cellsOf(frame.rowOf('第一行的话'))[0]?.text).toBe('第')
    expect(frame.cellsOf(frame.rowOf('第二行的话'))[0]?.text).toBe('第')
  })

  test('工具行＝`▸ ✓ 工具名(关键参数)`——身份、**状态位紧挨着它**、名字；**不贴原始 JSON**', async () => {
    const stage = live()
    stage.feed(toolCall('exec', { cmd: 'ls -la' }, { ok: true, text: '14 项' }))

    const frame = await stage.screen(SCREEN)
    const row = frame.rowOf('▸ ✓ exec(ls -la)')
    const cells = frame.cellsOf(row)

    // **缩进一级**（头两格空白）→ 身份 `▸` → **状态位** → 空格 → 名字
    expect(cells[0]?.text).toBe(' ')
    expect(cells[2]?.text).toBe('▸') // 身份位（不是 `⟳`）
    expect(cells[3]?.text).toBe(' ')
    expect(cells[4]).toMatchObject({ text: MARKS.ok, fg: '#98c379' }) // **状态位在身份右边**
    expect(cells[5]?.text).toBe(' ')
    expect(cells[6]?.text).toBe('e') // 名字紧跟在后面
    // **不贴 JSON**：那个 `{` 一个都不许上屏
    expect(frame.has('{"')).toBe(false)
    expect(frame.has('"cmd"')).toBe(false)
  })

  test('状态位：成 `✓` · 败 `×`——`✘`(U2718) 与 `✗`(U2717) **都不上屏**', async () => {
    const done = live()
    done.feed(toolCall('read', { path: 'notes.txt' }, { ok: true, text: '42 行' }))
    expect((await done.screen()).has(MARKS.ok)).toBe(true)

    const failed = live()
    failed.feed(toolCall('exec', { cmd: 'git status' }, { ok: false, text: '不是 git 仓库——先 git init' }))
    const frame = await failed.screen()

    expect(frame.has(MARKS.fail)).toBe(true)
    expect(frame.has('✘')).toBe(false) // 带 emoji 变体的那个——取字准则②点名禁的
    expect(frame.has('✗')).toBe(false) // 改前用的那个
    expect(frame.has(MARKS.ok)).toBe(false)
  })

  test('工具结果**缩进一级 · 不加符号**（那半句「耗时 · 摘要」）', async () => {
    const stage = live()
    stage.feed(toolCall('ls', { path: '.' }, { ok: true, text: 'a.txt\nb.txt' }))

    const frame = await stage.screen()
    // 列表类的结果行报**项数**（`ls` 两行输出 ⇒ `2 项`）——缩进一级、无记号
    const row = frame.rowOf('2 项')

    // 缩进一级＝头两格是空白，**不是**一个记号
    expect(frame.cellsOf(row)[0]?.text).toBe(' ')
    expect(frame.cellsOf(row)[1]?.text).toBe(' ')
    expect(frame.cellsOf(row)[2]?.text).not.toBe(MARKS.ok)
    expect(frame.textAt(row)).toContain('·')
  })

  /**
   * **字形白名单**（设计原文那九个）——**白名单之外一律不用**。
   *
   * 反面挑的是**这一单要换掉的那几个**：`⏺`(U+23FA) · `⟳`(U+27F3) · `✘`(U+2718)。
   * 前两个正是「覆盖差 / emoji 风险」那两条点名禁掉的码位。
   */
  test('字形白名单——改前那几个记号（`⏺` `⟳` `✘`）一个都不上屏', async () => {
    const stage = live()
    stage.feed([
      ...toolCall('exec', { cmd: 'echo hi' }, { ok: true, text: 'hi' }),
      event('model.delta', { channel: 'text', text: '说完了。' }),
    ])

    const frame = await stage.screen()

    for (const banned of ['⏺', '⟳', '✘', '⚙']) expect(frame.has(banned)).toBe(false)

    // 白名单本身——**2026-10-01 裁定后那十三个**（`○` `▲` `■` `!` 按准则收进来，
    // `◉` 换成 `◊`）。改一个字都算跑偏。
    // （次序＝`marks.ts` 里「行首身份 → 分隔符 → 状态六形 → 收梢三态」那一段的次序）
    expect(GLYPH_WHITELIST.join('')).toBe('›▸⋯│·●○◊▲■✓×!')
  })

  /**
   * **每一个记号都得有自己那一格语义位**（2026-10-01 用户裁定的后半句：
   * 「每一形要有**明确的语义位**，不许随手用」）。
   *
   * 判据落在**不重样**上：白名单里没有重复的码位，且 `MARKS` 里每一个取值都在白名单内。
   * 「谁出现在哪一处」那张表在 `marks.ts` 的注释里；这一条能咬住的是
   * **一个形只领一个名字**——往 `MARKS` 里塞两个同形、或漏登记一个白名单形，都会红。
   */
  test('马甲一致：`MARKS` 全在白名单内，且白名单里**一个形只领一位**（不重样）', () => {
    for (const value of Object.values(MARKS)) expect(GLYPH_WHITELIST).toContain(value)
    expect(new Set(GLYPH_WHITELIST).size).toBe(GLYPH_WHITELIST.length)
    expect(GLYPH_WHITELIST).toHaveLength(13)
    // 登记表也是不重样的（没登记的白名单形＝没人用它，那是漏，不是错——故只判有值的那些）
    const used = Object.values(MARKS)
    expect(new Set(used).size).toBe(used.length)
  })

  /**
   * **状态那一格的形状表**（2026-10-01 用户裁定，逐字）：
   * 工作中 `●` · 等你在 `◊` · 空闲 `○` · 错误 `▲`。另两个状态沿用它们的形
   * （重试＝进行中那一档 ⇒ `●`；失联＝放弃判断 ⇒ `■`）。**六个状态六个形，两两不同。**
   */
  test('状态格形状表：六态六形，两两不同（裁定逐字落成判据）', () => {
    const shapes = {
      working: stateMark('working'),
      waiting: stateMark('waiting'),
      idle: stateMark('idle'),
      error: stateMark('error'),
      retrying: stateMark('retrying'),
      lost: stateMark('lost'),
    }

    expect(shapes.working).toBe('●')
    expect(shapes.waiting).toBe('◊')
    expect(shapes.idle).toBe('○')
    expect(shapes.error).toBe('▲')
    expect(shapes.retrying).toBe('●') // 进行中那一档，与「工作中」同形（文案分得开）
    expect(shapes.lost).toBe('■')

    // **等你不是工作中那个形**（这是整套里最要紧的一处分别）
    expect(shapes.waiting).not.toBe(shapes.working)
    // 四个「主状态」两两不同（重试并入进行中那一档，故五形两两不同）
    const main = [shapes.working, shapes.waiting, shapes.idle, shapes.error, shapes.lost]
    expect(new Set(main).size).toBe(main.length)
  })
})

// ══ 二 · 动效：只挂状态位 ·「动 → 静」═ 完成信号 ═══════════════════════

describe('动效 · 只挂状态位（U112）', () => {
  /**
   * **进行中在动**——`▸` 右边那一位的色随「此刻」变（那是呼吸）。
   *
   * 三个「此刻」取一轮呼吸里的三档：0（暗端）· 一半（最亮）· 四分之一（中间）。
   * 亮度是纯函数给的（`breathOf`），故这里比的是**画出来那一格真正吃的色**。
   */
  test('进行中：那一位**在动**（三个「此刻」三个亮度）', async () => {
    const stage = live()
    stage.feed(toolCall('exec', { cmd: 'sleep 9' }))

    const shades: string[] = []
    for (const phase of [0, BREATH_MS / 4, BREATH_MS / 2]) {
      stage.at(AT + 71 + phase)
      const frame = await stage.screen(SCREEN)
      shades.push(fgAt(frame, frame.rowOf('▸ ● exec(sleep 9)'), 4) ?? '')
    }

    expect(new Set(shades).size).toBe(3) // 三档各不相同 ⇒ 在动
    // 中点最亮（设计：「约两秒一轮轻微**亮度呼吸**」——三角波）
    expect(shades[2]).not.toBe(shades[0])
  })

  test('**「动 → 静」就是完成信号**：成/败**定住**——换几个「此刻」，色一样', async () => {
    const stage = live()
    stage.feed(toolCall('exec', { cmd: 'echo hi' }, { ok: true, text: 'hi' }))

    const shades: string[] = []
    for (const phase of [0, BREATH_MS / 4, BREATH_MS / 2]) {
      stage.at(AT + 72 + phase)
      const frame = await stage.screen(SCREEN)
      shades.push(fgAt(frame, frame.rowOf('▸ ✓ exec(echo hi)'), 4) ?? '')
    }

    expect(new Set(shades).size).toBe(1) // 定住
    expect(shades[0]).toBe('#98c379') // 而且就是 `ok` 原色（不是某个中间亮度）
  })

  /**
   * **状态那一格分形状**（设计：「必须分形状，不能只靠颜色」）。
   *
   * 判据落在**第一格的字符**上——不是色：无色终端里那两位各有各的形。
   */
  test('状态格**分形状**：工作中 `●` · 等你 `◊`（无色也分得出）', async () => {
    const working = live()
    working.feed([event('turn.start', {}, { id: 90 })])
    const asked = await working.screen()
    expect(asked.statusLine).toContain(`${MARKS.dot} 工作中`)

    const waiting = live()
    waiting.feed([
      ...toolCall('exec', { cmd: 'sleep 9' }),
      event('tool.decision.request', { call: 71, name: 'exec', material: '命令 sleep 9', weight: 'light' }, { id: 88 }),
    ])
    waiting.press({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
    const held = await waiting.screen()
    expect(held.statusLine).toContain(`${MARKS.ring} 等你定夺`)
    expect(held.statusLine).not.toContain(`${MARKS.dot} 等你定夺`)
  })

  test('工作中那一位**在动**；等你那一位**不持续动**（同一个 `pulseAt` 下，几个「此刻」一个色）', async () => {
    // 工作中：两个「此刻」两个亮度
    const working = live()
    working.feed([event('turn.start', {}, { id: 90 })])
    const markFg = (frame: Frame): string | null | undefined => frame.cellsOf(frame.statusRow)[1]?.fg

    working.at(AT)
    const first = markFg(await working.screen(SCREEN))
    working.at(AT + BREATH_MS / 2)
    const second = markFg(await working.screen(SCREEN))
    expect(first).not.toBe(second)

    // 在等你：脉冲走完之后（> PULSE_MS）几个「此刻」都定在同一色
    const waiting = live()
    waiting.feed([
      ...toolCall('exec', { cmd: 'sleep 9' }),
      event('tool.decision.request', { call: 71, name: 'exec', material: '命令 sleep 9', weight: 'light' }, { id: 88 }),
    ])
    waiting.press({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
    waiting.pulseAt(AT)
    waiting.at(AT + PULSE_MS + 400)
    const settled = await waiting.screen(SCREEN)
    waiting.at(AT + PULSE_MS + 900)
    const later = await waiting.screen(SCREEN)
    expect(markFg(settled)).toBe(markFg(later))
  })

  /**
   * **「在等你」出现时脉冲一次**——从暗端单调升到原色，走完定住。
   *
   * 这一条量的是**逐帧**（`pulseAt` 固定、几个不同的「此刻」）：静态帧看不出动效，
   * 故取三帧比色（设计：「如静态帧看不出动效就另附逐帧或多次采样」）。
   */
  test('「在等你」**脉冲一次**：逐帧取样——一路变亮，走完定住（不是闪烁）', async () => {
    const stage = live()
    stage.feed([
      ...toolCall('exec', { cmd: 'sleep 9' }),
      event('tool.decision.request', { call: 71, name: 'exec', material: '命令 sleep 9', weight: 'light' }, { id: 88 }),
    ])
    stage.press({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
    stage.pulseAt(AT)

    const shades: string[] = []
    for (const step of [0, Math.floor(PULSE_MS / 2), PULSE_MS, PULSE_MS * 2]) {
      stage.at(AT + step)
      const frame = await stage.screen(SCREEN)
      shades.push(frame.cellsOf(frame.statusRow)[1]?.fg ?? '')
    }

    // **单调**（越走越亮，不回摆——回摆就是闪，设计明写「不用闪烁」）
    expect(new Set(shades).size).toBeGreaterThan(1)
    expect(shades[1]).not.toBe(shades[0])
    // **走完定住**（PULSE_MS 与它之后同色）
    expect(shades[2]).toBe(shades[3])
    // 定住的那一档是**原色**（`warn`）——不是某个中间亮度
    expect(shades[3]).toBe('#e5c07b')
  })

  /**
   * **减少动效**（设计那三条例的③）——开了就**停转动与亮度变化**：
   * 进行中那一位改成原色、一动不动；**而读数照旧**（秒数是读数，停了就是假话）。
   */
  test('减少动效：进行中那一位**不动**（两个「此刻」同色），**秒数照旧报**', async () => {
    const stage = createStage({ reducedMotion: true })
    stage.feed(toolCall('exec', { cmd: 'sleep 9' }))

    const shades: string[] = []
    for (const phase of [0, BREATH_MS / 2]) {
      stage.at(AT + 71 + phase)
      const frame = await stage.screen(SCREEN)
      shades.push(fgAt(frame, frame.rowOf('▸ ● exec(sleep 9)'), 4) ?? '')
    }

    expect(new Set(shades).size).toBe(1) // 不呼吸

    // **读数照走**——减少动效停的是「亮度变化」，不是那个数
    stage.at(AT + 71 + 1_400)
    const later = await stage.screen(SCREEN)
    expect(later.textAt(later.rowOf('1.4s'))).toContain('1.4s')
  })
})

// ══ 三 · 纯函数那几件（亮度从哪儿来）══════════════════════════════════

describe('动效 · 纯函数（可重放）', () => {
  test('呼吸是**三角波**：两端最暗、中点最亮，且一轮正好 `BREATH_MS`', () => {
    expect(breathOf(0)).toBe(0)
    expect(breathOf(BREATH_MS / 2)).toBe(1)
    expect(breathOf(BREATH_MS)).toBe(0)
    // 负的「此刻」（钟回拨过）也走得通——取模那条不能漏
    expect(breathOf(-BREATH_MS / 2)).toBe(1)
  })

  test('脉冲**单调升、走完定住**（不闪烁、不回摆）', () => {
    expect(pulseOf(AT, AT)).toBe(0)
    expect(pulseOf(AT, AT + PULSE_MS / 2)).toBeGreaterThan(0)
    expect(pulseOf(AT, AT + PULSE_MS)).toBe(1)
    expect(pulseOf(AT, AT + PULSE_MS * 5)).toBe(1)
  })

  test('亮度 1 ＝**原色本身**（不是「差不多」——不然进行中与已完成在色上就对不齐）', () => {
    expect(breathColor('#98c379', 1)).toBe('#98c379')
    // 暗端仍在（「轻微」，不熄灭）
    expect(breathColor('#98c379', 0)).not.toBe('#000000')
  })
})
