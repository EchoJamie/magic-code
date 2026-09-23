/**
 * U22 · **授权抽屉**（`/grants`）＋ **启动那几句**——规格即测试。
 *
 * 出处：
 * - `技术方案 · 权限「授权的落点」`——「配两件：**查看 / 撤销**（`/grants`）与**陈旧节**的
 *   显式列出」；
 * - `交接/对表.md` · `B13`——呈现形态＝**左下抽屉**（与 `/resume` · `/model` 同位置同开合）；
 *   **撤销＝选定即撤 ＋ 一行回执**；
 * - `B11`——陈旧节**只列不删**（删用户数据不归内核）；
 * - `B10`——放行区那笔账的口径（未配规则的调用占比），在那个抽屉的下方报出来；
 * - 审计第 13 条——解析从严**要让用户看得见**（原先只有 `--check` 会说，TUI 一声不响）。
 *
 * 这一层测**键位语义与视图**（不起 Ink）：抽屉开在哪儿、选定发什么、回执与刷新怎么走。
 * ⚠️ 例外：`P0` 那一节有一条第**屏级**判据（用户报的是「屏上像卡死」，视图字段答不了那句话）。
 */

import { describe, expect, test } from 'bun:test'
import type { EventDataOf } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import type { ShellKey } from '../src/shell.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { createStage } from './screen.ts'

const HERE = '/work/proj'
/** 屏级判据用的尺寸（与 `spec.dock.test.ts` 同形）。 */
const WIDE = { columns: 80, rows: 24 } as const

const ENTER: ShellKey = { kind: 'enter' }
const ESC: ShellKey = { kind: 'escape' }

/** 一份名录——一条授权 ＋ 一个陈旧的节（两条路都有行可点）＋ 两笔账。 */
function catalog(over: Partial<EventDataOf['grants.catalog']> = {}): EventDataOf['grants.catalog'] {
  return {
    workspace: HERE,
    grants: [
      { describe: '工具 exec × 根内 × 操作 read', grantedAt: 1_700_000_000_000, hits: 3, lastHitAt: 1_700_000_000_000, stale: false },
      { describe: '工具 read × 根内 × 任意操作', grantedAt: 1_699_000_000_000, stale: true },
    ],
    stale: ['/work/gone'],
    decisions: { total: 8, uncovered: 4, vetoed: 1 },
    // 历史累计（U28）——**跨会话**那笔账（库里那些会话一起数）
    history: { total: 20, auto: 15 },
    ...over,
  }
}

/** 起一个壳 ＋ 间谍传输。 */
function live(receipts?: readonly string[]) {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, receipts === undefined ? {} : { receipts })

  return {
    shell,
    spy,
    type(text: string) {
      for (const char of text) shell.key({ kind: 'char', char })
    },
    press(key: ShellKey) {
      return shell.key(key)
    },
    view: (): ShellView => shell.getView(),
    // ⚠️ **不含启动字标**（TUI Banner）——本文件问的是「抽屉开合**往记录区进了什么**」，
    // 而字标恒在 `settled[0]`（启动印一次），是装帧不是「进的」。
    // 原锚 / 为何变 / 新锚 三条同 `view.test.ts` 的 `onScreen`。
    rows: () =>
      [...shell.getView().settled, ...shell.getView().rows].filter((row) => row.kind !== 'banner'),
    picker: () => {
      const dock = shell.getView().dock
      return dock.kind === 'picker' ? dock.picker : undefined
    },
  }
}

/** 开抽屉：打 `/grants` ＋ 回车 → 内核回一份名录。 */
function openDrawer(app: ReturnType<typeof live>, over: Partial<EventDataOf['grants.catalog']> = {}) {
  app.type('/grants')
  app.press(ENTER)
  app.spy.emit(event('grants.catalog', catalog(over)))
}

// ══ 开抽屉（B13：与 `/resume` · `/model` 同位置同开合）═════════════════

