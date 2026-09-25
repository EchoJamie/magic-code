/**
 * U61 · **选择器的「层」与一套栈**——`←` 弹一层 · `esc` 一律全收（外壳这一侧）。
 *
 * 出处：[[设计/终端交互]]·「共用入口与状态」那段新规矩（2026-09-25 定）。
 *
 * ## 由头（设计原文）
 *
 * `/model` 那条路是**多级**的——连接列表 → 详情 → 接入：**选供应商 → 选区域 → 问密钥**。
 * 而 `esc` **一律全收** ⇒ **在「问密钥」那一屏想换一家供应商，只能全收从头再来**。
 * 选错家想重选是最自然的动作，而今天回不去。
 *
 * ## 这个文件判什么（以及最容易做窄的两处）
 *
 * ⚠️ **① 栈的单位是「那一屏」，不是「那个选择器」**：接入那一路是**选择器与本地小输入
 * 交替**（选供应商 → 选区域 → 问密钥），**它们都是层**。只给 picker 加栈的实现在
 * 「问密钥按 `←` 回到选区域」那一趟当场露馅——本文件把它钉在第一条。
 *
 * ⚠️ **② 不许只给某一个命令加层**：多级的不止 `/model`（`/attachments` 也是列表 → 详情），
 * 一级的（`/resume` · `/skills` · `@` · `/grants` · `/mcp`）**顺手统一**：按 `←` 也收起，
 * 不特殊对待。两套交互＝本单要防的那件事。
 *
 * 走的是**真按键 → 外壳**那条路（与真终端同形）；真 PTY 上逐屏留帧的那一趟在
 * `packages/app/test/frames-u61-tui.ts`（那边才有真终端与真字节）。
 */

import { describe, expect, test } from 'bun:test'
import type {
  AttachmentRow,
  KernelEvent,
  ModelCatalogRow,
  ModelInfoRead,
  VendorInfo,
} from '@magic/contracts'
import { HINT_PICKER, HINT_PICKER_READ, HINT_PICKER_SESSION, HINT_PROMPT } from '../src/view.ts'
import type { Dock, Picker } from '../src/view.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'
import { event } from './events.ts'

const ENTER = { kind: 'enter' } as const
const ESC = { kind: 'escape' } as const
const LEFT = { kind: 'left' } as const
const RIGHT = { kind: 'right' } as const
const DOWN = { kind: 'down' } as const
const UP = { kind: 'up' } as const

const dockOf = (stage: Stage): Dock => stage.shell.getView().dock
const pickerOf = (stage: Stage): Picker | undefined => {
  const dock = dockOf(stage)

  return dock.kind === 'picker' ? dock.picker : undefined
}
const promptLabelOf = (stage: Stage): string | undefined => {
  const dock = dockOf(stage)

  return dock.kind === 'prompt' ? dock.prompt.label : undefined
}
/** 此刻草稿那三格——「弹回来回到原处」「`esc` 回到原稿」都拿它逐字比。 */
const paperOf = (stage: Stage): { readonly draft: string; readonly caret: number; readonly refs: number } => {
  const view = stage.shell.getView()

  return { draft: view.draft, caret: view.caret, refs: view.refs.length }
}

function type(stage: Stage, text: string): void {
  for (const char of text) stage.press({ kind: 'char', char })
}

// —— 夹具：供应商名单 ／ 连接一览（与 `/model` 那几条路同一份形）——

