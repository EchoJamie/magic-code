/**
 * U41 · **供应商与模型管理的终端交互**——`/model` 那一条线在外壳这一侧的判据。
 *
 * 出处：[[设计/模型与上下文]]·「用户如何接入、选择与管理」＋ [[设计/终端交互]]·「共用入口与状态」。
 *
 * ## 这个文件判什么（以及什么都不判）
 *
 * 判的是**按键 → 视图 ＋ 命令**（外壳那一半）：列表拿什么铺行、选定发的是哪两件、
 * 刷新动没动你的焦点与草稿、`esc` 到底动没动东西、窄窗与长列表下屏幕还成不成样子。
 * **不判**的事情同样写死在这儿——真终端上那几屏（列表长什么样、出站报文对不对、
 * 凭据有没有溜进记录）归**同名装置** `packages/app/scripts/frames-provider-models.ts`
 * （真 PTY ＋ 真 HTTP 夹具），夹具自己的行为归 `packages/app/test/frames-provider-models.test.ts`
 * （尺子先自证）。
 *
 * ## 换血之后（2026-09-23 · 接入内核公共契约 `bee68fa`）
 *
 * `model.catalog` 的载荷改形：**一行＝一条连接**（`ModelCatalogRow` 的 `model` 可以没有、
 * 多了 `cache` / `name` / `vendor` / `region`）, `current` 也可以缺席。列表的取材于是从
 * 「配置条目」换成「**连接 ＋ 各自缓存里的模型**」——这正是本项要拆掉的旧约束
 * （「每增加一个型号先增加一条配置」）。凡因这次改形而换锚的判据，都在那条下面写了
 * 「原锚 / 为何变 / 新锚」三条（`对表.md` 的规矩）。
 */

import { describe, expect, test } from 'bun:test'
import type { Command, ModelCatalogRow, ModelRef, ModelInfoRead } from '@magic/contracts'
import { HINT_PICKER } from '../src/view.ts'
import type { Dock } from '../src/view.ts'
import { dockHeightOf } from '../src/components/app.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'

/** 一条长得**在 46 列下会被截**的模型名——窄窗那两条判据靠它把「截断」与「折行」分开。 */
const LONG_MODEL = 'MiniMax-Text-01-with-a-very-long-suffix'
/** 被截掉的那一截（只在名字的**后半段**出现）——它上屏＝折行了，没上屏＝截断了。 */
const LONG_TAIL = 'long-suffix'

/** 一条连接的缓存读数（只给用得着的那几格）。 */
function cacheOf(options: {
  readonly models?: readonly (string | { readonly id: string; readonly name?: string; readonly chat?: boolean })[]
  readonly fetchedAt?: number
  readonly stale?: boolean
  readonly refreshing?: boolean
  readonly failure?: string
}): ModelInfoRead {
  const models = (options.models ?? []).map((one) =>
    typeof one === 'string'
      ? { id: one }
      : {
          id: one.id,
          ...(one.name === undefined ? {} : { name: one.name }),
          ...(one.chat === undefined ? {} : { capabilities: { chat: one.chat } }),
        },
  )

  return {
    ...(options.models === undefined
      ? {}
      : {
          snapshot: {
            provider: 'x',
            scope: 'minimax|cn',
            fetchedAt: options.fetchedAt ?? 1_700_000_000_000,
            models,
          },
        }),
    ...(options.stale === undefined ? {} : { stale: options.stale }),
    ...(options.refreshing === undefined ? {} : { refreshing: options.refreshing }),
    ...(options.failure === undefined ? {} : { failure: { at: 1_700_000_000_000, reason: options.failure } }),
  }
}

/** 一条连接（`model.catalog` 的一行）——默认那条只给 id。 */
function conn(
  provider: string,
  options: {
    readonly name?: string
    readonly model?: string
    readonly vendor?: string
    readonly cache?: ModelInfoRead
  } = {},
): ModelCatalogRow {
  return {
    provider,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.vendor === undefined ? {} : { vendor: options.vendor }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
  }
}

/** 打开 `/model` 那一屏：打字 → 回车 → 喂答复（真会话里答复是内核给的，用例里得有人代发）。 */
function open(stage: Stage, entries: readonly ModelCatalogRow[], current?: ModelRef): void {
  stage.type('/model')
  stage.press({ kind: 'enter' })
  stage.feed([event('model.catalog', { entries, ...(current === undefined ? {} : { current }) })])
}

