/**
 * 规格即测试 · **状态行可配**（U112）——入口走 `/config`，挑格 ＋ 顺序 ＋ 上色开关。
 *
 * 出处：设计 · 终端交互「状态行可配置：给一列可选项，不给脚本」（2026-10-01 用户定 · 参照 Codex）：
 * 一条**具名项**的清单——用户挑**哪几格、什么顺序**，另有一个**上色开关**；
 * **某项当时不可用就整格省掉**；**默认给一条**；**配置入口走既有 `/config`**；
 * ⛔ **不做**「跑一条命令、把会话 JSON 喂给它」那种。
 *
 * 这一层测**键位语义与视图**（不起 Ink）——那一屏画出来是什么样由 `spec.u112.test.ts`
 * 那一头（真终端）量。两半合起来才是完整的那一条。
 */

import { describe, expect, test } from 'bun:test'
import type { Command } from '@magic/contracts'
import type { PickerRow } from '../src/view.ts'
import { event } from './events.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'

const ROOT = '/home/echo/ns/proj'

/** 开 `/config` 那一屏（三份读数一次喂齐——与真内核同形）。 */
function openConfig(over: { readonly statusLine?: { cells: readonly string[]; color?: boolean } } = {}): Stage {
  const stage = createStage({
    dataDir: '/home/echo/.magic',
    home: '/home/echo',
    workspaceRoots: [ROOT],
    statusLine: over.statusLine as never,
  })
  stage.type('/config')
  stage.press({ kind: 'enter' })
  stage.feed([
    event('model.catalog', {
      entries: [{ provider: 'minimax', name: '个人版', cache: { snapshot: { provider: 'minimax', scope: 'fixture', fetchedAt: 1, models: [{ id: 'MiniMax-M3' }] } }, }],
      current: { alias: 'default' as const, provider: 'minimax', model: 'MiniMax-M3' },
    }),
    event('grants.catalog', {
      workspace: ROOT,
      grants: [],
      stale: [],
      decisions: { total: 0, uncovered: 0, vetoed: 0 },
      history: { total: 0, auto: 0, kernel: 0 },
    }),
    event('mcp.catalog', { servers: [] }),
  ])

  return stage
}

/** 这一屏此刻铺着的行。 */
function rowsOf(stage: Stage): readonly PickerRow[] {
  const dock = stage.shell.getView().dock

  return dock.kind === 'picker' ? dock.picker.rows : []
}

/** 这一屏此刻指着第几行。 */
function atOf(stage: Stage): number {
  const dock = stage.shell.getView().dock

  return dock.kind === 'picker' ? dock.picker.selected : -1
}

/** 走到某一格上并按下去（按名字找——不按序号写死）。 */
function enter(stage: Stage, name: string): void {
  const rows = rowsOf(stage)
  const at = rows.findIndex((row) => row.label.trim() === name)
  expect(at, `这一屏上没有「${name}」这一行`).toBeGreaterThan(-1)

  // 从当前焦点走（`down` 是环绕的，故先把差额算成「往下走几步」）
  while (atOf(stage) !== at) stage.press({ kind: 'down' })
  stage.press({ kind: 'enter' })
}

/** 这一次发出去的 `prefs.set`（没有就 `undefined`）。 */
function sent(stage: Stage): Extract<Command, { type: 'prefs.set' }> | undefined {
  return stage
    .commands()
    .filter((one): one is Extract<Command, { type: 'prefs.set' }> => one.type === 'prefs.set')
    .at(-1)
}

/** 此刻那两格在视图里的样子。 */
function prefsOf(stage: Stage): { readonly cells: readonly string[]; readonly color: boolean; readonly reduced: boolean } {
  const view = stage.shell.getView()

  return {
    cells: view.statusLine?.cells ?? [],
    color: view.statusLine?.color !== false,
    reduced: view.reducedMotion,
  }
}