/** 内置供应商与官方区域——生产路径上这一格由适配现取、随 `provider.catalog` 下来。 */
const VENDORS: readonly VendorInfo[] = [
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

function conn(
  provider: string,
  options: { readonly name?: string; readonly model?: string; readonly cache?: ModelInfoRead } = {},
): ModelCatalogRow {
  return {
    provider,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
  }
}

function feedProviders(
  stage: Stage,
  entries: readonly ModelCatalogRow[] = [],
  vendors: readonly VendorInfo[] = VENDORS,
): void {
  stage.feed([event('provider.catalog', { entries, vendors })])
}

/** 开 `/model` 那一屏（打字 → 回车 → 喂答复）。 */
function openModel(stage: Stage, entries: readonly ModelCatalogRow[], at = 0): void {
  stage.type('/model')
  stage.press(ENTER)
  stage.feed([event('model.catalog', { entries })])
  for (let step = 0; step < at; step += 1) stage.press(DOWN)
}

/**
 * 走到**「问密钥」那一屏**：`/model connect` → 挑一家（MiniMax）→ 挑区域（缺省那个）。
 *
 * ⚠️ 这一趟正是本单的由头：那三屏里**前两屏是选择器、第三屏是本地小输入**——
 * 它们都是层（设计：「栈的单位是那一屏」）。
 */
function atKeyPrompt(stage: Stage): void {
  stage.type('/model connect')
  stage.press(ENTER)
  feedProviders(stage)
  stage.press(ENTER) // MiniMax（两个区域）
  stage.press(ENTER) // 中国大陆（缺省那一项）
}

// ══ 一 · 接入那一路：一步接一步的每一屏都是层（本单的要害）═════════════

describe('① 接入那一趟：「问密钥 →「←」→ 选区域 →「←」→ 选供应商」', () => {
  test('**本地小输入也是层**——问密钥那一屏按 `←` 退回选区域，再按退回选供应商', () => {
    const stage = createStage()
    atKeyPrompt(stage)

    expect(dockOf(stage).kind).toBe('prompt')
    expect(promptLabelOf(stage)).toContain('密钥')

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('region')
    expect(pickerOf(stage)?.rows.map((row) => row.label)).toEqual(['中国大陆', '国际'])

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('vendor')
    expect(pickerOf(stage)?.rows.map((row) => row.label)).toEqual(['MiniMax', 'DeepSeek'])
  })

  test('再按一次（底下就是输入行了）⇒ **收起**——与 `esc` 同效', () => {
    const stage = createStage()
    atKeyPrompt(stage)

    stage.press(LEFT)
    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('picker') // 还在选供应商那一屏

    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input') // 弹到空 ＝ 收起
  })

  test('弹回来**回到原处**：上一层的光标位置与草稿照旧', () => {
    const stage = createStage()
    stage.type('/model connect')
    stage.press(ENTER)
    feedProviders(stage)
    stage.press(ENTER) // 选供应商那一屏：MiniMax（头一项）
    stage.press(DOWN) // 选区域那一屏挪到第二项（国际）
    stage.press(ENTER)

    expect(dockOf(stage).kind).toBe('prompt')
    const paper = paperOf(stage)

    stage.press(LEFT)
    // 区域那一屏的焦点**还在原来那一项**（不是重开一次回到第一项）
    expect(pickerOf(stage)?.source).toBe('region')
    expect(pickerOf(stage)?.selected).toBe(1)

    stage.press(LEFT)
    // 供应商那一屏同理（它当时停在头一项，回来还停在头一项）
    expect(pickerOf(stage)?.source).toBe('vendor')
    expect(pickerOf(stage)?.selected).toBe(0)
    // 草稿那三格一次都没被动过
    expect(paperOf(stage)).toEqual(paper)
  })

  test('**一家只有一个区域**那条（不经过区域那一屏）也回得去', () => {
    // 由头：「凡是存在多级的 slash，一律走这一套」——多级里少走一屏的那一支照样是层。
    const stage = createStage()
    stage.type('/model connect')
    stage.press(ENTER)
    feedProviders(stage)
    stage.press(DOWN) // DeepSeek（只有一个区域）
    stage.press(ENTER)

    expect(dockOf(stage).kind).toBe('prompt') // 直接到密钥那一屏

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('vendor')
    expect(pickerOf(stage)?.selected).toBe(1)
  })

  test('弹回来之后再选定一次 ⇒ **照旧往下走**（栈不是死的：上一层还能再进）', () => {
    const stage = createStage()
    atKeyPrompt(stage)

    stage.press(LEFT) // 回选区域
    stage.press(LEFT) // 回选供应商
    stage.press(ENTER) // 再挑 MiniMax

    expect(pickerOf(stage)?.source).toBe('region')
    stage.press(ENTER)
    expect(dockOf(stage).kind).toBe('prompt') // 又回到问密钥那一屏
  })
})

// ══ 二 · `/model` 详情那一层（`→` 看详情）════════════════════════════

describe('② `/model`：`→` 看详情 · 详情里进思考那一屏', () => {
  const two = [
    conn('local', { name: 'local', model: 'MiniMax-M3' }),
    conn('backup', { name: 'backup', model: 'MiniMax-M2' }),
  ]

  test('列表 →「→」详情 →（思考那一屏）→「←」→ 详情 →「←」→ 列表 →「←」→ 收起', () => {
    const stage = createStage()
    openModel(stage, two)

    stage.press(RIGHT)
    expect(pickerOf(stage)?.source).toBe('model-detail')

    stage.press(ENTER) // 第一行＝思考设置
    expect(pickerOf(stage)?.source).toBe('model-reasoning')

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('model-detail')

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('model')

    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input')
  })

  test('弹回列表时**焦点还在原来那一格**（不是回到头一条）', () => {
    const stage = createStage()
    openModel(stage, two, 1) // 挪到第二条
    expect(pickerOf(stage)?.selected).toBe(1)

    stage.press(RIGHT)
    stage.press(LEFT)

    expect(pickerOf(stage)?.source).toBe('model')
    expect(pickerOf(stage)?.selected).toBe(1)
  })
})

// ══ 二之二 · 列表末尾那几条入口行（**从另一屏里打开的选择器也算进一层**）═══

describe('②b `/model` 列表里点「连接供应商 / 管理连接」——那一屏也压在栈底下', () => {
  const connected = [conn('personal', { name: '个人号', model: 'MiniMax-M3' })]

  test('列表 →「连接供应商」→ 选供应商 →「←」→ **回列表** →「←」→ 收起', () => {
    // 由头：设计把 `/model` 的层级写成「**列表 → 详情 → 接入**：供应商 → 区域 → 密钥」，
    // 而「进一层」那一句里头一条就是**打开选择器**——从列表里点开的这一屏，照样是一层。
    const stage = createStage()
    openModel(stage, connected, 1) // 挪到入口行「连接供应商」

    stage.press(ENTER) // 选定 ⇒ 把 `provider.list` 发出去（**列表先留在屏上**，见下一条）
    feedProviders(stage, connected)

    expect(pickerOf(stage)?.source).toBe('vendor')
    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('model') // 退回列表
    expect(pickerOf(stage)?.selected).toBe(1) // 焦点照旧

    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input')
  })

  test('「管理连接」那一趟同理：一览 →「←」回列表', () => {
    const stage = createStage()
    openModel(stage, connected, 2) // 入口行「管理连接」

    stage.press(ENTER)
    feedProviders(stage, connected)
    expect(pickerOf(stage)?.source).toBe('provider')

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('model')
  })

  test('**刷新模型**那一条不算一层——它回来照旧是这一屏（就地重铺，栈里不叠两份）', () => {
    const stage = createStage()
    openModel(stage, connected, 3) // 入口行「刷新模型」

    stage.press(ENTER)
    stage.feed([event('model.catalog', { entries: connected })])
    expect(pickerOf(stage)?.source).toBe('model')

    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input') // 一次就收到底（底下没有「上一屏」）
  })

  test('**入口行那一跳不闪输入行**——等答复那几毫秒里，屏上留的是刚才那一屏', () => {
    const stage = createStage()
    openModel(stage, connected, 1)

    stage.press(ENTER)

    expect(pickerOf(stage)?.source).toBe('model') // 还开着（答复一到才被下一屏替下）
  })

  test('这一趟中途 `esc` ⇒ 一按到底（栈也一起清）', () => {
    const stage = createStage()
    openModel(stage, connected, 1)
    stage.press(ENTER)
    feedProviders(stage, connected)
    expect(pickerOf(stage)?.source).toBe('vendor')

    stage.press(ESC)

    expect(dockOf(stage).kind).toBe('input')
    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input') // 列表没被翻回来
  })
})

// ══ 三 · `/model manage` 那一趟（明细 → 本地小输入）═════════════════

describe('③ `/model manage`：一览 → 明细 → 问一件小事那一屏', () => {
  const connected = [conn('personal', { name: '个人号', model: 'MiniMax-M3' })]

  function atManagePrompt(stage: Stage, row = 0): void {
    stage.type('/model manage')
    stage.press(ENTER)
    feedProviders(stage, connected)
    stage.press(ENTER) // 进这一条的明细
    for (let step = 0; step < row; step += 1) stage.press(DOWN)
    stage.press(ENTER) // 选定那一件动作（改名 / 更新认证 / 高级地址）
  }

  test('改名那一屏按 `←` 退回明细，再按退回一览，再按收起', () => {
    const stage = createStage()
    atManagePrompt(stage, 0)
    expect(promptLabelOf(stage)).toBe('新名字')

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('provider-detail')

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('provider')

    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input')
  })

  test('**更新认证**（密钥）那一屏同理——它是本地小输入，也是一层', () => {
    const stage = createStage()
    atManagePrompt(stage, 1)
    expect(promptLabelOf(stage)).toContain('密钥')

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('provider-detail')
  })

  test('**高级地址**那一屏同理', () => {
    const stage = createStage()
    atManagePrompt(stage, 2)
    expect(promptLabelOf(stage)).toBe('高级地址')

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('provider-detail')
  })
})

// ══ 四 · `/attachments`：列表 → 详情（另一条多级的）══════════════════

describe('④ `/attachments`：列表 → 详情两条动作', () => {
  const rows: readonly AttachmentRow[] = [
    {
      entry: 7,
      name: '截图.png',
      mime: 'image/png',
      bytes: 67,
      at: 1_700_000_000_000,
      source: '/ws/截图.png',
      label: '截图.png',
      blob: 'blob_7',
    },
  ]

  function openAttachments(stage: Stage): void {
    stage.type('/attachments')
    stage.press(ENTER)
    stage.feed([event('attachments.catalog', { rows })] as readonly KernelEvent[])
  }

  test('列表 → 回车进详情 →「←」回列表 →「←」收起', () => {
    const stage = createStage()
    openAttachments(stage)

    expect(pickerOf(stage)?.source).toBe('attachments')
    stage.press(ENTER)
    expect(pickerOf(stage)?.source).toBe('attachment-detail')

    stage.press(LEFT)
    expect(pickerOf(stage)?.source).toBe('attachments')

    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input')
  })
})

// ══ 五 · 一级的那几屏：按 `←` 也收起（**顺手统一，不特殊对待**）══════

describe('⑤ 一级的选择器：`←` 就是收起', () => {
  test('`/resume`', () => {
    const stage = createStage()
    stage.type('/resume')
    stage.press(ENTER)
    stage.feed([
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] }),
    ])

    expect(pickerOf(stage)?.source).toBe('session')
    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input')
  })

  test('`/skills`', () => {
    const stage = createStage()
    stage.type('/skills')
    stage.press(ENTER)
    stage.feed([
      event('skills.catalog', {
        skills: [
          {
            name: 'pdf',
            description: '处理 PDF',
            path: '/ws/.magic/skills/pdf',
            label: '项目 .magic/skills',
            source: 'project',
            origin: 'magic',
          },
        ],
        problems: [],
      }),
    ])

    expect(pickerOf(stage)?.source).toBe('skills')
    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input')
  })

  test('`/grants`', () => {
    const stage = createStage()
    stage.type('/grants')
    stage.press(ENTER)
    stage.feed([
      event('grants.catalog', {
        workspace: '/ws',
        grants: [
          { describe: '工具 exec × 根内 × 操作 read', grantedAt: 1_700_000_000_000, stale: false },
        ],
        stale: [],
        decisions: { total: 1, uncovered: 0, vetoed: 0 },
        history: { total: 1, auto: 1, kernel: 0 },
      }),
    ])

    expect(pickerOf(stage)?.source).toBe('grants')
    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input')
  })

  test('`/mcp`（纯读那一屏——没有「回车 定」，但 `←` 照旧收起）', () => {
    const stage = createStage()
    stage.type('/mcp')
    stage.press(ENTER)
    stage.feed([
      event('mcp.catalog', {
        servers: [
          {
            server: 'remote',
            transport: 'http',
            state: { status: 'available' },
            tools: ['echo'],
            rejected: [],
          },
        ],
      }),
    ])

    expect(pickerOf(stage)?.source).toBe('mcp')
    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input')
  })

  test('`@` 那一栏：`←` 收起，**并把那一段查询从草稿里撤回**（与 `esc` 同效）', () => {
    // 由头：设计写的是「弹到空就收起（**与 `esc` 同效**）」——同效就得真同效：
    // `esc` 在 `@` 这一栏上不只是关抽屉，那一段「还只是查询、没成引用」的字也得撤走
    // （它本来就不算用户说的话）。
    const stage = createStage()
    type(stage, '看下 @a')
    expect(pickerOf(stage)?.source).toBe('paths')

    stage.press(LEFT)

    expect(dockOf(stage).kind).toBe('input')
    expect(stage.shell.getView().draft).toBe('看下 ') // `@a` 那一段撤走了
  })
})