/**
 * 发往内核的命令里**与模型这一摊有关的**那些。
 *
 * ⚠️ 为什么要滤一道：打 `/` 那一下外壳会顺手问一次**技能目录**（`askSkills`——输入行候选要它），
 * 于是命令流里总夹着一条 `skills.list`。它与本文件判的事无关，滤掉它判据才说得清
 * （不滤的话每条断言都要拖一个无关的尾巴，改天那条路一变就集体红）。
 */
const sent = (stage: Stage): readonly Command[] =>
  stage.commands().filter((one) => one.type.startsWith('model.') || one.type.startsWith('provider.'))

/** 此刻那一屏开着的是哪个抽屉（没开＝`undefined`）——**取一次**再收窄（分两次取不算收窄）。 */
function pickerOf(stage: Stage): Extract<Dock, { kind: 'picker' }>['picker'] | undefined {
  const dock = stage.shell.getView().dock

  return dock.kind === 'picker' ? dock.picker : undefined
}

// ══ 一 · 列表拿什么铺行（U41 改形后）═══════════════════════════════════

describe('① 行＝**模型**（主文案为模型名，副文案为连接名）', () => {
  // 设计 · 模型与上下文「选择模型」：「先展示已有缓存」「行主文案为模型名，
  // 副文案为供应商/连接名」「实际选择键是'连接 id ＋ 精确模型 id'」。

  test('缓存里的每个模型各占一行，副文案是那条连接', () => {
    const stage = createStage()
    open(stage, [
      conn('personal', { name: '个人号', model: 'MiniMax-M3', cache: cacheOf({ models: ['MiniMax-M3', 'MiniMax-Text-01'] }) }),
    ])

    const rows = pickerOf(stage)?.rows ?? []
    expect(rows.map((row) => row.label)).toEqual(['MiniMax-M3', 'MiniMax-Text-01'])
    expect(rows.every((row) => row.meta.includes('个人号'))).toBe(true)
  })

  test('**选择键是两件**（连接 ＋ 精确模型）——不是只有模型名', () => {
    // 由头：合法的两条连接可以有**同名**模型（不同区域 / 不同端点），只报模型名认不出是谁。
    const stage = createStage()
    open(stage, [
      conn('a', { model: 'deepseek-chat', cache: cacheOf({ models: ['deepseek-chat'] }) }),
      conn('b', { model: 'deepseek-chat', cache: cacheOf({ models: ['deepseek-chat'] }) }),
    ])

    expect(pickerOf(stage)?.rows.map((row) => row.pick)).toEqual([
      { provider: 'a', model: 'deepseek-chat' },
      { provider: 'b', model: 'deepseek-chat' },
    ])
  })

  test('**只列适用于对话的**；判据缺省是未知，未知照列（不冒充「不支持」）', () => {
    // 设计 · 列表取舍：「明确仅支持嵌入、音频等其它用途的条目不混入」——
    // 而 `capabilities.chat` 缺省是**未知**（三态），未知不许当成 false。
    const stage = createStage()
    open(stage, [
      conn('personal', {
        cache: cacheOf({ models: [{ id: 'embedding-1', chat: false }, { id: 'MiniMax-M3' }, { id: 'maybe-1' }] }),
      }),
    ])

    expect(pickerOf(stage)?.rows.map((row) => row.label)).toEqual(['MiniMax-M3', 'maybe-1'])
  })

  test('**已有选择照留**：不在最近一次列表里的那条仍列着，并标明这一事实', () => {
    // 设计：「模型不在最新列表时，已有选择仍明确保留并提示此事实」。
    const stage = createStage()
    open(stage, [
      conn('personal', { model: 'retired-model', cache: cacheOf({ models: ['MiniMax-M3'] }) }),
    ])

    const rows = pickerOf(stage)?.rows ?? []
    expect(rows.map((row) => row.label)).toEqual(['MiniMax-M3', 'retired-model'])
    expect(rows[1]?.meta).toContain('不在最近一次列表里')
  })

  test('显示名与 id 不同时把 id 一并报出来（送出去的是它）', () => {
    const stage = createStage()
    open(stage, [conn('personal', { cache: cacheOf({ models: [{ id: 'MiniMax-M3', name: 'M3 旗舰' }] }) })])

    const row = pickerOf(stage)?.rows[0]
    expect(row?.label).toBe('M3 旗舰')
    expect(row?.meta).toContain('MiniMax-M3')
  })

  test('一条模型都没有（还没取过）⇒ **不开抽屉**，说明落成记录区一行回执', () => {
    // 0 行的抽屉接管着输入却不给东西可点——打不了字、没得选，看着就是卡死（P0 那条）。
    const stage = createStage()
    open(stage, [conn('personal', { vendor: 'minimax' })])

    expect(stage.shell.getView().dock.kind).toBe('input')
    const receipt = stage.shell.getView().settled.filter((row) => row.kind === 'receipt')
    expect(receipt.map((row) => (row.kind === 'receipt' ? row.text : '')).join('\n')).toContain('还没取过模型')
  })
})