describe('`/grants` —— 左下抽屉', () => {
  test('发一次 `grants.list`，**记录区什么都不进**（交互配置型）', () => {
    const app = live()

    app.type('/grants')
    app.press(ENTER)

    // 头一条是打 `/` 时那次技能目录查询（U33：每屏只发一次）——被测的是后面那条 `grants.list`
    expect(app.spy.commands).toEqual([{ type: 'skills.list' }, { type: 'grants.list' }])
    expect(app.rows()).toEqual([])
    expect(app.picker()).toBeUndefined() // 名录没回来之前不开（「拿不到的不编」）
  })

  test('名录回来才开——行＝授权（措辞由内核给），陈旧的节**也列出来**', () => {
    const app = live()
    openDrawer(app)

    const picker = app.picker()
    expect(picker?.source).toBe('grants')
    expect(picker?.rows.map((row) => row.label)).toEqual([
      '工具 exec × 根内 × 操作 read',
      '工具 read × 根内 × 任意操作',
      '/work/gone',
    ])
    // 陈旧的节那一组**压暗**（视觉次序），但**照样选得中**（`revoke` 在）
    expect(picker?.rows.at(-1)?.faint).toBe(true)
    expect(picker?.rows.at(-1)?.revoke).toEqual({ workspace: '/work/gone' })
    // 记录区照旧什么都不进
    expect(app.rows()).toEqual([])
  })

  test('meta 栏＝**用过的证据**：用过几次、最近什么时候；没用过就说没用过', () => {
    const app = live()
    openDrawer(app)

    const rows = app.picker()?.rows ?? []
    expect(rows[0]?.meta).toContain('3 次')
    expect(rows[1]?.meta).toContain('还没用过')
    expect(rows[1]?.meta).toContain('久未命中') // B11：标出来
  })

  test('`esc` 收起——**不留痕迹**（无回执、记录区照旧空）', () => {
    const app = live()
    openDrawer(app)

    app.press(ESC)

    expect(app.picker()).toBeUndefined()
    expect(app.rows()).toEqual([])
  })
})

// ══ 选定即撤（B13 的下半句）═══════════════════════════════════════════

describe('撤销 —— 选定即撤 ＋ 一行回执', () => {
  test('回车撤**本工作区那一条**——发它的序号（不是路径、不是措辞）', () => {
    const app = live()
    openDrawer(app)

    app.press(ENTER) // 选中项＝第一条

    expect(app.spy.commands).toEqual([
      { type: 'skills.list' }, // 打 `/` 那一下顺带问的（见上）
      { type: 'grants.list' },
      { type: 'grants.revoke', index: 0 },
    ])
  })

  test('选定一条之后**接着选下一条**——抽屉不关（撤完还能撤）', () => {
    const app = live()
    openDrawer(app)

    app.press(ENTER)
    app.spy.emit(event('grants.catalog', catalog({ grants: [], note: '已撤销：工具 exec × 根内 × 操作 read' })))

    expect(app.picker()).toBeDefined() // 还开着
    expect(app.picker()?.rows.map((row) => row.label)).toEqual(['/work/gone']) // 那一条没了
  })

  test('内核那一句 `note` 落成**记录区一行回执**（真结果，不由外壳先报）', () => {
    const app = live()
    openDrawer(app)

    app.press(ENTER)
    app.spy.emit(event('grants.catalog', catalog({ grants: [], note: '已撤销：工具 exec × 根内 × 操作 read' })))

    expect(app.rows().at(-1)).toMatchObject({
      kind: 'receipt',
      text: '已撤销：工具 exec × 根内 × 操作 read',
    })
  })

  test('**陈旧的节**那一行——撤的是**整节**（只给节名、不给序号）', () => {
    const app = live()
    openDrawer(app)

    app.press({ kind: 'down' })
    app.press({ kind: 'down' }) // 走到第三行＝陈旧的那一节
    app.press(ENTER)

    expect(app.spy.commands.at(-1)).toEqual({ type: 'grants.revoke', workspace: '/work/gone' })
  })
})

// ══ 放行区那一笔账（B10 的口径）═══════════════════════════════════════

