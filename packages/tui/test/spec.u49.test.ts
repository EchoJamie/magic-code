/**
 * U49 · **运行列表、状态与接回**——外壳那一侧的判据（真链路：壳 → AppView → Ink → 屏）。
 *
 * 四组：
 * 1. **列表的分段与次序**——活跃那几段在前（需要你 → 执行中 → 收尾中 → 待确认），
 *    再本工作区历史，再别的项目（设计 · 用户如何发现和接回那一句）；
 * 2. **筛选与搜索**——`tab` 换范围、打字按名字筛（都在真按键上走一遍）；
 * 3. **开屏那张摘要**——**只一次、只在确有别的活跃工作时**；
 * 4. **接回的那一份「此刻」**——在飞的正文、在跑的工具、挂着的卡，且画在历史**之后**。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent, RunRow, RunSnapshot, RunState, SessionSummary } from '@magic/contracts'
import { applyResume, createView, runDetail, runSummary, sessionRows } from '../src/view.ts'
import type { SessionScope } from '../src/view.ts'
import { createStage } from './screen.ts'
import type { Frame } from './screen.ts'

/** 取景用的尺寸——与别的 spec 同一档（80×24，`spec.dock.test.ts` 同此）。 */
const WIDE = { columns: 80, rows: 24 } as const

/** 屏上有没有这一行——断言读起来就是「屏上说了这句话 / 没有这句」。 */
const says = (frame: Frame, needle: string): boolean => frame.has(needle)

/**
 * **交互区**里有没有这一行——列表那一屏的判据都问它。
 *
 * 由头（真跑量出来的）：整屏问「有没有那条会话」，会被**状态行**（左半写着当前那条的名字）
 * 答成「有」——而这一屏要证的恰恰是「列表里有没有它」。
 */
const docked = (frame: Frame, needle: string): boolean =>
  frame.dock
    .filter((line) => line.text !== frame.statusLine) // 状态行不算「列表里那一行」
    .some((line) => line.text.includes(needle))

const HERE = ['/w/mine']

const session = (id: string, title: string, workspace?: readonly string[]): SessionSummary => ({
  id,
  title,
  at: 1_000,
  ...(workspace === undefined ? {} : { workspace }),
})

/** 一条读数——`since` 取「刚才」（详情那一行的「已持续」按真钟算）。 */
const run = (id: string, state: RunState, over: Partial<RunRow> = {}): RunRow => ({
  session: id,
  state,
  since: Date.now() - 1_000,
  startedAt: Date.now() - 1_000,
  workspace: HERE,
  holds: state === 'running' || state === 'waiting' || state === 'stopping' || state === 'unknown',
  ...over,
})

const stateEvent = (active: string, sessions: readonly SessionSummary[]): KernelEvent =>
  ({
    id: 1,
    session: active,
    turn: null,
    at: 1_000,
    kind: 'session.state',
    data: { active, sessions },
  }) as KernelEvent

describe('U49 · 列表的分段与次序', () => {
  const catalog = [
    session('s-need', '等你答复那条', HERE),
    session('s-run', '在跑那条', HERE),
    session('s-idle', '闲下来那条', HERE),
    session('s-gone', '停过那条', HERE),
    session('s-other', '别处那条', ['/w/other']),
  ]
  const runs = [
    run('s-need', 'waiting', { action: '等你定夺：bash' }),
    run('s-run', 'running', { action: '正在跑 bash' }),
    run('s-idle', 'idle'),
    run('s-gone', 'stopped'),
    run('s-other', 'running', { action: '正在等 m 回话', workspace: ['/w/other'] }),
  ]

  const rows = (scope: SessionScope = 'all', query = ''): readonly { label: string; meta: string; group?: string }[] =>
    sessionRows({ catalog, active: 's-idle', here: HERE, runs, scope, query }).map((row) => ({
      label: row.label,
      meta: row.meta,
      ...(row.group === undefined ? {} : { group: row.group }),
    }))

  test('活跃那几段在前，头是状态；历史那一段的头是工作区', () => {
    const said = rows()
    expect(said.map((row) => row.group)).toEqual([
      '需要你',
      '执行中',
      '执行中', // 别处那条也在跑——**需要你的事跑到别的项目里，一样是需要你**
      '/w/mine',
      '/w/mine',
    ])
    expect(said.map((row) => row.label)).toEqual([
      '等你答复那条',
      '在跑那条',
      '别处那条',
      '闲下来那条',
      '停过那条',
    ])
  })

  test('副文案：活跃段说动作，历史段说状态——两段各说各的', () => {
    const said = rows()
    expect(said[0]?.meta).toBe('等你定夺：bash')
    expect(said[1]?.meta).toBe('正在跑 bash')
    // 别处那条（活跃段）：动作 ＋ **点名它是哪儿**（头只写着「执行中」，说不清是谁）
    expect(said[2]?.meta).toBe('正在等 m 回话 · other')
    expect(said[3]?.meta).toBe('当前空闲 · 正在用')
    expect(said[4]?.meta).toBe('已停止')
  })

  test('「只看本工作区」把别的项目那一段收掉（**活跃那段也一样**）', () => {
    expect(rows('here').map((row) => row.label)).toEqual([
      '等你答复那条',
      '在跑那条',
      '闲下来那条',
      '停过那条',
    ])
  })

  test('按名字筛——只剩对得上的（活跃段与历史段一起筛）', () => {
    expect(rows('all', '在跑').map((row) => row.label)).toEqual(['在跑那条'])
    expect(rows('all', '不存在')).toEqual([])
  })

  test('没有运行事实的那一条**不给状态**——不编一个「空闲」', () => {
    const bare = sessionRows({
      catalog: [session('s-plain', '没跑过那条', HERE)],
      active: null,
      here: HERE,
      runs: [],
      scope: 'all',
      query: '',
    })
    expect(bare[0]?.meta).toBe('')
    expect(bare[0]?.group).toBe('/w/mine')
  })
})