describe('②「正在用」那一格', () => {
  test('标在答复给的 `current` 上，并落在它那一行', () => {
    // **原锚**：`current` 取自 `view.status.model`（真跑过才有的那一格）。
    // **为何变**：契约给 `model.catalog` 加了 `current`（「此刻会走哪一条」）——
    //   它包含「换过但还没调用过」那种，那才是选择器该标的；外壳那一格只是「跑过谁」。
    // **新锚**：答复里的 `current`。
    const stage = createStage()
    open(
      stage,
      [conn('personal', { model: 'MiniMax-M3', cache: cacheOf({ models: ['MiniMax-M3', 'MiniMax-Text-01'] }) })],
      { provider: 'personal', model: 'MiniMax-Text-01' },
    )

    const picker = pickerOf(stage)
    expect(picker?.rows[1]?.current).toBe(true)
    expect(picker?.selected).toBe(1) // 开列表就落在当前那条上（不用手挪）
  })

  test('**没有 `current` 时一行都不标**——不许拿列表首项冒充当前', () => {
    // 设计明文：「还没选过模型时没有去向，报'先选模型'，不取列表第一项顶上」。
    const stage = createStage()
    open(stage, [conn('personal', { cache: cacheOf({ models: ['MiniMax-M3', 'MiniMax-Text-01'] }) })])

    expect(pickerOf(stage)?.rows.some((row) => row.current)).toBe(false)
    expect(pickerOf(stage)?.selected).toBe(0)
  })
})

// ══ 二 · 选定 ═════════════════════════════════════════════════════════

describe('③ 选定＝换模型，**不是发送**', () => {
  test('回车发的是**连接 ＋ 模型**两件，并把抽屉收起', () => {
    const stage = createStage()
    open(stage, [
      conn('personal', { cache: cacheOf({ models: ['MiniMax-M3', 'MiniMax-Text-01'] }) }),
    ])
    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' })

    expect(sent(stage)).toEqual([
      { type: 'model.list' },
      { type: 'model.switch', provider: 'personal', model: 'MiniMax-Text-01' },
    ])
    expect(stage.commands().some((one) => one.type === 'input.submit')).toBe(false)
    expect(stage.shell.getView().dock.kind).toBe('input')
  })

  test('回执由内核那一条 `model.switched` 给——外壳**不先报**成功', () => {
    const stage = createStage()
    open(stage, [conn('personal', { cache: cacheOf({ models: ['MiniMax-M3'] }) })])
    stage.press({ kind: 'enter' })

    const before = stage.shell.getView().settled.length
    stage.feed([event('model.switched', { ok: true, provider: 'personal', model: 'MiniMax-M3' })])

    expect(stage.shell.getView().settled.length).toBe(before + 1)
    expect(stage.shell.getView().status.model).toBe('MiniMax-M3')
  })
})

describe('④ 取消**不留痕迹**、不动任何东西', () => {
  test('`esc` 收起抽屉：没有回执、没有换模型命令、右位回常态', () => {
    const stage = createStage()
    open(stage, [conn('personal', { cache: cacheOf({ models: ['MiniMax-M3'] }) })])

    stage.press({ kind: 'escape' })

    expect(sent(stage)).toEqual([{ type: 'model.list' }]) // 只有那次读面——没有别的
    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(stage.shell.getView().settled.some((row) => row.kind === 'receipt')).toBe(false)
  })
})

// ══ 三 · 刷新 ═════════════════════════════════════════════════════════

