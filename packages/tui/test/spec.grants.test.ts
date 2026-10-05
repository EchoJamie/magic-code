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
    history: { total: 20, auto: 15, kernel: 0 },
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
  app.type('/grants ')
  app.press(ENTER)
  app.spy.emit(event('grants.catalog', catalog(over)))
}

// ══ 开抽屉（B13：与 `/resume` · `/model` 同位置同开合）═════════════════

describe('`/grants` —— 左下抽屉', () => {
  test('发一次 `grants.list`，**记录区什么都不进**（交互配置型）', () => {
    const app = live()

    app.type('/grants ')
    app.press(ENTER)

    // 头一条是打 `/` 时那次技能目录查询（U33：每屏只发一次）——被测的是后面那条 `grants.list`
    expect(app.spy.commands).toEqual([{ type: 'skills.list' }, {"local":true,ref:expect.any(String),"refs":[],"text":"/grants ","type":"input.submit"}, { type: 'grants.list' }])
    expect(app.rows()).toEqual([{"echoed":true,"key":"user.echo:0","kind":"user","text":"/grants "}])
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
    expect(app.rows()).toEqual([{"echoed":true,"key":"user.echo:0","kind":"user","text":"/grants "}])
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
    expect(app.rows()).toEqual([{"echoed":true,"key":"user.echo:0","kind":"user","text":"/grants "}])
  })
})

// ══ 查看详情后明确撤销（U114）═══════════════════════════════════════════