describe('放行区那笔账 —— 未配规则的调用占比', () => {
  test('抽屉下方报**两个占比**（未配规则 / 还得你点），分母是全部裁决', () => {
    const app = live()
    openDrawer(app)

    const hint = app.picker()?.hint ?? ''
    // total 8 · uncovered 4（50%）· asked ＝ uncovered ＋ vetoed ＝ 5（63%）
    expect(hint).toContain('8 次裁决')
    expect(hint).toContain('未配规则 4 次（50%）')
    expect(hint).toContain('还得你点 5 次（63%）')
  })

  test('一次裁决都没走过——**不报占比**（0 次不是一个占比，报它等于编一个 0%）', () => {
    const app = live()
    openDrawer(app, { decisions: { total: 0, uncovered: 0, vetoed: 0 } })

    expect(app.picker()?.hint ?? '').toContain('还没走过裁决')
  })

  /**
   * ⚠️ **本条 2026-09-20 改过**（P0 · 用户真跑报的「`/grants` 让 TUI 卡死」）——三条照规矩写。
   *
   * - **原锚**：`openDrawer(app, {grants: [], stale: []})` 之后 `picker()` **开着一个 0 行的抽屉**，
   *   那句话（「本工作区（X）还没有授权——批准时按 a 就是记一条」）落在 `picker.hint` 上。
   * - **为何变**：0 行的抽屉**接管输入却不给东西可点**——接管＝作曲家让位（屏上没输入行了），
   *   而 `key()` 那边选择器开着时**字符一律吞掉** ⇒ 用户**打不了字、也没得选**，
   *   屏上只剩一行暗提示，`esc` 那句还在状态行最右 ⇒ **看着就是卡死**。
   *   而 `/grants` **默认就是这个形态**（没按过 `a` 就没有 `grants.json`，名录必空）。
   * - **新锚**：**不开抽屉**——那句话改落**记录区一行回执**（话一句不少、还更显眼），
   *   而**输入照常**（`picker()` 为 `undefined`、`dock` 仍是输入）。
   */
  test('一条授权都没有时，那行**先说你此刻在哪儿**——但**不接管输入**（P0）', () => {
    const app = live()
    openDrawer(app, { grants: [], stale: [] })

    expect(app.picker()).toBeUndefined()
    expect(app.shell.getView().dock.kind).toBe('input')

    const said = app.rows().at(-1)
    expect(said?.kind).toBe('receipt')
    expect(said?.kind === 'receipt' ? said.text : '').toContain(HERE)
    expect(said?.kind === 'receipt' ? said.text : '').toContain('按 a')
  })
})

// ══ P0 —— `/grants` 不许把输入吃掉（2026-09-20 用户真跑报的）════════════

/**
 * 用户原话：**「grants 的slash 似乎会导致TUI交互卡住 无法再进行任何输入」**。
 *
 * 真跑复现到的形态：`/grants` 之后**屏上输入行没了**、**打什么键都不产生一个字节**
 * （pty 原始字节实测：连打 `abc` 增量 0），而名录是空的 ⇒ 屏上没有列表可看。
 * 根因＝**0 行的抽屉接管了输入**（见 `view.ts` 的 `openPicker`）。
 *
 * 下面三条各钉一头：空名录**不接管** · 有行**照旧接管**（设计要的用法）· 撤空了**还回去**。
 */
describe('P0 —— `/grants` 不许把输入吃掉', () => {
  test('**空名录**：抽屉不开 —— 打字照常进草稿、回车照常发得出去', () => {
    const app = live()
    openDrawer(app, { grants: [], stale: [] })

    app.type('还能打字吗')
    expect(app.shell.getView().draft).toBe('还能打字吗')

    app.press(ENTER)
    expect(app.spy.commands.at(-1)).toEqual({
      type: 'input.submit',
      text: '还能打字吗',
      ref: 'draft-1', // 提交的配对键（U33）
    })
  })

  test('**屏上**：那条路走完，输入行还在（不是「只剩一行暗提示、像卡死」）', async () => {
    const stage = createStage()
    stage.type('/grants')
    stage.press({ kind: 'enter' })
    stage.feed([event('grants.catalog', catalog({ grants: [], stale: [] }))])

    const frame = await stage.screen(WIDE)

    // 作曲家还在屏上（「› 」那一行就是输入行）
    expect(frame.dock.some((line) => line.text.includes('›'))).toBe(true)
    // 右位报的是**空闲态**键位，不是选择器那套（报「esc 收起」就等于说还在抽屉里）
    expect(frame.statusLine).toContain('/ 命令 · ctrl+c 退出')
    // 那句话**照旧说**（改的是接管，不是措辞）
    expect(frame.has('还没有授权')).toBe(true)
  })

  test('**有行**时照旧接管（选择器是设计要的用法）——`esc` 之后输入照常', () => {
    const app = live()
    openDrawer(app) // 默认名录：两条授权 ＋ 一个陈旧的节

    expect(app.picker()).toBeDefined()
    expect(app.shell.getView().dock.kind).toBe('picker')

    app.press(ESC)
    expect(app.picker()).toBeUndefined()
    app.type('回来了')
    expect(app.shell.getView().draft).toBe('回来了')
  })

  test('**撤空了**⇒ 抽屉收起（0 行的抽屉同样会吃掉输入）', () => {
    const app = live()
    openDrawer(app, { grants: [{ describe: '就这一条', grantedAt: 1, stale: false }], stale: [] })

    app.press(ENTER) // 撤掉唯一那一条
    app.spy.emit(event('grants.catalog', catalog({ grants: [], stale: [], note: '已撤销：就这一条' })))

    expect(app.picker()).toBeUndefined()
    expect(app.shell.getView().dock.kind).toBe('input')
    app.type('还能打')
    expect(app.shell.getView().draft).toBe('还能打')
  })
})