describe('⑤ 刷新：只更新信息，**不动你的焦点与草稿**', () => {
  // 设计 · 模型与上下文：「刷新只更新信息，**不抢走列表当前焦点**、不清草稿、不写回默认」。

  const listed = (extra: readonly string[] = []): readonly ModelCatalogRow[] => [
    conn('personal', { name: '个人号', cache: cacheOf({ models: ['MiniMax-M3', ...extra] }) }),
  ]

  test('`/model refresh` 发的是刷新意图（不带连接＝当前那条）', () => {
    const stage = createStage()
    stage.type('/model refresh')
    stage.press({ kind: 'enter' })

    expect(sent(stage)).toEqual([{ type: 'model.refresh' }])
  })

  test('`/model refresh <连接>` 点名刷那一条', () => {
    const stage = createStage()
    stage.type('/model refresh backup')
    stage.press({ kind: 'enter' })

    expect(sent(stage)).toEqual([{ type: 'model.refresh', provider: 'backup' }])
  })

  test('刷新回来**就地重铺**：抽屉不关、右位仍是选择器键位', () => {
    const stage = createStage()
    open(stage, listed())
    expect(stage.shell.getView().dock.kind).toBe('picker')

    stage.feed([event('model.catalog', { entries: listed(['MiniMax-M4']) })])

    expect(stage.shell.getView().dock.kind).toBe('picker')
    expect(stage.shell.getView().status.hint).toBe(HINT_PICKER)
  })

  test('新增的那条**当场可选**，而**选中那条没被抢走**', () => {
    const stage = createStage()
    open(stage, listed(['MiniMax-Text-01']))
    stage.press({ kind: 'down' }) // 挪到第二条
    const before = pickerOf(stage)?.rows[1]?.pick

    // 刷新：新增一条排在中间——顺序变了，选中那条**按身份认回来**
    stage.feed([event('model.catalog', { entries: listed(['MiniMax-M4', 'MiniMax-Text-01']) })])

    const after = pickerOf(stage)
    expect(after?.rows.map((row) => row.label)).toEqual(['MiniMax-M3', 'MiniMax-M4', 'MiniMax-Text-01'])
    expect(after?.rows[after.selected]?.pick).toEqual(before) // 还是用户手上那一条
  })

  test('草稿一个字都没动（刷新的路上没有人碰它）', () => {
    const stage = createStage()
    // 先打一句话、发出去，再开列表——两条路的次序与真会话一致
    stage.type('看一眼')
    stage.press({ kind: 'enter' })
    stage.type('/model')
    stage.press({ kind: 'enter' })
    stage.feed([event('model.catalog', { entries: listed() })])
    stage.feed([event('model.catalog', { entries: listed(['MiniMax-M4']) })])

    expect(stage.shell.getView().draft).toBe('')
  })
})

// ══ 四 · 屏面（宽度与高度）═════════════════════════════════════════════

describe('⑥ 候选**每项一行**（设计 · 终端交互）', () => {
  const one = (model: string): readonly ModelCatalogRow[] => [
    conn('personal', { name: 'personal', cache: cacheOf({ models: [model] }) }),
  ]

  test('模型行挂着 `oneLine`——截断交给渲染层按列宽做，高度账照旧一条一行', () => {
    const stage = createStage()
    open(stage, one(LONG_MODEL))

    expect(pickerOf(stage)?.rows.every((row) => row.oneLine === true)).toBe(true)
  })

  test('窄窗（46 列）下**截断**：名字被裁、后面那截不上屏，行不折', async () => {
    const stage = createStage()
    open(stage, one(LONG_MODEL))

    const frame = await stage.screen({ columns: 46, rows: 24 })

    expect(frame.has(LONG_TAIL)).toBe(false)
    expect(frame.has('…')).toBe(true)
    expect(frame.has('personal')).toBe(true) // 连接名那半截先保住
  })

  test('**反例**：宽窗（100 列）下一个字都不截——上面那条不许把「截」变成无条件', async () => {
    // 对表：「修 A 要交 B 的反例」——窄窗那条修法最容易的过头是**宽窗也去截**
    // （U33 的技能行二轮退回的正是这一形）。故同一份行，宽窗下必须原样全出。
    const stage = createStage()
    open(stage, one(LONG_MODEL))

    const frame = await stage.screen({ columns: 100, rows: 30 })

    expect(frame.has(LONG_MODEL)).toBe(true)
  })
})