describe('U49 · 执行详情那一行', () => {
  const now = 1_000 + 192_000 // 「已跑 3 分 12 秒」

  test('当前动作 ＋ 已持续 ＋ 最近输出', () => {
    const said = runDetail(
      run('s-1', 'running', {
        since: 1_000,
        action: '正在跑 bash',
        progress: { at: 1_000, what: '开始跑 bash' },
        output: { at: 2_000, sample: 'Running 3/12\n…' },
      }),
      now,
      // 历史那一段：组头是工作区、副文案只写状态——状态与动作都得由详情带上
      { inActiveSection: false },
    )
    expect(said).toContain('执行中')
    expect(said).toContain('正在跑 bash')
    expect(said).toContain('已持续 3 分 12 秒')
    expect(said).toContain('Running 3/12')
    // 有「此刻在做的事」时**不再复述进展**（那多半就是同一件事的开头）
    expect(said).not.toContain('开始跑 bash')
  })

  test('活跃那一段：详情**只补别处没说过的**（状态在组头上、动作在副文案里）', () => {
    const row = run('s-1', 'running', { since: 1_000, action: '正在跑 bash' })
    expect(runDetail(row, now, { inActiveSection: true })).toBe('已持续 3 分 12 秒')

    // 历史那一段没有那两格——状态与动作由详情带上
    const said = runDetail(row, now, { inActiveSection: false })
    expect(said).toContain('执行中')
    expect(said).toContain('正在跑 bash')
  })

  test('「已停止」那一行的缘由**两段都带**（它是那一行唯一说得出的停点）', () => {
    const row = run('s-1', 'stopped', { since: 1_000, reason: '手动中断' })
    expect(runDetail(row, now, { inActiveSection: true })).toContain('手动中断')
  })

  test('长测试没有输出——只如实报持续时间，一个字都不说卡死', () => {
    const said = runDetail(run('s-1', 'running', { since: 1_000, action: '正在跑 bash' }), now)
    expect(said).toContain('已持续 3 分 12 秒')
    expect(said).not.toContain('输出')
    expect(said).not.toContain('卡')
  })

  test('停在哪儿、为什么停——已停止那一行带缘由', () => {
    const said = runDetail(run('s-1', 'stopped', { reason: '手动中断' }), now)
    expect(said).toContain('已停止')
    expect(said).toContain('手动中断')
  })
})

describe('U49 · 开屏那张摘要', () => {
  test('确有别的活跃工作才说，且只说一次那句话', () => {
    const said = runSummary([run('s-a', 'running'), run('s-b', 'waiting')])
    expect(said).toBe('1 项需要你 · 1 项执行中 —— /resume 看它们')
  })

  test('没有别的活跃工作 ⇒ 一个字都不说', () => {
    expect(runSummary([])).toBeUndefined()
    expect(runSummary([run('s-a', 'idle'), run('s-b', 'stopped')])).toBeUndefined()
    // **开局就接的那条不算「别的」**——用户正是为它来的
    expect(runSummary([run('s-a', 'running')], 's-a')).toBeUndefined()
  })

  test('开屏落一行回执（不是状态行那种常驻读数）', async () => {
    const stage = createStage({ runs: [run('s-a', 'running')] })
    const frame = await stage.screen(WIDE)
    expect(says(frame, '1 项执行中 —— /resume 看它们')).toBe(true)
  })

  test('一条都不活跃时屏上不多那一行', async () => {
    const stage = createStage({ runs: [run('s-a', 'idle')] })
    const frame = await stage.screen(WIDE)
    expect(says(frame, '/resume 看它们')).toBe(false)
  })
})