describe('撤销 —— 默认返回，明确选择撤销才修改', () => {
  test('回车撤**本工作区那一条**——发它的序号（不是路径、不是措辞）', () => {
    const app = live()
    openDrawer(app)

    app.press(ENTER)
    expect(app.picker()?.source).toBe('grants-detail')
    expect(app.spy.commands.some(command => command.type === 'grants.revoke')).toBe(false)
    app.press({ kind: 'down' })
    app.press(ENTER) // 选中项＝第一条

    expect(app.spy.commands).toEqual([
      { type: 'skills.list' },
      { type: 'input.submit', local: true, text: '/grants ', refs: [], ref: expect.any(String) },
      { type: 'grants.list' },
      { type: 'grants.revoke', index: 0 },
    ])
  })

  test('选定一条之后**接着选下一条**——抽屉不关（撤完还能撤）', () => {
    const app = live()
    openDrawer(app)

    app.press(ENTER)
    expect(app.picker()?.source).toBe('grants-detail')
    expect(app.spy.commands.some(command => command.type === 'grants.revoke')).toBe(false)
    app.press({ kind: 'down' })
    app.press(ENTER)
    app.spy.emit(event('grants.catalog', catalog({ grants: [], note: '已撤销：工具 exec × 根内 × 操作 read' })))

    expect(app.picker()).toBeDefined() // 还开着
    expect(app.picker()?.rows.map((row) => row.label)).toEqual(['/work/gone']) // 那一条没了
  })

  test('内核那一句 `note` 落成**记录区一行回执**（真结果，不由外壳先报）', () => {
    const app = live()
    openDrawer(app)

    app.press(ENTER)
    expect(app.picker()?.source).toBe('grants-detail')
    expect(app.spy.commands.some(command => command.type === 'grants.revoke')).toBe(false)
    app.press({ kind: 'down' })
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
    expect(app.picker()?.source).toBe('grants-detail')
    expect(app.spy.commands.some(command => command.type === 'grants.revoke')).toBe(false)
    app.press({ kind: 'down' })
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

  test('空名录仍给工作区事实和返回入口，返回后输入正常', () => {
    const app = live(); openDrawer(app, { grants: [], stale: [] })
    expect(app.picker()?.rows).toEqual([])
    expect(app.picker()?.hint).toContain(HERE)
    expect(app.picker()?.hint).toContain('Esc 返回')
    app.press(ESC); expect(app.view().dock.kind).toBe('input')
    app.type('还能打字吗'); app.press(ENTER)
    expect(app.spy.commands.at(-1)).toEqual({ type: 'input.submit', text: '还能打字吗', purpose: 'current', ref: expect.any(String) })
  })
  test('空态屏上事实与 Esc 入口可见，不在状态行重复菜单键', async () => {
    const stage = createStage(); stage.type('/grants '); stage.press(ENTER)
    stage.feed([event('grants.catalog', catalog({ grants: [], stale: [] }))])
    const frame = await stage.screen(WIDE)
    expect(frame.has('还没有授权')).toBe(true)
    expect(frame.dock.map(line => line.text).join('\n')).toContain('Esc 返回')
    expect(frame.statusLine).not.toContain('Esc 返回')
    stage.press(ESC)
    expect((await stage.screen(WIDE)).dock.some(line => line.text.includes('›'))).toBe(true)
  })
  test('看详情及默认返回零撤销；刷新后下一条也默认返回', () => {
    const app = live(); openDrawer(app)
    app.press(ENTER); expect(app.picker()?.rows[0]?.value).toBe('back')
    app.press(ENTER); expect(app.spy.commands.some(command => command.type === 'grants.revoke')).toBe(false)
    app.press(ENTER); app.press({kind:'down'}); app.press(ENTER)
    expect(app.spy.commands.at(-1)).toEqual({type:'grants.revoke',index:0})
    app.spy.emit(event('grants.catalog',catalog({grants:[{describe:'剩余授权',grantedAt:1,stale:false}]})))
    app.press(ENTER); expect(app.picker()?.rows[0]?.value).toBe('back')
    app.press(ENTER)
    expect(app.spy.commands.filter(command => command.type === 'grants.revoke')).toHaveLength(1)
  })
})

// ══ 历史累计（U28 · 跨会话的那笔账）═══════════════════════════════════

/**
 * 判据锚的是「我要什么」：**这个项目值不值得配规则**——本会话那个数只够看「这一趟
 * 顺不顺」，跨会话才答得了这一问（`交接/进度台账.md` · 随批小修 12）。
 *
 * ⚠️ **历史按 `decider` 分**（它在库里那条事件上）：自动放行（`auto`）· **内核直接拒**
 * （`kernel`，U77 补的）· 还得你点（**差**）——「未配规则」是本会话分得出的细账，
 * 历史里**分不开**（见契约 `DecisionHistory`）。
 */
describe('历史累计 —— 跨会话那笔账', () => {
  test('报**两格**：自动放行 ＋ 还得你点（后一个是差，不是另存的一位）', () => {
    const app = live()
    openDrawer(app, { history: { total: 20, auto: 15, kernel: 0 } })

    const hint = app.picker()?.hint ?? ''
    expect(hint).toContain('历史累计 20 次裁决')
    expect(hint).toContain('自动放行 15 次（75%）')
    expect(hint).toContain('还得你点 5 次（25%）')
    // ⚠️ **`kernel` 为 0 时一个字都不加**（U77）：老库、老屏上这一行与加那一格之前**逐字相同**
    expect(hint).not.toContain('内核直接拒')
  })

  /**
   * ⚠️ **「内核直接拒」要单独报出来**（U77）——`decider: 'kernel'` 是那一单新加的：
   * 从前"没问就拒"混在 `auto` 里，被这一行读成"自动放行"（**正好反着**）。
   *
   * 三件一起咬：**那一格报了出来** ＋ **它没被算进"自动放行"** ＋
   * **"还得你点"里也没有它**（拒不是"替你点过了"）。
   */
  test('**内核直接拒**自己一格——不混进「自动放行」，也不算"还得你点"', () => {
    const app = live()
    openDrawer(app, { history: { total: 20, auto: 15, kernel: 3 } })

    const hint = app.picker()?.hint ?? ''
    expect(hint).toContain('自动放行 15 次（75%）')
    expect(hint).toContain('内核直接拒 3 次（15%）')
    expect(hint).toContain('还得你点 2 次（10%）') // 20 − 15 − 3
  })

  test('两笔账**各占一行**——分母不是一回事（这一趟 / 这个项目的全部会话）', () => {
    const app = live()
    openDrawer(app, {
      decisions: { total: 8, uncovered: 4, vetoed: 1 },
      history: { total: 20, auto: 15, kernel: 0 },
    })

    const lines = (app.picker()?.hint ?? '').split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('本会话')
    expect(lines[1]).toContain('历史累计')
  })

  test('历史**一条裁决都没有**时——不报那一行（0 次不是一个占比）', () => {
    const app = live()
    openDrawer(app, { history: { total: 0, auto: 0, kernel: 0 } })

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

  test('重建保留开屏说明的原位置，不追加第二份', () => {
    const app = live([NOTICE])
    app.shell.readHistory()

    // 重建（`session.history` 收齐那一跳）会把屏上痕迹换掉
    app.spy.emit(event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] }))
    app.spy.emit(event('session.history', { session: 's1', entries: [], done: true }))

    expect(app.rows().map((row) => (row.kind === 'receipt' ? row.text : row.kind))).toEqual([NOTICE])
  })

  test('换一次会话不重复开屏说明', () => {
    const app = live([NOTICE])
    app.spy.emit(event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0 }] }))
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