describe('⑦ 选择器**高度有界**（设计 · 终端交互：高度有界 · 焦点可见）', () => {
  // 这一组是**共用交互**（五扇抽屉都走这一处），由本单元「一个连接下可能列出几十个模型」
  // 逼出来的：原先候选是**照单全画**的——实测 30 条候选在 24 行终端上把记录区整个顶出去
  // （帧 40 行，记录区一行不剩）。补法与草稿那一片同一条路子（半屏 ＋ 焦点可见 ＋ 如实报数）。

  const many = [
    conn('personal', {
      name: 'personal',
      cache: cacheOf({ models: Array.from({ length: 30 }, (_unused, at) => `model-${at}`) }),
    }),
  ]

  test('账与屏**同源**：候选超过半屏时，画出来的交互区行数 ＝ `dockHeightOf` 数的那几行', async () => {
    // 账与屏分家＝矮终端上真光标高一行（U31 那一族的老病）。这一条在**几档高度**上各量一遍
    // ——半屏预算随窗口变，两处必须一起变。
    const stage = createStage()
    open(stage, many)
    const view = stage.shell.getView()

    for (const rows of [24, 18, 10]) {
      const frame = await stage.screen({ columns: 60, rows })

      // `frame.dock` 含**状态行**那一行；`dockHeightOf` 数的是交互区，不含它
      expect(frame.dock.length).toBe(dockHeightOf(view, 60, rows) + 1)
    }
  })

  test('**记录区还在**——候选不许把这一趟的上下文顶出屏幕', async () => {
    const stage = createStage()
    open(stage, many)

    const frame = await stage.screen({ columns: 60, rows: 24 })

    expect(frame.record.length).toBeGreaterThan(0)
  })

  test('折起来的那一头**如实报条数**（不装作画全了）', async () => {
    const stage = createStage()
    open(stage, many)

    const frame = await stage.screen({ columns: 60, rows: 24 })

    expect(frame.has('… 下面还有 19 条')).toBe(true) // 满窗 12 格 − 1 条提示 ⇒ 画 11 条、余 19
  })

  test('**焦点可见**：`↓` 挪出这一窗之后窗口跟着平移，选中那条仍在屏上', async () => {
    const stage = createStage()
    open(stage, many)
    for (let at = 0; at < 15; at += 1) stage.press({ kind: 'down' })

    const frame = await stage.screen({ columns: 60, rows: 24 })

    expect(frame.has('model-15')).toBe(true) // 选中那条（第 16 行）
    expect(frame.has('… 上面还有 6 条')).toBe(true) // 上头折起来的如实报
    expect(frame.has('model-0　')).toBe(false) // 折起来的那几条确实没画
  })

  test('**反例**：放得下就一条都不折——上面那条不许把提示变成无条件的', async () => {
    // 对表 · 修 A 要交 B 的反例：给长列表加折叠时，最容易的过头是**短列表也去折**
    // （白扔一格、还多一句「还有 0 条」那种废话）。
    const stage = createStage()
    open(stage, [conn('personal', { cache: cacheOf({ models: ['m-1', 'm-2'] }) })])

    const frame = await stage.screen({ columns: 60, rows: 24 })

    expect(frame.has('还有')).toBe(false)
    expect(frame.has('m-1')).toBe(true)
    expect(frame.has('m-2')).toBe(true)
  })

  test('分组头也占窗口的格子（`/session` 那一档：账与屏照旧一致）', async () => {
    // 分组头是**多出来的一行**——窗口按「项」算（行 ＋ 头 ＋ 提示），故它一并计入预算；
    // 不这么算的话，带分组的列表会正好多画一行（账少、屏多）。
    const stage = createStage()
    stage.type('/session')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('session.state', {
        active: 's-0',
        sessions: Array.from({ length: 20 }, (_unused, at) => ({
          id: `s-${at}`,
          title: `会话 ${at}`,
          at: 1_700_000_000_000 + at,
          workspace: at % 2 === 0 ? ['/w/a'] : ['/w/b'],
        })),
      }),
    ])
    const view = stage.shell.getView()

    for (const rows of [24, 14]) {
      const frame = await stage.screen({ columns: 60, rows })

      expect(frame.dock.length).toBe(dockHeightOf(view, 60, rows) + 1)
    }
  })
})

// ══ 五 · 边界：不认得的话、不动用户默认 ══════════════════════════════

describe('⑧ 认不出的用法**如实说一句**', () => {
  test('`/model <不认得的词>` 不猜、不当交代发出去——给一句认得的用法', () => {
    // **原锚**：`/model <词>` ＝ 直接换到那个**条目**（`model.switch { provider }`）。
    // **为何变**：列表的取材从「配置条目」换成了「模型」——同一个词现在既可能是连接
    //   也可能是模型，按字面猜一个再切过去，猜错就是「换到了另一个模型上」而用户以为
    //   只是敲了个名字。故直达**取消**，如实说一句。
    // **新锚**：一句回执（列出认得的用法），一个命令都不发。
    const stage = createStage()
    stage.type('/model personal')
    stage.press({ kind: 'enter' })

    expect(sent(stage)).toEqual([])
    expect(stage.shell.getView().settled.some((row) => row.kind === 'receipt')).toBe(true)
  })
})

describe('⑨ 换模型**不动用户默认**（两件事分开）', () => {
  test('选定只发那两条（读面 ＋ 切换）——没有「保存默认」那一类', () => {
    // 设计（模型与上下文 · 4）：选模型只改当前 Agent；保存默认是**另一次明确动作**。
    const stage = createStage()
    open(stage, [conn('personal', { cache: cacheOf({ models: ['MiniMax-M3'] }) })])
    stage.press({ kind: 'enter' })

    expect(sent(stage).map((one) => one.type)).toEqual(['model.list', 'model.switch'])
  })
})