describe('状态行可配 · 入口走 /config（U112）', () => {
  test('`/config` 里多两行：「状态行」与「减少动效」——没配过时那一行**明写「默认」**', () => {
    const stage = openConfig()

    expect(rowsOf(stage).map((row) => row.label.trim())).toEqual([
      '模型与连接',
      '本工作区授权',
      '外部工具',
      '状态行',
      '减少动效',
      '数据目录与工作区根',
    ])
    // **明写「默认」**：「你没配」与「你配的正好等于默认」在这一格上分得开
    expect(rowsOf(stage).find((row) => row.label.trim() === '状态行')?.meta).toBe('默认 · 会话名 · 上下文占用')
    expect(rowsOf(stage).find((row) => row.label.trim() === '减少动效')?.meta).toBe('已关')
  })

  test('选定「状态行」⇒ 进它自己那一屏：五格 ＋ 上色开关；**锚不在这张表里**', () => {
    const stage = openConfig()
    enter(stage, '状态行')

    const rows = rowsOf(stage)

    expect(rows.map((row) => row.label.trim())).toEqual(['会话名', '模型', '思考档', '上下文占用', '工作区', '颜色'])
    // **锚那两格不在这一屏**（运行状态 · 全放行）——挑不了的东西摆进可选项清单就是骗人
    expect(rows.some((row) => row.label.includes('工作中'))).toBe(false)
    expect(rows.some((row) => row.label.includes('全放行'))).toBe(false)
    // 默认那条在屏上标着「已放上 · 第 N 格」（顺序＝挑的先后）
    expect(rows.find((row) => row.label.trim() === '会话名')?.meta).toBe('已放上 · 第 1 格')
    expect(rows.find((row) => row.label.trim() === '上下文占用')?.meta).toBe('已放上 · 第 2 格')
    expect(rows.find((row) => row.label.trim() === '模型')?.meta).toBe('未放上')
  })

  test('回车＝放上／拿下；**顺序＝放上的先后**；每一次都发一条 `prefs.set`', () => {
    const stage = openConfig()
    enter(stage, '状态行')

    enter(stage, '工作区')
    expect(sent(stage)?.statusLine?.cells).toEqual(['session', 'context', 'workspace'])
    expect(rowsOf(stage).find((row) => row.label.trim() === '工作区')?.meta).toBe('已放上 · 第 3 格')

    enter(stage, '上下文占用')
    expect(sent(stage)?.statusLine?.cells).toEqual(['session', 'workspace'])
    // 拿掉一格 ⇒ 后面那几格**跟着前移**
    expect(rowsOf(stage).find((row) => row.label.trim() === '工作区')?.meta).toBe('已放上 · 第 2 格')
    // **抽屉不关**（连勾几格是常态）
    expect(stage.shell.getView().dock.kind).toBe('picker')
  })

  test('**上色开关**（末行常驻）：回车即切，发的是 `color` 那一位', () => {
    const stage = openConfig()
    enter(stage, '状态行')

    enter(stage, '颜色')

    expect(sent(stage)?.statusLine?.color).toBe(false)
    expect(rowsOf(stage).find((row) => row.label.trim() === '颜色')?.meta).toBe('已关')
  })

  test('「减少动效」那一行：回车**即切**（不另开一屏），发的是 `reducedMotion`', () => {
    const stage = openConfig()
    enter(stage, '减少动效')

    expect(sent(stage)?.reducedMotion).toBe(true)
    expect(prefsOf(stage).reduced).toBe(true)
    // 那一行当场跟着换（还留在 `/config` 这一屏上）
    expect(rowsOf(stage).find((row) => row.label.trim() === '减少动效')?.meta).toBe('已开')
  })

  /**
   * **回话是权威的**——写不成时把屏上那两格**摆回真的样子**（不是把用户刚点的当成成了），
   * 并留一行回执。这是那一趟写盘唯一看得见的地方：静默吞掉是最难查的那一形。
   */
  test('`prefs.state` 回来 ⇒ **以回话为准**落定那两格 ＋ 落一行回执', () => {
    const stage = openConfig()
    enter(stage, '减少动效')

    // 内核说：没写成（配置文件被外面改过那类），此刻盘上那两格是「什么都没配」
    stage.feed([event('prefs.state', { reducedMotion: false, note: '动效没改成——配置文件在这一趟之后被改过' })])

    expect(prefsOf(stage).reduced).toBe(false) // 摆回真的样子（用户点的是「开」）
    expect(rowsOf(stage).find((row) => row.label.trim() === '减少动效')?.meta).toBe('已关')
    expect(stage.shell.getView().settled.at(-1)).toMatchObject({ kind: 'receipt' })
  })

  test('配过之后再开 `/config`：那一行报的是**配的那一份**（不再写「默认」）', () => {
    const stage = openConfig({ statusLine: { cells: ['model', 'session'] } })

    expect(rowsOf(stage).find((row) => row.label.trim() === '状态行')?.meta).toBe('模型 · 会话名')
  })

  /**
   * **顺序就是让位的次序**（那一屏上排在前面的先保）——配一条把「模型」摆在「会话名」前面
   * 的，窄窗里先掉的就该是「会话名」。这一条把「顺序」这件事从**配置**一路钉到**降级**上。
   */
  test('配出来的顺序＝**让位的次序**：排在前面的先保（窄窗先掉后面那一格）', async () => {
    const stage = createStage({ statusLine: { cells: ['model', 'session'] }, workspaceRoots: [ROOT] })
    stage.feed([
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '改时区' }] }),
      event('model.call.start', { alias: 'default', model: 'MiniMax-M3', provider: 'minimax' }, { id: 50 }),
    ])

    // 宽窗：两格都在，且**按配的顺序**（模型在前、会话名在后）
    const wide = await stage.screen({ columns: 100, rows: 20 })
    expect(wide.statusLine.indexOf('Default')).toBeLessThan(wide.statusLine.indexOf('改时区'))

    // 窄窗：排在前面的「模型」保住，排在后面的「会话名」先让位
    const narrow = await stage.screen({ columns: 30, rows: 20 })
    expect(narrow.statusLine).toContain('Default')
    expect(narrow.statusLine).not.toContain('改时区')
  })
})
