/**
 * U22 · **授权抽屉**（`/grants`）＋ **启动那几句**——规格即测试。
 *
 * 出处：
 * - `技术方案 · 权限「授权的落点」`——「配两件：**查看 / 撤销**（`/grants`）与**陈旧节**的
 *   显式列出」；
 * - `交接/对表.md` · `B13`——呈现形态＝**左下抽屉**（与 `/session` · `/model` 同位置同开合）；
 *   **撤销＝选定即撤 ＋ 一行回执**；
 * - `B11`——陈旧节**只列不删**（删用户数据不归内核）；
 * - `B10`——放行区那笔账的口径（未配规则的调用占比），在那个抽屉的下方报出来；
 * - 审计第 13 条——解析从严**要让用户看得见**（原先只有 `--check` 会说，TUI 一声不响）。
 *
 * 这一层测**键位语义与视图**（不起 Ink）：抽屉开在哪儿、选定发什么、回执与刷新怎么走。
 */

import { describe, expect, test } from 'bun:test'
import type { EventDataOf } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import type { ShellKey } from '../src/shell.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'

const HERE = '/work/proj'

const ENTER: ShellKey = { kind: 'enter' }
const ESC: ShellKey = { kind: 'escape' }

/** 一份名录——一条授权 ＋ 一个陈旧的节（两条路都有行可点）。 */
function catalog(over: Partial<EventDataOf['grants.catalog']> = {}): EventDataOf['grants.catalog'] {
  return {
    workspace: HERE,
    grants: [
      { describe: '工具 exec × 根内 × 操作 read', grantedAt: 1_700_000_000_000, hits: 3, lastHitAt: 1_700_000_000_000, stale: false },
      { describe: '工具 read × 根内 × 任意操作', grantedAt: 1_699_000_000_000, stale: true },
    ],
    stale: ['/work/gone'],
    decisions: { total: 8, uncovered: 4, vetoed: 1 },
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
    rows: () => [...shell.getView().settled, ...shell.getView().rows],
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

// ══ 开抽屉（B13：与 `/session` · `/model` 同位置同开合）═════════════════

describe('`/grants` —— 左下抽屉', () => {
  test('发一次 `grants.list`，**记录区什么都不进**（交互配置型）', () => {
    const app = live()

    app.type('/grants')
    app.press(ENTER)

    expect(app.spy.commands).toEqual([{ type: 'grants.list' }])
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

  test('一条授权都没有时，那行**先说你此刻在哪儿**（不然点不出来不知道记到哪去了）', () => {
    const app = live()
    openDrawer(app, { grants: [], stale: [] })

    expect(app.picker()?.rows).toEqual([])
    expect(app.picker()?.hint ?? '').toContain(HERE)
    expect(app.picker()?.hint ?? '').toContain('按 a')
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