// ══ 六 · `esc` 一律全收（两个动作、两个键，不混）══════════════════════

describe('⑥ `Esc` 一律全收——与 `←` 是两个动作', () => {
  test('任一深度按一次 `esc` ⇒ **当场回到原稿**（不是退一层）', () => {
    const stage = createStage()
    atKeyPrompt(stage)
    expect(dockOf(stage).kind).toBe('prompt') // 第三层

    const paper = paperOf(stage)
    stage.press(ESC)

    expect(dockOf(stage).kind).toBe('input') // 一按到底
    expect(paperOf(stage)).toEqual(paper) // 与按之前逐字相同
  })

  test('`esc` 之后**栈也一起空掉**——再按 `←` 是移插入点，不是把哪一屏翻回来', () => {
    const stage = createStage()
    atKeyPrompt(stage)
    stage.press(ESC)
    expect(dockOf(stage).kind).toBe('input')

    type(stage, '甲')
    expect(stage.shell.getView().caret).toBe(1)
    stage.press(LEFT)

    expect(dockOf(stage).kind).toBe('input') // 没有屏被翻回来
    expect(stage.shell.getView().caret).toBe(0) // 草稿那一头：真移插入点
  })

  test('`esc` 在小输入里也是全收——**typed 的那一串不再挂在屏上**', () => {
    const stage = createStage()
    atKeyPrompt(stage)
    type(stage, 'sk-secret')

    stage.press(ESC)

    expect(dockOf(stage).kind).toBe('input')
    stage.press(LEFT)
    expect(dockOf(stage).kind).toBe('input') // 栈已清
  })
})