describe('U49 · 列表那一屏（真按键）', () => {
  const catalog = [session('s-run', '在跑那条', HERE), session('s-idle', '闲下来那条', HERE)]
  const runs = [run('s-run', 'running', { action: '正在跑 bash' }), run('s-idle', 'idle')]

  /** 开到 `/resume` 那一屏（走真按键）。 */
  async function opened(runs0 = runs) {
    const stage = createStage({ workspaceRoots: HERE, runs: runs0 })
    stage.type('/resume')
    stage.press({ kind: 'enter' })
    stage.feed([stateEvent('s-idle', catalog)])
    return stage
  }

  test('一行一条：标题 ＋ 状态（活跃段的前头是「需要你 / 执行中」）', async () => {
    const stage = await opened()
    const frame = await stage.screen(WIDE)
    expect(docked(frame, '执行中')).toBe(true)
    expect(docked(frame, '正在跑 bash')).toBe(true)
    expect(docked(frame, '当前空闲')).toBe(true)
    // 键位提示对得上键位（这一屏多两件：搜索与换范围）
    expect(says(frame, '打字筛')).toBe(true)
  })

  test('打字＝按名字筛；退格＝把筛词删回去', async () => {
    const stage = await opened()
    stage.type('在跑')
    const filtered = await stage.screen(WIDE)
    expect(docked(filtered, '筛选「在跑」')).toBe(true)
    expect(docked(filtered, '在跑那条')).toBe(true)
    expect(docked(filtered, '闲下来那条')).toBe(false)

    stage.press({ kind: 'backspace' })
    stage.press({ kind: 'backspace' })
    const back = await stage.screen(WIDE)
    expect(docked(back, '筛选')).toBe(false)
    expect(docked(back, '闲下来那条')).toBe(true)
  })

  test('`tab` 换范围——只看本工作区 / 全部，切换不关抽屉、不丢筛词', async () => {
    const stage = await opened([...runs, run('s-other', 'running', { workspace: ['/w/other'] })])
    stage.type('那条')
    stage.press({ kind: 'tab' })
    const here = await stage.screen(WIDE)
    expect(docked(here, '只看本工作区')).toBe(true)
    expect(docked(here, '筛选「那条」')).toBe(true)

    stage.press({ kind: 'tab' })
    const all = await stage.screen(WIDE)
    expect(docked(all, '只看本工作区')).toBe(false)
    expect(docked(all, '筛选「那条」')).toBe(true)
  })
})

describe('U49 · 接回的那一份「此刻」', () => {
  const snapshot: RunSnapshot = {
    watermark: 40,
    turnOpen: true,
    text: '这一段是接回来的一半',
    tools: [],
    decisions: [],
  }

  test('在飞的正文画回屏上（记录里根本没有它——流式增量不落库）', () => {
    const view = applyResume(createView(), snapshot)
    const said = view.rows.map((row) => (row.kind === 'assistant' ? row.text : ''))
    expect(said).toContain('这一段是接回来的一半')
  })

  test('在跑的工具与挂着的卡也画回去', () => {
    const view = applyResume(createView(), {
      ...snapshot,
      text: undefined,
      tools: [{ call: 7, name: 'bash', args: { cmd: 'pytest' }, at: 1_000, output: ['running…'] }],
      decisions: [
        { id: 9, call: 8, name: 'bash', material: 'rm -rf build', weight: 'heavy' },
      ],
    })

    const tool = view.rows.find((row) => row.kind === 'tool')
    expect(tool?.kind === 'tool' ? tool.state : '').toBe('running')
    // 接回时每一行**按行接**（末行后那个换行让它多出一个空尾行）——判据是**头一行对得上**
    expect(tool?.kind === 'tool' ? tool.output[0] : '').toBe('running…')
    expect(view.dock.kind).toBe('decision')
    expect(view.dock.kind === 'decision' ? view.dock.pending.id : null).toBe(9)
  })

  test('截断的那一段如实标出来（不冒充完整回复）', () => {
    const view = applyResume(createView(), { ...snapshot, text: '尾巴', textTruncated: true })
    const said = view.rows.map((row) => (row.kind === 'assistant' ? row.text : '')).join('')
    expect(said).toContain('只带了末尾')
  })

  test('画在历史**之后**——先铺记录，再叠「此刻」', async () => {
    let push: ((snapshot: RunSnapshot) => void) | undefined
    const stage = createStage({
      resumed: (listener) => {
        push = (one) => listener(1, one)
      },
    })

    // **次序照真链路**：管理者那一头是「快照先回来、记录随后铺」
    //（快照那一问排在 `session.open` 那条命令前面，见 `manager.ts` 的 `bind`）
    push?.(snapshot)

    stage.feed([
      {
        id: 1,
        session: 's-1',
        turn: null,
        at: 1,
        kind: 'session.history',
        data: {
          session: 's-1',
          entries: [{ id: 1, kind: 'user', content: { text: '我先说的那句' }, at: 0 }],
          done: true,
        },
      } as KernelEvent,
    ])

    const frame = await stage.screen(WIDE)
    expect(says(frame, '这一段是接回来的一半')).toBe(true)
    expect(frame.rowOf('这一段是接回来的一半')).toBeGreaterThan(frame.rowOf('我先说的那句'))
  })
})
