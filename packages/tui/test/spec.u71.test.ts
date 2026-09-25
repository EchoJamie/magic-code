/**
 * U71 · **配置一览**（`/config`）——规格即测试。
 *
 * 出处：设计 · 命令行与配置「`/config`：一个看得到『现在配成什么样』的入口」——
 * **一屏列表**，每行**一个可配项 ＋ 它的当前值**（右列对齐）；**打字即过滤**（不设专门的
 * 搜索模式）· **退格清过滤**（退到空＝全表）；**`esc` 一律全收**（⚠️ 在这一屏**不负责
 * 清过滤**，不许造「先清过滤、再全收」的两段 `esc`）；选中某一行 ⇒ **进那一项自己那一屏**
 * （设计：「`/model` 那一套分步交互照旧，**不在 `/config` 里重造一遍**」）。
 *
 * 这一层测**键位语义与视图**（不起 Ink 的那几条）＋ 一条**渲染出来的屏**（右列对齐是
 * 「看得见」的事，视图字段答不了那句话）。那三份读数怎么来、屏上长什么样各有一条：
 * 真 PTY 的帧另有一支（`packages/app/test/frames-u71-tui.ts`）。
 */

import { describe, expect, test } from 'bun:test'
import type { EventDataOf, ModelCatalogRow, ModelInfoRead, ModelRef } from '@magic/contracts'
import { HINT_IDLE, HINT_PICKER, HINT_PICKER_CONFIG, configRows } from '../src/view.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'

const HOME = '/home/echo'
const DATA_DIR = `${HOME}/.magic`
const ROOT = `${HOME}/ns/proj`

const ENTER = { kind: 'enter' } as const
const ESC = { kind: 'escape' } as const
const DOWN = { kind: 'down' } as const
const LEFT = { kind: 'left' } as const
const RIGHT = { kind: 'right' } as const
const BACKSPACE = { kind: 'backspace' } as const

/** 起一台取景台——`/config` 第 4 行那三件（数据目录 · 家目录 · 工作区根）由入参给。 */
function live(roots: readonly string[] = [ROOT]): Stage {
  return createStage({ dataDir: DATA_DIR, home: HOME, workspaceRoots: roots })
}

// —— 三份读数（内核那一边的产物，用例里得有人代发）——

function cacheOf(ids: readonly { readonly id: string; readonly name?: string }[]): ModelInfoRead {
  return {
    snapshot: {
      provider: 'x',
      scope: 'minimax|cn',
      fetchedAt: 1_700_000_000_000,
      models: ids.map((one) => (one.name === undefined ? { id: one.id } : one)),
    },
  }
}