// ══ 七 · `←` 不与输入打架（与 `↑↓` 同一分工）═════════════════════════

describe('⑦ 没开屏的时候，`←` 与 `↑↓` 照旧干它们的老本行', () => {
  test('`←` 照旧移插入点（草稿一个字不动）', () => {
    const stage = createStage()
    type(stage, '甲乙丙')
    expect(stage.shell.getView().caret).toBe(3)

    stage.press(LEFT)

    expect(stage.shell.getView().caret).toBe(2)
    expect(stage.shell.getView().draft).toBe('甲乙丙')
  })

  test('`↑↓` 照旧翻历史', () => {
    const stage = createStage()
    type(stage, '先交代一句')
    stage.press(ENTER) // 交出去（草稿清了）
    expect(stage.shell.getView().draft).toBe('')

    stage.press(UP)
    expect(stage.shell.getView().draft).toBe('先交代一句')
    stage.press(DOWN)
    expect(stage.shell.getView().draft).toBe('')
  })
})

// ══ 八 · 提示要报（那一屏的键位提示带上 `←`）═════════════════════════

describe('⑧ 键位提示里报出 `←`', () => {
  test('三句选择器提示各带 `← 退`（与 `esc 收起` 分开报——两个动作两个键）', () => {
    expect(HINT_PICKER).toContain('← 退')
    expect(HINT_PICKER_READ).toContain('← 退')
    expect(HINT_PICKER_SESSION).toContain('← 退')
    for (const hint of [HINT_PICKER, HINT_PICKER_READ, HINT_PICKER_SESSION]) {
      expect(hint).toContain('esc 收起') // 全收那一半一个字没丢
    }
  })

  test('本地小输入那一屏也报（问密钥那一屏就是它）', () => {
    expect(HINT_PROMPT).toContain('← 退')
    expect(HINT_PROMPT).toContain('esc 取消')

    const stage = createStage()
    atKeyPrompt(stage)

    expect(stage.shell.getView().status.hint).toBe(HINT_PROMPT)
  })

  test('屏上真报得出来（不是只在常量里）——选择器那一屏的右位', async () => {
    const stage = createStage()
    atKeyPrompt(stage)
    stage.press(LEFT) // 回选区域那一屏

    const frame = await stage.screen({ columns: 100, rows: 30 })

    expect(frame.statusLine).toContain('← 退')
    expect(frame.statusLine).toContain('esc 收起')
  })

  test('窄窗下**让位的是左半那几格**，不是整段提示（U61 动的那条口径）', async () => {
    // 由头（工单·最小闭环第 6 条）：「放不下就按『从右往左省』那条，**别为它挤掉更要紧的**」。
    // 提示长了一截之后，若还照老口径算，被挤掉的恰恰是**提示自己**（它整段不出现）——
    // 那就成了「加了 `←` 反而看不见任何键位」。
    //
    // 摆一屏**放不下**的：标题（11 字）＋ 模型 ＋ 用量三格齐全，80 列上怎么都塞不下。
    const stage = createStage()
    stage.feed([
      event('session.state', {
        active: 's1',
        sessions: [{ id: 's1', at: 0, title: '记录查询优化与缓存重做' }],
      }),
      event('model.switched', { ok: true, model: 'MiniMax-M3', provider: 'minimax' }),
      event('model.usage', { inputTokens: 3100, outputTokens: 40 }),
    ])
    atKeyPrompt(stage)
    stage.press(LEFT)

    const frame = await stage.screen({ columns: 80, rows: 30 })

    expect(frame.statusLine).toContain('← 退') // 提示照旧在
    expect(frame.statusLine).not.toContain('MiniMax-M3') // ③ 先让位
    expect(frame.statusLine).not.toContain('3.1k') // ④ 也一样
    expect(frame.statusLine).toContain('记录查询优化与缓存重做') // ② 还在（它只截断、不消失）
  })
})
