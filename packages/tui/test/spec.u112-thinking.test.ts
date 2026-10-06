/**
 * 规格即测试 · **思考那一行：动效 ＋ 计时**（U112 追加 · 2026-10-01 用户定，照参照面）。
 *
 * 它本来就只有一行。这一节钉那三件：
 *
 * ① **进行中**：`（思考 12s）`——计时挂上去，动效挂在那一行上；
 * ② **收梢 ⇒ 定住**（不再动），**计时留着**；
 * ③ **减少动效开着 ⇒ 动效停、计时照走**（**时间是事实不是动画**——用户原话）；
 * ④ **全文不丢**（进那一屏仍是整段铺开，展开那一支不动）。
 *
 * 另有一条钉**计时口径**：**只算那一段真的在流的时间**——思考 12 秒之后空等 48 秒才出正文，
 * 报的必须是 12s 而不是 60s。那是这一节最要紧的一条（把口头口径变成可复跑的判据）。
 *
 * ⚠️ 时间轴怎么摆：`event()` 里 `at = TEST_AT + id`，故**用 `id` 当刻度**
 * （`think(10, …)` 与 `think(12_010, …)` 之间正好 12 秒）。
 */

import { describe, expect, test } from 'bun:test'
import { BREATH_MS } from '../src/motion.ts'
import { hasRunningThinking } from '../src/view.ts'
import { event } from './events.ts'
import { createStage, showScreen } from './screen.ts'
import type { Frame } from './screen.ts'

const AT = 1_700_000_000_000
const SCREEN = { columns: 100, rows: 40 } as const

/** 一段思考增量——`id` 决定它的 `at`（见文件头那条注）。 */
const think = (id: number, text: string) => event('model.delta', { channel: 'thinking', text }, { id })

/** 那一行画出来的样子（折叠态——它本来就只有一行）。 */
function rowOf(frame: Frame): string {
  return frame.content.find((line) => line.text.includes('（思考'))?.text ?? '（没有那一行）'
}

/** 那一行**为首那段**吃的是什么色（动效看它——弱→亮→弱就是呼吸）。 */
function labelFg(frame: Frame): string | null {
  return frame.cellsOf(frame.rowOf('（思考'))[1]?.fg ?? null
}

describe('思考行 · 动效 ＋ 计时（U112 追加）', () => {
  test('① **进行中**：`（思考 12s）`——计时挂上去，且那一段**在动**（两个「此刻」两个亮度）', async () => {
    const stage = createStage()
    stage.feed([think(10, '先想一下。'), think(12_010, '再想一下。')])

    const shades: (string | null)[] = []
    for (const phase of [0, BREATH_MS / 2]) {
      stage.at(AT + 12_010 + phase)
      shades.push(labelFg(await stage.screen(SCREEN)))
    }

    expect(new Set(shades).size).toBe(2) // 在动
    expect(shades.every((one) => one !== null)).toBe(true) // 防空转：两个都是真色

    stage.at(AT + 12_010)
    // 计时＝最后一条减第一条（12_010 − 10），不是「从开机到现在」。
    // 折叠那一行是**一整行**（那几句增量首尾相接、中间没有换行 ⇒ 就一条显示行）
    expect(rowOf(await stage.screen(SCREEN))).toBe('（思考 12.0s）先想一下。再想一下。')
  })

  test('② **收梢 ⇒ 定住**（不再动），而**计时留着**（那是事实）', async () => {
    const stage = createStage()
    stage.feed([
      think(10, '先想一下。'),
      think(12_010, '想完了。'),
      event('model.delta', { channel: 'text', text: '我说。' }, { id: 12_011 }),
    ])

    const shades: (string | null)[] = []
    for (const phase of [0, BREATH_MS / 2]) {
      stage.at(AT + 30_000 + phase)
      shades.push(labelFg(await stage.screen(SCREEN)))
    }

    expect(new Set(shades).size).toBe(1) // 定住
    expect(shades[0]).toBe('#5a626f') // 而且就是 `faint` 原色（不是某个中间亮度）
    expect(rowOf(await stage.screen(SCREEN))).toContain('（思考 12.0s）')
  })

  /**
   * **计时口径：只算那一段真的在流的时间**——这一节最要紧的一条。
   *
   * 造一段「思考 12 秒 → 停 48 秒 → 才吐正文」：报出来的必须是 **12s**，不是 60s。
   */
  test('只算**真的在流**的那一段：思考 12s ＋ 之后空等 48s ⇒ 报 `12.0s`（不是 60s）', async () => {
    const stage = createStage()
    stage.feed([
      think(10, '先想一下。'),
      think(12_010, '想完了。'),
      // ↓ 隔了 48 秒才开口说正文（真实里就是模型吐完思考、停一会儿才出正文）
      event('model.delta', { channel: 'text', text: '我说。' }, { id: 60_010 }),
    ])
    stage.at(AT + 120_000)

    expect(rowOf(await stage.screen(SCREEN))).toBe('（思考 12.0s）先想一下。想完了。')
  })

  test('③ **减少动效**：动效停（两个「此刻」一个色）、而**计时照走**', async () => {
    const stage = createStage({ reducedMotion: true })
    stage.feed([think(10, '先想一下。'), think(12_010, '再想一下。')])

    const shades: (string | null)[] = []
    for (const phase of [0, BREATH_MS / 2]) {
      stage.at(AT + 12_010 + phase)
      shades.push(labelFg(await stage.screen(SCREEN)))
    }

    expect(new Set(shades).size).toBe(1) // 不动
    expect(shades[0]).toBe('#5a626f')

    // **计时照走**：同一个起点、更晚的「此刻」⇒ 数更大
    stage.at(AT + 12_010)
    expect(rowOf(await stage.screen(SCREEN))).toContain('12.0s')
    stage.at(AT + 15_010)
    expect(rowOf(await stage.screen(SCREEN))).toContain('15.0s')
  })

  test('**拿不到就不编**：没有钟（还在流）⇒ 只写「（思考）」，一个数都不冒出来', async () => {
    const stage = createStage()
    stage.feed([think(10, '先想一下。')])

    expect(rowOf(await stage.screen(SCREEN))).toBe('（思考）先想一下。')
  })

  test('④ **全文不丢**：进那一屏仍是整段铺开（展开那一支不动）', async () => {
    const stage = createStage()
    stage.feed([think(10, '第一行\n第二行\n第三行')])
    // ⚠️ **不给钟**（还在流时「此刻」不知道）⇒ 那一行只写「（思考）」、不报数
    stage.at(null)

    expect(rowOf(await stage.screen(SCREEN))).toBe('（思考）第一行')

    // 展开（U110 起在查看那一屏上）：整段都在、次序不变、一行不少。
    // ⚠️ 那一屏是**另一块**（有抬头与底栏），故量的是「这三行在它里面」而不是「它只有这三行」。
    const opened = await showScreen(stage.shell.getView())
    const texts = opened.content.map((line) => line.text)
    const at = texts.indexOf('（思考）第一行')

    expect(at).toBeGreaterThan(-1)
    expect(texts.slice(at, at + 3)).toEqual(['（思考）第一行', '第二行', '第三行'])
  })

  test('`hasRunningThinking` 只认**还在流**的（收梢之后不再要钟）', () => {
    const stage = createStage()
    stage.feed([think(10, '先想一下。')])
    expect(hasRunningThinking(stage.shell.getView())).toBe(true)

    stage.feed([event('model.delta', { channel: 'text', text: '我说。' }, { id: 20 })])
    expect(hasRunningThinking(stage.shell.getView())).toBe(false)
  })
})