// ══ 历史累计（U28 · 跨会话的那笔账）═══════════════════════════════════

/**
 * 判据锚的是「我要什么」：**这个项目值不值得配规则**——本会话那个数只够看「这一趟
 * 顺不顺」，跨会话才答得了这一问（`交接/进度台账.md` · 随批小修 12）。
 *
 * ⚠️ **历史只有两类**（`decider` 在库里那条事件上）：自动放行 / 还得你点——
 * 「未配规则」是本会话分得出的细账，历史里**分不开**（见契约 `DecisionHistory`）。
 */
describe('历史累计 —— 跨会话那笔账', () => {
  test('报**两格**：自动放行 ＋ 还得你点（后一个是差，不是另存的一位）', () => {
    const app = live()
    openDrawer(app, { history: { total: 20, auto: 15 } })

    const hint = app.picker()?.hint ?? ''
    expect(hint).toContain('历史累计 20 次裁决')
    expect(hint).toContain('自动放行 15 次（75%）')
    expect(hint).toContain('还得你点 5 次（25%）')
  })

  test('两笔账**各占一行**——分母不是一回事（这一趟 / 这个项目的全部会话）', () => {
    const app = live()
    openDrawer(app, {
      decisions: { total: 8, uncovered: 4, vetoed: 1 },
      history: { total: 20, auto: 15 },
    })

    const lines = (app.picker()?.hint ?? '').split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('本会话')
    expect(lines[1]).toContain('历史累计')
  })

  test('历史**一条裁决都没有**时——不报那一行（0 次不是一个占比）', () => {
    const app = live()
    openDrawer(app, { history: { total: 0, auto: 0 } })

    const hint = app.picker()?.hint ?? ''
    expect(hint).toContain('本会话') // 本会话那笔账照报（两笔账各判各的）
    expect(hint).not.toContain('历史累计')
  })
})

// ══ 启动那几句（审计第 13 条）═════════════════════════════════════════

describe('启动回执 —— 解析从严要让用户看得见', () => {
  const NOTICE = '配置里有 1 条权限规则读不懂（未生效）——/tmp/config.json（`--check` 看缘由）'

  test('开局进记录区一行回执（一次性，定局那侧）', () => {
    const app = live([NOTICE])

    expect(app.rows()).toEqual([
      { kind: 'receipt', key: expect.any(String), text: NOTICE },
    ])
  })

  test('**重建之后补一回**——`readHistory` 只回会话内容，不补这一手真外壳上一句都留不下', () => {
    const app = live([NOTICE])
    app.shell.readHistory()

    // 重建（`session.history` 收齐那一跳）会把屏上痕迹换掉
    app.spy.emit(event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] }))
    app.spy.emit(event('session.history', { session: 's1', entries: [], done: true }))

    expect(app.rows().map((row) => (row.kind === 'receipt' ? row.text : row.kind))).toEqual([NOTICE])
  })

  test('**只补一回**——再换一次会话不重复念叨', () => {
    const app = live([NOTICE])
    app.spy.emit(event('session.history', { session: 's1', entries: [], done: true }))
    app.spy.emit(event('session.state', { active: 's2', sessions: [{ id: 's2', at: 0 }] }))
    app.spy.emit(event('session.history', { session: 's2', entries: [], done: true }))

    expect(app.rows()).toEqual([])
  })

  test('没话要说＝**一句都不说**（空数组不是「没事找话说」）', () => {
    const app = live([])

    expect(app.rows()).toEqual([])
  })
})