/** 两条连接、各一个模型——「模型与连接」那一格要的是**此刻走哪一条**。 */
const ENTRIES: readonly ModelCatalogRow[] = [
  {
    provider: 'minimax',
    name: '个人版',
    model: 'MiniMax-M3',
    cache: cacheOf([{ id: 'MiniMax-M3', name: 'MiniMax-M3' }]),
  },
  {
    provider: 'deepseek',
    name: '深度求索',
    model: 'deepseek-chat',
    cache: cacheOf([{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
  },
]

const CURRENT: ModelRef = { provider: 'minimax', model: 'MiniMax-M3' }

const GRANTS: EventDataOf['grants.catalog'] = {
  workspace: ROOT,
  grants: [
    { describe: '工具 exec × 根内 × 操作 read', grantedAt: 1_700_000_000_000, stale: false },
    { describe: '工具 read × 根内 × 任意操作', grantedAt: 1_699_000_000_000, stale: false },
  ],
  stale: [],
  decisions: { total: 8, uncovered: 4, vetoed: 1 },
  history: { total: 20, auto: 15, kernel: 0 },
}

const MCP: EventDataOf['mcp.catalog'] = {
  servers: [
    { server: 'files', transport: 'stdio', state: { status: 'available' }, tools: ['read'], rejected: [] },
  ],
}

/** 开那一屏：打 `/config` ＋ 回车 → 内核回三份读数。 */
function open(
  stage: Stage,
  over: {
    readonly entries?: readonly ModelCatalogRow[]
    readonly current?: ModelRef | null
    /** 「取网页用的模型」那一格（U78）——不给＝**还没配**（答复上不给这一位）。 */
    readonly webFetch?: ModelRef | null
    readonly grants?: EventDataOf['grants.catalog']
    readonly mcp?: EventDataOf['mcp.catalog']
  } = {},
): void {
  stage.type('/config')
  stage.press(ENTER)
  stage.feed([
    event('model.catalog', {
      entries: over.entries ?? ENTRIES,
      ...(over.current === undefined
        ? { current: CURRENT }
        : over.current === null
          ? {}
          : { current: over.current }),
      ...(over.webFetch === undefined || over.webFetch === null ? {} : { webFetch: over.webFetch }),
    }),
    event('grants.catalog', over.grants ?? GRANTS),
    event('mcp.catalog', over.mcp ?? MCP),
  ])
}

/** 此刻开着的那扇抽屉（没开着就是 `undefined`）。 */
function pickerOf(stage: Stage) {
  const dock = stage.shell.getView().dock
  return dock.kind === 'picker' ? dock.picker : undefined
}

/**
 * 记录区里那几行字（去掉启动字标那一块——它不是这一屏说的话）。
 *
 * 三种行各写各的：纯输出是 `lines`（一块，`/status` 那种）、回执是 `text`、其余（会话内容）
 * 不在这几条判据里。照旧**一行一行读**——这一屏要判的正是「用户看得见的那几行是什么」。
 */
function rowsOf(stage: Stage): readonly string[] {
  const view = stage.shell.getView()

  return [...view.settled, ...view.rows]
    .filter((row) => row.kind !== 'banner')
    .flatMap((row) =>
      row.kind === 'output' ? row.lines : 'text' in row ? [row.text] : [],
    )
}

/** 抽屉里那一列名称（**去掉补齐用的全角空格**）。 */
function labelsOf(stage: Stage): readonly string[] {
  const picker = stage.shell.getView()
  const dock = picker.dock
  return dock.kind === 'picker' ? dock.picker.rows.map((row) => row.label.trim()) : []
}

/** 某一项那一格（当前值）——按名称找。 */
function valueOf(stage: Stage, name: string): string | undefined {
  const dock = stage.shell.getView().dock
  if (dock.kind !== 'picker') return undefined

  return dock.picker.rows.find((row) => row.label.trim() === name)?.meta
}

const hintOf = (stage: Stage): string | undefined => {
  const dock = stage.shell.getView().dock
  return dock.kind === 'picker' ? dock.picker.hint : undefined
}

const draftOf = (stage: Stage): string => stage.shell.getView().draft
const statusHintOf = (stage: Stage): string => stage.shell.getView().status.hint

// ══ 一 · 开屏 ═════════════════════════════════════════════════════════

describe('`/config` · 开屏', () => {
  test('一次问三份读数（连接 · 授权 · 外部工具）；**齐了才开屏**', () => {
    const stage = live()
    stage.type('/config')
    stage.press(ENTER)

    // ⚠️ 头一条是打 `/` 那一下的技能目录查询（U33：输入行候选要它）——与这一屏无关
    expect(stage.commands()).toEqual([
      { type: 'skills.list' },
      { type: 'model.list' },
      { type: 'grants.list' },
      { type: 'mcp.list' },
    ])

    // 来一份：还差两份 ⇒ **不开**（少问一份，那一格就只能写「还没问到」，而「一眼看全」
    // 正是这一屏存在的理由），记录区也一个字都不进
    stage.feed([event('model.catalog', { entries: ENTRIES, current: CURRENT })])
    expect(pickerOf(stage)).toBeUndefined()
    expect(rowsOf(stage)).toEqual([])

    // 三份齐了才开
    stage.feed([event('grants.catalog', GRANTS), event('mcp.catalog', MCP)])
    expect(labelsOf(stage)).toEqual([
      '模型与连接',
      '取网页用的模型', // U78 加的那一行（设计预留给它的就是这一格）
      '本工作区授权',
      '外部工具',
      '数据目录与工作区根',
    ])
    expect(statusHintOf(stage)).toBe(HINT_PICKER_CONFIG)
  })

  test('每行都看得到当前值，且与那三份读数对得上', () => {
    const stage = live()
    open(stage)

    expect(valueOf(stage, '模型与连接')).toBe('MiniMax-M3 · 个人版')
    expect(valueOf(stage, '本工作区授权')).toBe('2 条')
    expect(valueOf(stage, '外部工具')).toBe('1 台')
    // 末行：家目录下那一截缩成 `~`（省那一格的地方），根只有一个就直接摆出来
    expect(valueOf(stage, '数据目录与工作区根')).toBe('~/.magic · ~/ns/proj')
  })

  test('**右列对齐**——五行的值在屏上起于同一列（布局那一关）', async () => {
    const stage = live()
    open(stage, { webFetch: { provider: 'deepseek', model: 'deepseek-chat' } })

    const frame = await stage.screen({ columns: 100, rows: 30 })
    const values = [
      'MiniMax-M3 · 个人版',
      'DeepSeek Chat · 深度求索',
      '2 条',
      '1 台',
      '~/.magic · ~/ns/proj',
    ]
    const at = values.map((value) => {
      const line = frame.dock.find((one) => one.text.includes(value))
      return line === undefined ? -1 : line.text.indexOf(value)
    })

    // 找得到（`-1` 也算「起于同一列」——那样这条判据会空转过去）
    expect(at.every((one) => one > 0)).toBe(true)
    expect(new Set(at).size).toBe(1)
  })

  test('值随实际状态变——换过模型之后再看一遍，那一格跟着变', () => {
    const stage = live()
    open(stage)
    expect(valueOf(stage, '模型与连接')).toBe('MiniMax-M3 · 个人版')

    stage.press(ESC)
    // 「此刻走哪一条」是内核的读数（`model.catalog` 的 `current`）——换过之后它变了，
    // 而 `/config` 每次开屏**现问一次**，故那一格跟着变（不是开局那一份的陈账）
    open(stage, { current: { provider: 'deepseek', model: 'deepseek-chat' } })
    expect(valueOf(stage, '模型与连接')).toBe('DeepSeek Chat · 深度求索')
  })

  test('`/config` 不带参数——多写的词如实回一句，不当交代发出去', () => {
    const stage = live()
    stage.type('/config 模型')
    stage.press(ENTER)

    expect(stage.commands()).toEqual([{ type: 'skills.list' }])
    expect(rowsOf(stage)).toEqual(['认得的用法：/config（不带参数）'])
  })
})

// ══ 二 · 筛（打字即过滤 · 退格清过滤）═════════════════════════════════

describe('`/config` · 筛', () => {
  test('打字即过滤——**没有第二个搜索框**，打进去的字也不进草稿', () => {
    const stage = live()
    open(stage)

    stage.type('授权')
    expect(labelsOf(stage)).toEqual(['本工作区授权'])
    // ⚠️ 「不设专门的搜索模式」：打进去的字**一个都不进草稿**（草稿照旧空着——这一屏接管了
    // 输入，而它没有另开一个输入框），筛词报在列表下方那行说明里（用户看得见自己在筛什么）
    expect(draftOf(stage)).toBe('')
    expect(hintOf(stage)).toBe('筛选「授权」——接着打收窄，退格删一个字')
  })

  test('筛按**屏上看得见的字**（名称 ＋ 当前值那一格）——打值里的字也找得到', () => {
    const stage = live()
    open(stage)

    // 「个人版」是第 1 行**值**里的一截（名称里没有）——照样筛得中
    stage.type('个人版')
    expect(labelsOf(stage)).toEqual(['模型与连接'])
  })

  test('退格清过滤——退到空＝**全表**（抽屉照旧开着）', () => {
    const stage = live()
    open(stage)
    stage.type('授权')
    expect(labelsOf(stage)).toHaveLength(1)

    stage.press(BACKSPACE)
    // 「授」还在筛（一个字也是筛词）
    expect(hintOf(stage)).toBe('筛选「授」——接着打收窄，退格删一个字')
    stage.press(BACKSPACE)

    expect(labelsOf(stage)).toHaveLength(5)
    expect(hintOf(stage)).toBe('回车＝进那一项')
    expect(statusHintOf(stage)).toBe(HINT_PICKER_CONFIG) // 抽屉照旧开着
  })

  test('筛空了**照开**（0 行是一个回答，不是死胡同）——说得出「没有这一项」', () => {
    const stage = live()
    open(stage)

    stage.type('zzz')
    expect(labelsOf(stage)).toEqual([])
    expect(hintOf(stage)).toBe('没有匹配「zzz」的项——退格删一个字')
    // 抽屉没被收起：接着退格、或 `esc` 走人——两个动作都还在
    expect(statusHintOf(stage)).toBe(HINT_PICKER_CONFIG)
  })

  test('`esc` **不负责清过滤**（清过滤归退格）——筛词只活在这一屏里', () => {
    const stage = live()
    open(stage)
    stage.type('授权')

    // 一下 `esc` 就全收（**不是**「先清过滤再收起」的两段键）
    stage.press(ESC)
    expect(pickerOf(stage)).toBeUndefined()
    expect(statusHintOf(stage)).toBe(HINT_IDLE)

    // 再开一次 ⇒ 全表（开一屏就是一屏新的，筛词不跟着活下来）
    open(stage)
    expect(labelsOf(stage)).toHaveLength(5)
    expect(hintOf(stage)).toBe('回车＝进那一项')
  })
})

// ══ 三 · 选中 ⇒ 进那一项自己那一屏 ════════════════════════════════════

describe('`/config` · 选中即进那一屏', () => {
  test('「模型与连接」⇒ 与**直接敲 `/model`** 逐字同形（两趟对着看）', async () => {
    const direct = live()
    direct.type('/model')
    direct.press(ENTER)
    direct.feed([event('model.catalog', { entries: ENTRIES, current: CURRENT })])

    const viaConfig = live()
    open(viaConfig)
    viaConfig.press(ENTER) // 选中第 1 行
    // **同一条命令**（不是另走一条捷径）：那一条读侧命令原样发出去
    expect(viaConfig.commands().at(-1)).toEqual({ type: 'model.list' })
    viaConfig.feed([event('model.catalog', { entries: ENTRIES, current: CURRENT })])

    // 抽屉那一份**逐字段相同**，屏上那一块**逐字相同**（连同右位提示）
    expect(pickerOf(viaConfig)).toEqual(pickerOf(direct))
    const a = await direct.screen({ columns: 100, rows: 30 })
    const b = await viaConfig.screen({ columns: 100, rows: 30 })
    expect(b.dock.map((one) => one.text)).toEqual(a.dock.map((one) => one.text))
    expect(b.statusLine).toBe(a.statusLine)
    expect(b.record.map((one) => one.text)).toEqual(a.record.map((one) => one.text))
  })

  test('「本工作区授权」⇒ `/grants` 那一屏；「外部工具」⇒ `/mcp` 那一屏（都是总览）', () => {
    const grants = live()
    open(grants)
    // ⚠️ 两下：U78 起「取网页用的模型」排在第 1 行（「模型与连接」的下一行）
    grants.press(DOWN)
    grants.press(DOWN)
    grants.press(ENTER)
    expect(grants.commands().at(-1)).toEqual({ type: 'grants.list' })
    grants.feed([event('grants.catalog', GRANTS)])
    expect(labelsOf(grants)).toEqual(['工具 exec × 根内 × 操作 read', '工具 read × 根内 × 任意操作'])

    const mcp = live()
    open(mcp)
    mcp.press(DOWN)
    mcp.press(DOWN)
    mcp.press(DOWN)
    mcp.press(ENTER)
    expect(mcp.commands().at(-1)).toEqual({ type: 'mcp.list' })
    mcp.feed([event('mcp.catalog', MCP)])
    expect(labelsOf(mcp)).toEqual(['files'])
  })

  test('「数据目录与工作区根」⇒ 自己那一屏：一块输出，报的是**没缩过的全路径**', () => {
    const stage = live()
    open(stage)
    for (let step = 0; step < 4; step += 1) stage.press(DOWN) // 末行（U78 起是第 5 行）
    stage.press(ENTER)

    // 收屏（回输入行），记录区里留一块
    expect(pickerOf(stage)).toBeUndefined()
    expect(rowsOf(stage)).toEqual([
      '数据与工作区根',
      `  数据目录　${DATA_DIR}`,
      `  工作区根　${ROOT}`,
    ])
  })

  test('多根时头一条标「默认根」（相对路径与新文件落它）', () => {
    const stage = live([ROOT, `${HOME}/ns/sub`])
    open(stage)

    // 列表那一格报个数（一格里摆不下两条全路径），它自己那一屏逐条写全
    expect(valueOf(stage, '数据目录与工作区根')).toBe('~/.magic · 2 个根')

    for (let step = 0; step < 4; step += 1) stage.press(DOWN)
    stage.press(ENTER)
    expect(rowsOf(stage)).toEqual([
      '数据与工作区根',
      `  数据目录　${DATA_DIR}`,
      `  工作区根　${ROOT}（默认根）`,
      `  工作区根　${HOME}/ns/sub`,
    ])
  })

  test('`←` 从那一项退回来 ⇒ 还是 `/config`（栈的单位是那一屏）', () => {
    const stage = live()
    open(stage)
    stage.press(ENTER)
    stage.feed([event('model.catalog', { entries: ENTRIES, current: CURRENT })])
    expect(pickerOf(stage)).toEqual(expect.objectContaining({ source: 'model' }))

    stage.press(LEFT)
    expect(pickerOf(stage)).toEqual(expect.objectContaining({ source: 'config' }))
    expect(labelsOf(stage)).toHaveLength(5)
  })
})

// ══ 四 · 取值规则（纯函数那一层）═════════════════════════════════════

describe('`/config` · 那一格写什么（纯函数）', () => {
  const paths = { dataDir: '/d', home: '/home/echo', workspaceRoots: ['/home/echo/ws'] }
  const base = {
    paths,
    models: ENTRIES,
    current: CURRENT,
    // 缺省＝**还没配**（U78 那一格；要验配上了的形就显式给一个）
    webFetch: null,
    grants: GRANTS,
    mcp: MCP,
    filter: '',
  }

  const rowOf = (
    over: Partial<Parameters<typeof configRows>[0]> = {},
  ): Readonly<Record<string, string | undefined>> =>
    Object.fromEntries(
      configRows({ ...base, ...over }).map((row) => [row.label.trim(), row.meta]),
    )

  test('一条连接都没有 / 有连接却没选过模型——**两种「没有去向」分开说**', () => {
    expect(rowOf({ models: [], current: null })['模型与连接']).toBe('还没接入')
    expect(rowOf({ current: null })['模型与连接']).toBe('还没选模型')
  })

  test('当前那个模型不在缓存里（换过、又被移除了）⇒ 照实报精确 id，不拿别的顶上', () => {
    expect(rowOf({ current: { provider: 'minimax', model: '老的-01' } })['模型与连接']).toBe(
      '老的-01 · 个人版',
    )
  })

  test('授权与外部工具报的是**数量**（来源 / 连接状态 / 工具数留在各自那一屏）', () => {
    expect(rowOf()['本工作区授权']).toBe('2 条')
    expect(rowOf({ grants: { ...GRANTS, grants: [] } })['本工作区授权']).toBe('还没有')
    expect(rowOf()['外部工具']).toBe('1 台')
    expect(rowOf({ mcp: { servers: [] } })['外部工具']).toBe('还没配')
  })

  test('路径那一格：不在家目录下的照旧写绝对路径（缩不了就不缩）', () => {
    expect(
      rowOf({ paths: { dataDir: '/var/magic', home: '/home/echo', workspaceRoots: ['/srv/ws'] } })[
        '数据目录与工作区根'
      ],
    ).toBe('/var/magic · /srv/ws')
  })

  test('筛词空＝全表（五行）；筛不中＝空表（退到空就是全表）', () => {
    expect(configRows(base)).toHaveLength(5)
    expect(configRows({ ...base, filter: '没有这一项' })).toEqual([])
  })

  test('每一行都**担保只占一行**（长值由渲染层截断——账与屏才不会分家）', () => {
    for (const row of configRows(base)) expect(row.oneLine).toBe(true)
  })
})

// ══ 五 · 「取网页用的模型」那一行（U78）══════════════════════════════

describe('`/config` · 取网页用的模型（U78）', () => {
  const paths = { dataDir: '/d', home: '/home/echo', workspaceRoots: ['/home/echo/ws'] }
  const CALL = { paths, models: ENTRIES, current: CURRENT, webFetch: null, grants: GRANTS, mcp: MCP, filter: '' }

  const valueOf = (webFetch: ModelRef | null): string | undefined =>
    configRows({ ...CALL, webFetch }).find((row) => row.label.trim() === '取网页用的模型')?.meta

  test('**没配就写「还没配」**——不留空、不编一个默认（报错那句指的路就在这一行上）', () => {
    expect(valueOf(null)).toBe('还没配')
  })

  test('配了就报那一对（形如 `模型名 · 连接名`）——与「模型与连接」同一套取法', () => {
    expect(valueOf({ provider: 'deepseek', model: 'deepseek-chat' })).toBe('DeepSeek Chat · 深度求索')
  })

  test('那一对不在缓存里 ⇒ 照实报精确 id（不拿别的顶上）', () => {
    expect(valueOf({ provider: 'minimax', model: '老的-01' })).toBe('老的-01 · 个人版')
  })

  test('⚠️ **它与「模型与连接」各是各的**——两格可以在不同的连接上', () => {
    const rows = configRows({
      ...CALL,
      current: { provider: 'minimax', model: 'MiniMax-M3' },
      webFetch: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    const at = (name: string): string | undefined =>
      rows.find((row) => row.label.trim() === name)?.meta

    expect(at('模型与连接')).toBe('MiniMax-M3 · 个人版')
    expect(at('取网页用的模型')).toBe('DeepSeek Chat · 深度求索')
  })

  test('筛「取网页」只筛得出它（名称与当前值两处都算数）', () => {
    const rows = configRows({ ...CALL, filter: '取网页' })
    expect(rows.map((row) => row.label.trim())).toEqual(['取网页用的模型'])

    // 值那一格也参与筛（「还没配」这三个字打进去也找得到它）
    expect(configRows({ ...CALL, filter: '还没配' }).map((row) => row.label.trim())).toEqual([
      '取网页用的模型',
    ])
  })
})

// ══ 六 · 选中它 ⇒ 进模型选择器（**另一趟** · U78）═════════════════════

describe('`/config` · 取网页那一趟的模型选择器（U78）', () => {
  /** 走到那一行并按回车——末行项名是 `ANCHOR`，这里按**名称**找它那一行。 */
  function openWebFetchPicker(
    stage: Stage,
    over: { readonly webFetch?: ModelRef | null } = {},
  ): void {
    open(stage, over.webFetch === undefined ? {} : { webFetch: over.webFetch })
    stage.press(DOWN) // 第 1 行＝「取网页用的模型」（「模型与连接」的下一行）
    stage.press(ENTER)
    stage.feed([
      event('model.catalog', {
        entries: ENTRIES,
        current: CURRENT,
        ...(over.webFetch === undefined || over.webFetch === null ? {} : { webFetch: over.webFetch }),
      }),
    ])
  }

  test('进的是**模型那一屏**（与 `/model` 同一个 `source`）——不是另造一屏', () => {
    const stage = live()
    openWebFetchPicker(stage)

    expect(stage.commands().at(-1)).toEqual({ type: 'model.list' })
    expect(pickerOf(stage)).toEqual(expect.objectContaining({ source: 'model' }))
  })

  test('**屏上说清作用对象**：取网页那一件，不动当前会话', () => {
    const stage = live()
    openWebFetchPicker(stage)

    expect(hintOf(stage)).toContain('取网页用的模型')
    expect(hintOf(stage)).toContain('当前会话的模型不受影响')
    // ⚠️ `→` 在这一趟是空的 ⇒ 说明里**不提那个键**（报一个按下去没反应的键比不报更坏）
    expect(hintOf(stage)).not.toContain('→ 看这条的详情')
  })

  test('「现在配的是谁」按**取网页那一格**找——不是当前会话那个', () => {
    const stage = live()
    openWebFetchPicker(stage, { webFetch: { provider: 'deepseek', model: 'deepseek-chat' } })

    const rows = pickerOf(stage)?.rows ?? []
    const marked = rows.filter((row) => row.current).map((row) => row.pick?.model)
    expect(marked).toEqual(['deepseek-chat'])
    // 光标落在它头上（不是从头起）
    expect(rows[pickerOf(stage)?.selected ?? 0]?.pick?.model).toBe('deepseek-chat')
  })

  test('还没配 ⇒ 一行都不标「现在配的是它」，光标从头起', () => {
    const stage = live()
    openWebFetchPicker(stage)

    const rows = pickerOf(stage)?.rows ?? []
    expect(rows.some((row) => row.current)).toBe(false)
    expect(pickerOf(stage)?.selected).toBe(0)
  })

  test('回车＝**保存**（`webfetch.set`）——不是 `model.switch`', () => {
    const stage = live()
    openWebFetchPicker(stage)
    stage.press(ENTER)

    expect(stage.commands().at(-1)).toEqual({
      type: 'webfetch.set',
      provider: 'minimax',
      model: 'MiniMax-M3',
    })
    // 那一屏收起（保存是一次动作，不是换一屏）
    expect(pickerOf(stage)).toBeUndefined()
  })

  test('保存的回话到了 ⇒ 一行回执（说清存了哪一对），**会话的模型一个字没动**', () => {
    const stage = live()
    openWebFetchPicker(stage)
    stage.press(ENTER)
    const before = stage.shell.getView().modelCurrent

    stage.feed([
      event('model.catalog', {
        entries: ENTRIES,
        current: CURRENT,
        webFetch: { provider: 'minimax', model: 'MiniMax-M3' },
        note: '取网页用的模型：MiniMax-M3 · 个人版',
      }),
    ])

    expect(rowsOf(stage)).toContain('取网页用的模型：MiniMax-M3 · 个人版')
    // 反面：状态行那个模型照旧（`modelCurrent` 与 `status.model` 都不是这一趟改的）
    expect(stage.shell.getView().modelCurrent).toEqual(before)
    expect(stage.shell.getView().webFetch).toEqual({ provider: 'minimax', model: 'MiniMax-M3' })
  })

  test('`→` 在取网页那一趟**什么都不做**（详情那两条动作都是当前会话的事）', () => {
    const stage = live()
    openWebFetchPicker(stage)
    stage.press(RIGHT)

    expect(pickerOf(stage)).toEqual(expect.objectContaining({ source: 'model' }))
  })

  test('`←` 退回 `/config` 那一屏，且**下一次进 `/model` 是会话那一趟**（作用对象不残留）', () => {
    const stage = live()
    openWebFetchPicker(stage)
    stage.press(LEFT)
    expect(pickerOf(stage)).toEqual(expect.objectContaining({ source: 'config' }))

    // 从输入行打 `/model` ⇒ 回到「当前会话」那一趟：说明里没有取网页那一句、回车发的是 model.switch
    stage.press(ESC)
    stage.type('/model')
    stage.press(ENTER)
    stage.feed([event('model.catalog', { entries: ENTRIES, current: CURRENT })])
    expect(hintOf(stage)).not.toContain('取网页用的模型')

    stage.press(ENTER)
    expect(stage.commands().at(-1)).toEqual({
      type: 'model.switch',
      provider: 'minimax',
      model: 'MiniMax-M3',
    })
  })

  test('对照：`/config` 第 1 行「模型与连接」还是**会话那一趟**（回车＝切过去）', () => {
    const stage = live()
    open(stage)
    stage.press(ENTER)
    stage.feed([event('model.catalog', { entries: ENTRIES, current: CURRENT })])
    expect(hintOf(stage)).not.toContain('取网页用的模型')

    stage.press(ENTER)
    expect(stage.commands().at(-1)).toEqual({
      type: 'model.switch',
      provider: 'minimax',
      model: 'MiniMax-M3',
    })
  })
})

describe('`/config` · 键位提示', () => {
  test('右位那句是**这一屏能做的**：比通用那句多一个「打字筛」', () => {
    expect(HINT_PICKER_CONFIG).toBe('↑↓ 选 · 回车 定 · 打字筛 · ← 退 · esc 收起')
    expect(HINT_PICKER).not.toContain('打字筛')
  })
})
