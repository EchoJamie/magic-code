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
import type { Dock, PickerRow } from '../src/view.ts'
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
  readonly models?: readonly (
    | string
    | {
        readonly id: string
        readonly name?: string
        readonly chat?: boolean
        readonly limits?: { readonly maxInputTokens?: number; readonly maxContextTokens?: number }
        readonly reasoning?: { readonly levels?: readonly string[]; readonly disable?: boolean }
      }
  )[]
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
          ...(one.limits === undefined ? {} : { limits: one.limits }),
          ...(one.reasoning === undefined ? {} : { reasoning: one.reasoning }),
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

/**
 * 此刻那一屏里的**模型行**（`pick` 有值的那几行）。
 *
 * 由头（U41 返修）：列表末尾常驻着几条**入口行**（连接供应商 / 管理连接 / 刷新模型），
 * 它们与模型行同列，但不是「有哪些模型可挑」的一部分——凡「列表里列了哪些模型」的判据
 * 都从这儿取，免得每加一条入口就要改一遍断言。
 */
function modelOnly(stage: Stage): readonly PickerRow[] {
  return (pickerOf(stage)?.rows ?? []).filter((row) => row.pick !== undefined)
}

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

    // **只看模型行**（`pick` 有值的那几行）——列表末尾还有几行**入口**（U41 返修加的），
    // 它们不是「模型」，判据不该被它们带着走（`filter` 一处收口，下面几条同理）
    const rows = modelOnly(stage)
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

    expect(modelOnly(stage).map((row) => row.label)).toEqual(['MiniMax-M3', 'maybe-1'])
  })

  test('**已有选择照留**：不在最近一次列表里的那条仍列着，并标明这一事实', () => {
    // 设计：「模型不在最新列表时，已有选择仍明确保留并提示此事实」。
    const stage = createStage()
    open(stage, [
      conn('personal', { model: 'retired-model', cache: cacheOf({ models: ['MiniMax-M3'] }) }),
    ])

    const rows = modelOnly(stage)
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

  test('一条模型都没有时**照开抽屉**，并给一条能按下去的接入入口', () => {
    // **原锚**：0 行 ⇒ 不开抽屉，说明落成记录区一行回执（那时列表只有「模型行」，
    //   一条模型都没有＝没有任何可点的东西）。
    // **为何变**（U41 返修 · 首验退回那一处）：一条连接都没有时，那一屏**收回普通输入区**，
    //   用户手上没有任何可操作的东西——「从头接一条」这条路就断了（「空态也可用」）。
    // **新锚**：末尾常驻的**入口行**让空态也有东西可点，故照开；说明照旧给（指到那一行）。
    const stage = createStage()
    open(stage, [])

    expect(stage.shell.getView().dock.kind).toBe('picker')
    const rows = pickerOf(stage)?.rows ?? []
    expect(rows.some((row) => /连接|接入/.test(row.label))).toBe(true)
    expect(pickerOf(stage)?.hint).toContain('还没有接上任何供应商')
  })

  test('一条连接、但**还没取过模型**：模型行照列（连接默认），入口行也在', () => {
    const stage = createStage()
    open(stage, [conn('personal', { vendor: 'minimax', model: 'MiniMax-M3' })])

    expect(modelOnly(stage).map((row) => row.label)).toEqual(['MiniMax-M3'])
    expect(pickerOf(stage)?.rows.some((row) => row.label === '连接供应商')).toBe(true)
  })

  test('一条连接都没有时，**管理与刷新不出**（无事可做的那两行不占地方）', () => {
    const stage = createStage()
    open(stage, [])

    const labels = (pickerOf(stage)?.rows ?? []).map((row) => row.label)
    expect(labels).toEqual(['连接供应商'])
  })

  test('三个入口行**常驻**：几十条模型折起来也在（不会被折到看不见）', async () => {
    const stage = createStage()
    open(stage, [
      conn('personal', { cache: cacheOf({ models: Array.from({ length: 30 }, (_u, at) => `m-${at}`) }) }),
    ])

    const frame = await stage.screen({ columns: 60, rows: 24 })

    expect(frame.has('连接供应商')).toBe(true)
    expect(frame.has('管理连接')).toBe(true)
    expect(frame.has('刷新模型')).toBe(true)
    expect(frame.has('… 下面还有')).toBe(true) // 候选那一头确实折了
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
    expect(
      (after?.rows ?? []).filter((row) => row.pick !== undefined).map((row) => row.label),
    ).toEqual(['MiniMax-M3', 'MiniMax-M4', 'MiniMax-Text-01'])
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

// ══ 四 · 接入与维护（连接供应商 / 管理连接）═══════════════════════════

describe('⑩ 接入：挑一家 → 输密钥（隐藏）→ 保存', () => {
  // 设计 · 模型与上下文「首次接入」：「选择供应商及官方区域，认证使用**独立的隐藏输入**
  // 或既有环境变量引用，**不经对话输入、工具参数或历史**」；「确认后保存连接并获取列表」。

  /**
   * 内置供应商与官方区域——**测试里喂的那一份**（生产路径上这一格来自调用线的查询出口）。
   *
   * ⚠️ 那一笔（`3cce99c`）**落不到本分支**（依赖它更早的 `vendors.ts` 与装配接线），
   * 故本分支的契约类型里还没有 `provider.catalog.vendors` 这一格——测试里按已定的字段
   * 喂进去（下面那个 `as` 是**临时**的：接口那笔一落就撤）。见返修回报。
   */
  const VENDORS = [
    {
      vendor: 'minimax',
      label: 'MiniMax',
      regions: [
        { id: 'cn', label: '中国大陆', baseURL: 'https://api.minimaxi.com/v1' },
        { id: 'global', label: '国际', baseURL: 'https://api.minimax.chat/v1' },
      ],
    },
    {
      vendor: 'deepseek',
      label: 'DeepSeek',
      regions: [{ id: 'official', label: '官方', baseURL: 'https://api.deepseek.com' }],
    },
  ]

  /** 喂一条 `provider.catalog`（连接一览 ＋ 内置供应商名单）。 */
  function feedProviders(
    stage: Stage,
    entries: readonly ModelCatalogRow[] = [],
    vendors: readonly unknown[] = VENDORS,
  ): void {
    // ⚠️ 「没有那一格」要传**空数组**，别传 `undefined`：JS 的默认参数会被 `undefined` 触发，
    //    那样又喂回 `VENDORS` 了（本条改之前正是这么栽的——`dock.kind` 忽然变成 `picker`）
    const data = { entries, vendors } as unknown as Parameters<typeof event<'provider.catalog'>>[1]

    stage.feed([event('provider.catalog', data)])
  }

  /** 走到「密钥那一屏」为止（挑一家 ＋（有得选时）挑区域都走完）。 */
  function atKeyPrompt(stage: Stage, existing: readonly ModelCatalogRow[] = []): void {
    stage.type('/model connect')
    stage.press({ kind: 'enter' })
    feedProviders(stage, existing)
    stage.press({ kind: 'enter' }) // 选定第一家（MiniMax）
    stage.press({ kind: 'enter' }) // 它有区域可选 ⇒ 再选定缺省那个（中国大陆）
  }

  const promptOf = (stage: Stage): { readonly label: string; readonly display: string } | undefined => {
    const dock = stage.shell.getView().dock

    return dock.kind === 'prompt' ? dock.prompt : undefined
  }

  test('`/model connect` 先问一次连接一览（要拿它算一个空的连接 id）', () => {
    const stage = createStage()
    stage.type('/model connect')
    stage.press({ kind: 'enter' })

    expect(sent(stage)).toEqual([{ type: 'provider.list' }])
  })

  test('一览回来才开「挑一家」那一屏——**名单来自答复那一格**（壳里不留一份）', () => {
    const stage = createStage()
    stage.type('/model connect')
    stage.press({ kind: 'enter' })
    feedProviders(stage, [])

    expect(pickerOf(stage)?.source).toBe('vendor')
    expect(pickerOf(stage)?.rows.map((row) => row.value)).toEqual(['minimax', 'deepseek'])
    expect(pickerOf(stage)?.rows.map((row) => row.label)).toEqual(['MiniMax', 'DeepSeek'])
  })

  test('答复里**没有那一格**时如实说一句，不拿壳里的常量顶上', () => {
    // 0 行的抽屉接管着输入却不给东西可点（死胡同）——`openPicker` 把说明落成一行回执。
    const stage = createStage()
    stage.type('/model connect')
    stage.press({ kind: 'enter' })
    feedProviders(stage, [], [])

    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(stage.shell.getView().settled.some((row) => row.kind === 'receipt')).toBe(true)
  })

  test('一家**有多个区域**⇒ 中间多一屏「挑区域」（区域名 ＋ 官方地址）', () => {
    const stage = createStage()
    stage.type('/model connect')
    stage.press({ kind: 'enter' })
    feedProviders(stage, [])
    stage.press({ kind: 'enter' }) // MiniMax（两个区域）

    expect(pickerOf(stage)?.source).toBe('region')
    expect(pickerOf(stage)?.rows.map((row) => row.label)).toEqual(['中国大陆', '国际'])
    expect(pickerOf(stage)?.rows[0]?.meta).toBe('https://api.minimaxi.com/v1')
  })

  test('**一家只有一个区域**就不问那一步**也不写 region**（约定：不写＝用缺省那项）', () => {
    const stage = createStage()
    stage.type('/model connect')
    stage.press({ kind: 'enter' })
    feedProviders(stage, [])
    stage.press({ kind: 'down' }) // 第二家：DeepSeek（只有一个区域）
    stage.press({ kind: 'enter' })

    expect(stage.shell.getView().dock.kind).toBe('prompt') // 直接到密钥那一屏
    stage.type('sk-x')
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({
      type: 'provider.save',
      provider: 'deepseek',
      vendor: 'deepseek',
      apiKey: 'sk-x',
    })
  })

  test('选了区域 ⇒ 保存时连着区域一起写（`providers.<id>.region`）', () => {
    const stage = createStage()
    stage.type('/model connect')
    stage.press({ kind: 'enter' })
    feedProviders(stage, [])
    stage.press({ kind: 'enter' }) // MiniMax
    stage.press({ kind: 'down' }) // 国际
    stage.press({ kind: 'enter' })
    stage.type('sk-x')
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({
      type: 'provider.save',
      provider: 'minimax',
      vendor: 'minimax',
      region: 'global',
      apiKey: 'sk-x',
    })
  })

  test('选定一家 ⇒ 开**密钥那一屏**：标签说明不回显，屏上只有圆点', () => {
    const stage = createStage()
    atKeyPrompt(stage)

    const prompt = promptOf(stage)
    expect(prompt?.label).toContain('不回显')

    stage.type('sk-secret-1234')
    // **一个真字符都不上屏**——屏上那一串是圆点
    expect(promptOf(stage)?.display).toBe('•'.repeat('sk-secret-1234'.length))
    expect(JSON.stringify(stage.shell.getView())).not.toContain('sk-secret-1234')
  })

  test('回车 ⇒ 保存这条连接（供应商 ＋ 那串凭据），抽屉收起', () => {
    const stage = createStage()
    atKeyPrompt(stage)
    stage.type('sk-abc')
    stage.press({ kind: 'enter' })

    expect(sent(stage)).toEqual([
      { type: 'provider.list' },
      // MiniMax 有区域可选 ⇒ 缺省那个（中国大陆）随这条连接一起写下来
      { type: 'provider.save', provider: 'minimax', vendor: 'minimax', region: 'cn', apiKey: 'sk-abc' },
    ])
    expect(stage.shell.getView().dock.kind).toBe('input')
  })

  test('**留空 ＝ 走环境变量**（不往配置里写凭据）——那一条不带 `apiKey`', () => {
    // 设计：「认证使用独立的隐藏输入**或既有环境变量引用**」。
    const stage = createStage()
    atKeyPrompt(stage)
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({
      type: 'provider.save',
      provider: 'minimax',
      vendor: 'minimax',
      region: 'cn',
    })
  })

  test('**id 撞了就加序号**——同一个 id 再存一次是「改那一条」，不是新建', () => {
    const stage = createStage()
    atKeyPrompt(stage, [conn('minimax', { vendor: 'minimax' })])
    stage.type('sk-abc')
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({
      type: 'provider.save',
      provider: 'minimax-2',
      vendor: 'minimax',
      region: 'cn',
      apiKey: 'sk-abc',
    })
  })

  test('`esc` 取消：不发任何命令、不留痕迹（那串凭据就此作废）', () => {
    const stage = createStage()
    atKeyPrompt(stage)
    stage.type('sk-abc')

    stage.press({ kind: 'escape' })

    expect(sent(stage)).toEqual([{ type: 'provider.list' }])
    expect(stage.shell.getView().dock.kind).toBe('input')
    expect(stage.shell.getView().settled.some((row) => row.kind === 'receipt')).toBe(false)
  })

  test('保存的回话到了 ⇒ 留一行回执（有话说时）**并接着取一次模型列表**', () => {
    // 设计：「确认后保存连接并获取列表」。
    const stage = createStage()
    atKeyPrompt(stage)
    stage.type('sk-abc')
    stage.press({ kind: 'enter' })
    const before = sent(stage).length

    stage.feed([event('provider.catalog', { entries: [], note: '接上了' } as never)])

    expect(sent(stage).slice(before)).toEqual([{ type: 'model.list' }])
    const receipts = stage.shell.getView().settled.filter((row) => row.kind === 'receipt')
    expect(receipts.some((row) => row.kind === 'receipt' && row.text.includes('接上了'))).toBe(true)
  })

  test('凭据**不进输入历史**（`↑` 翻不出它来）', () => {
    const stage = createStage()
    atKeyPrompt(stage)
    stage.type('sk-abc')
    stage.press({ kind: 'escape' })
    stage.type('普通一句')

    stage.press({ kind: 'up' }) // 翻历史

    expect(stage.shell.getView().draft).not.toContain('sk-abc')
  })
})

describe('⑪ 管理：改名 / 更新认证 / 刷新 / 移除', () => {
  const connected = [
    conn('personal', { name: '个人号', vendor: 'minimax', model: 'MiniMax-M3', cache: cacheOf({ models: ['MiniMax-M3'] }) }),
  ]

  /** 走到某一条连接的**管理明细**那一屏。 */
  function atDetail(stage: Stage): void {
    stage.type('/model manage')
    stage.press({ kind: 'enter' })
    stage.feed([event('provider.catalog', { entries: connected })])
    stage.press({ kind: 'enter' }) // 进这一条
  }

  test('`/model manage` 先问一次连接一览，答复到了开一览那一屏', () => {
    const stage = createStage()
    stage.type('/model manage')
    stage.press({ kind: 'enter' })

    expect(sent(stage)).toEqual([{ type: 'provider.list' }])
    stage.feed([event('provider.catalog', { entries: connected })])

    expect(pickerOf(stage)?.source).toBe('provider')
    expect(pickerOf(stage)?.rows.map((row) => row.label)).toEqual(['个人号'])
    // 副文案说清**是什么供应商、认证从哪儿来**（不含糊说「已设置」）
    expect(pickerOf(stage)?.rows[0]?.meta).toContain('minimax')
    expect(pickerOf(stage)?.rows[0]?.meta).toContain('认证')
  })

  test('进明细那一屏：四件动作都在，连接自己的几格写在说明里', () => {
    const stage = createStage()
    atDetail(stage)

    expect(pickerOf(stage)?.source).toBe('provider-detail')
    expect(pickerOf(stage)?.rows.map((row) => row.value)).toEqual(['rename', 'key', 'refresh', 'remove'])
    expect(pickerOf(stage)?.hint).toContain('连接 personal')
  })

  test('改名 ⇒ 开输入屏（现名预填），回车发 `provider.save { name }`', () => {
    const stage = createStage()
    atDetail(stage)
    stage.press({ kind: 'enter' }) // 第一行＝改名

    const dock = stage.shell.getView().dock
    expect(dock.kind).toBe('prompt')
    expect(dock.kind === 'prompt' ? dock.prompt.display : '').toBe('个人号') // 预填现名

    // 改成「我的号」：先把现名删掉
    for (let at = 0; at < 3; at += 1) stage.press({ kind: 'backspace' })
    stage.type('我的号')
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({ type: 'provider.save', provider: 'personal', name: '我的号' })
  })

  test('更新认证 ⇒ 密钥屏（隐藏），回车把新密钥发出去', () => {
    const stage = createStage()
    atDetail(stage)
    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' }) // 第二行＝更新认证

    const dock = stage.shell.getView().dock
    expect(dock.kind === 'prompt' ? dock.prompt.label : '').toContain('不回显')

    stage.type('sk-new')
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({ type: 'provider.save', provider: 'personal', apiKey: 'sk-new' })
  })

  test('刷新这一条 ⇒ 点名刷那条连接', () => {
    const stage = createStage()
    atDetail(stage)
    stage.press({ kind: 'down' })
    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({ type: 'model.refresh', provider: 'personal' })
  })

  test('移除 ⇒ 发移除命令（引用检查归内核，拒绝时由回话说明）', () => {
    const stage = createStage()
    atDetail(stage)
    for (let at = 0; at < 3; at += 1) stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({ type: 'provider.remove', provider: 'personal' })
  })

  test('移除之后的回话到了：留一行回执，而**那一屏退回一览**（明细说的那条没了）', () => {
    const stage = createStage()
    atDetail(stage)
    for (let at = 0; at < 3; at += 1) stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' })

    stage.feed([event('provider.catalog', { entries: [], note: '已移除 personal' })])

    // **退回输入行**（不是一张空的一览）：明细的主语没了，这一屏就立不住；
    // 而空一览是「0 行接管着输入」那号死胡同（`openPicker` 的 P0）
    expect(stage.shell.getView().dock.kind).toBe('input')
    const receipts = stage.shell.getView().settled.filter((row) => row.kind === 'receipt')
    expect(receipts.some((row) => row.kind === 'receipt' && row.text.includes('已移除'))).toBe(true)
  })
})

// ══ 四 · `/model` 内那三条入口行（U41 返修）═════════════════════════════

describe('⑬ 入口行：在这一屏里就能连 / 管 / 刷（不必另打命令）', () => {
  /** 把选中挪到某一条入口行上（按标签找——不按下标写死，免得行序一变就错位）。 */
  function toAction(stage: Stage, label: string): void {
    const rows = pickerOf(stage)?.rows ?? []
    const at = rows.findIndex((row) => row.label === label)
    if (at === -1) throw new Error(`列表里没有「${label}」这一行`)

    for (let step = 0; step < at; step += 1) stage.press({ kind: 'down' })
  }

  const listed = [
    conn('personal', {
      name: '个人号',
      model: 'MiniMax-M3',
      cache: cacheOf({ models: ['MiniMax-M3'] }),
    }),
  ]

  test('「连接供应商」⇒ 走接入第一步（问一次连接一览）', () => {
    const stage = createStage()
    open(stage, listed)
    toAction(stage, '连接供应商')
    stage.press({ kind: 'enter' })

    expect(sent(stage)).toEqual([
      { type: 'model.list' },
      { type: 'provider.list' },
    ])
  })

  test('「管理连接」⇒ 走管理第一步（同一份读面）', () => {
    const stage = createStage()
    open(stage, listed)
    toAction(stage, '管理连接')
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({ type: 'provider.list' })
  })

  test('「刷新模型」⇒ 发刷新意图（缺省＝刷当前那条连接）', () => {
    const stage = createStage()
    open(stage, listed, { provider: 'personal', model: 'MiniMax-M3' })
    toAction(stage, '刷新模型')
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({ type: 'model.refresh' })
  })

  test('**空态**下那一条入口照样按得下去（接入第一步）', () => {
    const stage = createStage()
    open(stage, [])
    stage.press({ kind: 'enter' }) // 空态只有这一行，且它就在选中位上

    expect(sent(stage).at(-1)).toEqual({ type: 'provider.list' })
  })

  test('按入口行**不是**换模型（不发 `model.switch`）', () => {
    const stage = createStage()
    open(stage, listed)
    toAction(stage, '刷新模型')
    stage.press({ kind: 'enter' })

    expect(sent(stage).some((one) => one.type === 'model.switch')).toBe(false)
  })
})

// ══ 五 · 详情 / 思考设置 / 设为默认 ═══════════════════════════════════

describe('⑫ 详情：`→` 进这一条，看规格、改思考、设为默认', () => {
  const rich = [
    conn('personal', {
      name: '个人号',
      model: 'MiniMax-M3',
      cache: cacheOf({
        fetchedAt: 1_700_000_000_000,
        models: [
          {
            id: 'MiniMax-M3',
            limits: { maxInputTokens: 1_000_000, maxContextTokens: 200_000 },
            reasoning: { levels: ['low', 'high'], disable: true },
          },
          { id: 'MiniMax-Text-01' },
        ],
      }),
    }),
  ]

  /**
   * 开列表 → 挪到第 `at` 条 → 按 `→` 进**那一条**的详情。
   *
   * ⚠️ 「挪」必须在**列表那一屏**上做：进了详情之后上下是在详情的两条动作里挪
   * （第一版就是这么写错的——挪完再按 `→`，人已经在详情里了）。
   */
  function atDetail(stage: Stage, at = 0, entries = rich): void {
    open(stage, entries)
    for (let step = 0; step < at; step += 1) stage.press({ kind: 'down' })
    stage.press({ kind: 'right' })
  }

  test('`→` 进详情那一屏：两条动作在，资料写在下方说明里', () => {
    const stage = createStage()
    atDetail(stage)

    expect(pickerOf(stage)?.source).toBe('model-detail')
    expect(pickerOf(stage)?.rows.map((row) => row.value)).toEqual(['reasoning', 'default'])
    const hint = pickerOf(stage)?.hint ?? ''
    expect(hint).toContain('规格：')
    expect(hint).toContain('缓存：')
  })

  test('规格**手上有才报**（供应商没给就如实说没给）', () => {
    const stage = createStage()
    atDetail(stage, 1) // 第二条（那条没有 limits）

    expect(pickerOf(stage)?.hint).toContain('规格：供应商没给')
  })

  test('思考那一屏的**行由能力描述长出来**：模型默认 ＋ 明确关闭 ＋ 两个档位', () => {
    const stage = createStage()
    atDetail(stage)
    stage.press({ kind: 'enter' }) // 第一行＝思考设置

    expect(pickerOf(stage)?.source).toBe('model-reasoning')
    expect(pickerOf(stage)?.rows.map((row) => row.label)).toEqual(['模型默认', '明确关闭', 'low', 'high'])
    expect(pickerOf(stage)?.rows[0]?.current).toBe(true) // 没设过＝模型默认
  })

  test('没声明思考能力 ⇒ **只有「模型默认」**，说明如实说（不编档位）', () => {
    const stage = createStage()
    atDetail(stage, 1) // 第二条：没有 reasoning 声明
    stage.press({ kind: 'enter' })

    expect(pickerOf(stage)?.rows.map((row) => row.label)).toEqual(['模型默认'])
    expect(pickerOf(stage)?.hint).toContain('没有声明思考档位')
  })

  test('选定一个档位 ⇒ `model.switch` 带上它（思考随同验证）', () => {
    const stage = createStage()
    atDetail(stage)
    stage.press({ kind: 'enter' })
    stage.press({ kind: 'down' })
    stage.press({ kind: 'down' }) // 「low」
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({
      type: 'model.switch',
      provider: 'personal',
      model: 'MiniMax-M3',
      reasoning: { mode: 'level', level: 'low' },
    })
  })

  test('设为默认 ⇒ `model.default.set`（没选过思考设置就**不带**那一位）', () => {
    // 设计：换当前模型与保存默认**分开**；默认那一笔不替用户编思考设置（缺省＝模型默认）。
    const stage = createStage()
    atDetail(stage)
    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' })

    expect(sent(stage).at(-1)).toEqual({
      type: 'model.default.set',
      provider: 'personal',
      model: 'MiniMax-M3',
    })
  })

  test('选过思考设置之后设为默认 ⇒ 把它一并存下来', () => {
    const stage = createStage()
    atDetail(stage)
    stage.press({ kind: 'enter' }) // 思考设置
    stage.press({ kind: 'down' })
    stage.press({ kind: 'down' })
    stage.press({ kind: 'down' }) // 「high」
    stage.press({ kind: 'enter' })

    atDetail(stage) // 回列表再进详情
    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' }) // 设为默认

    expect(sent(stage).at(-1)).toEqual({
      type: 'model.default.set',
      provider: 'personal',
      model: 'MiniMax-M3',
      reasoning: { mode: 'level', level: 'high' },
    })
  })

  test('**换了模型就不带过去**——思考设置按「连接 ＋ 模型」那一对记着', () => {
    // 设计：「组合改变而未显式指定思考设置时取目标模型默认，**不把原模型的档位或预算
    // 盲目带过去**」。
    const stage = createStage()
    atDetail(stage)
    stage.press({ kind: 'enter' })
    stage.press({ kind: 'down' })
    stage.press({ kind: 'down' })
    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' }) // 给 MiniMax-M3 选了 high

    // 换到另一条模型，再进它的详情
    atDetail(stage, 1) // 第二条：MiniMax-Text-01
    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' }) // 设为默认

    expect(sent(stage).at(-1)).toEqual({
      type: 'model.default.set',
      provider: 'personal',
      model: 'MiniMax-Text-01',
    })
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

    // 满窗 12 格 − 2 行说明 ⇒ 预算 10 格；画 9 条 ＋ 1 行折叠提示 ⇒ 余 21。
    // ⚠️ 这个数**含说明行**：说明与候选同一片交互区，共用半屏那一份预算
    //    （与草稿那一片同一条规矩；不这么算，说明一长就把记录区挤没——真跑量到过）
    // 额度 ＝ 半屏 12 − 说明 1 行 ＝ 11；**常驻行先占 3**（入口那三条）⇒ 折得动的那一段 8 格：
    // 画 7 条 ＋ 1 行折叠提示 ⇒ 余 23
    expect(frame.has('… 下面还有 23 条')).toBe(true)
  })

  test('**焦点可见**：`↓` 挪出这一窗之后窗口跟着平移，选中那条仍在屏上', async () => {
    const stage = createStage()
    open(stage, many)
    for (let at = 0; at < 15; at += 1) stage.press({ kind: 'down' })

    const frame = await stage.screen({ columns: 60, rows: 24 })

    expect(frame.has('model-15')).toBe(true) // 选中那条（第 16 行）
    expect(frame.has('… 上面还有 10 条')).toBe(true) // 上头折起来的如实报
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
