/**
 * 会话壳（缺陷轮 II 重画）——**键位语义**的判据。
 *
 * 这一层测的是「按键 → 视图 ＋ 命令」：slash 两种走法 · 接管三兜底（看得见 / 草稿不丢 /
 * 不静默吞键）· 选择器 · 重建分块。**不起 Ink**（键是喂进去的，规矩是纯的）——
 * 这正是把键位语义收进外壳的理由。
 */

import { describe, expect, test } from 'bun:test'
import type { Command, KernelEvent } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import type { ShellKey } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'

/** 起一个壳 ＋ 间谍传输。 */
function live() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)

  return {
    shell,
    spy,
    /** 敲一串字符。 */
    type(text: string) {
      for (const char of text) shell.key({ kind: 'char', char })
    },
    press(key: ShellKey) {
      return shell.key(key)
    },
    view: () => shell.getView(),
    /**
     * **屏上的全部行**（定局那侧 ＋ 本轮）——「屏上有没有这一行」的断言用它。
     *
     * ⚠️ **不含启动字标**（TUI Banner）——见 `view.test.ts` 的 `onScreen` 里那三条注
     * （原锚 / 为何变 / 新锚 同源：字标恒在 `settled[0]`，问「进了什么」时它不是「进的」）。
     */
    rows: () =>
      [...shell.getView().settled, ...shell.getView().rows].filter((row) => row.kind !== 'banner'),
    /** 仅本轮（还在流式、还会变）那些行。 */
    live: () => shell.getView().rows,
    /** 收到的命令（不含订阅动作）。 */
    commands: () => spy.commands as readonly Command[],
  }
}

const ENTER: ShellKey = { kind: 'enter' }

/** 挂一条裁决（接管）。 */
function ask(shell: ReturnType<typeof live>, weight: 'light' | 'heavy' = 'light'): void {
  shell.spy.emit(
    event('tool.decision.request', { call: 71, name: 'exec', material: '命令 ls', weight }, { id: 88 }),
  )
}

// ══ 交代 ═════════════════════════════════════════════════════════════

describe('交代（输入 → input.submit）', () => {
  test('打字落进草稿；回车发出并本地回显', () => {
    const app = live()

    app.type('看下目录')
    expect(app.view().draft).toBe('看下目录')

    app.press(ENTER)
    expect(app.commands()).toEqual([{ type: 'input.submit', text: '看下目录' }])
    expect(app.rows().at(-1)).toMatchObject({ kind: 'user', text: '看下目录' })
    expect(app.view().draft).toBe('')
  })

  test('空白不发命令、不清屏', () => {
    const app = live()

    app.press(ENTER)
    expect(app.commands()).toEqual([])
    expect(app.rows()).toEqual([])
  })

  test('退格删一个字符；esc 清草稿（有草稿时不清展开位）', () => {
    const app = live()

    app.type('abc')
    app.press({ kind: 'backspace' })
    expect(app.view().draft).toBe('ab')

    app.press({ kind: 'escape' })
    expect(app.view().draft).toBe('')
  })

  test('`↑` 取上一条交代；`ctrl+o` 切展开位', () => {
    const app = live()

    app.type('第一条')
    app.press(ENTER)
    app.type('第二条')
    app.press(ENTER)
    app.press({ kind: 'up' })
    expect(app.view().draft).toBe('第二条')
    app.press({ kind: 'up' })
    expect(app.view().draft).toBe('第一条')

    expect(app.view().expanded).toBe(false)
    app.press({ kind: 'ctrl+o' })
    expect(app.view().expanded).toBe(true)
  })
})

// ══ slash 两种走法 ═══════════════════════════════════════════════════

describe('slash（纯输出型 / 交互配置型）', () => {
  test('`/help`——输出进记录区，**命令本身不回显**、不发命令', () => {
    const app = live()

    app.type('/help')
    app.press(ENTER)

    expect(app.commands()).toEqual([])
    expect(app.rows()).toHaveLength(1)
    expect(app.rows()[0]).toMatchObject({ kind: 'output' })
    // 记录区里**没有** `› /help` 那一行（操作不混进对话）
    expect(app.rows().some((row) => row.kind === 'user')).toBe(false)
  })

  test('`/session`——记录区什么都不进，只发 `session.list`', () => {
    const app = live()

    app.type('/session')
    app.press(ENTER)

    expect(app.commands()).toEqual([{ type: 'session.list' }])
    expect(app.rows()).toEqual([])
  })

  test('`/model <条目>`——直接发换模型，不进记录区', () => {
    const app = live()

    app.type('/model minimax-m2')
    app.press(ENTER)

    expect(app.commands()).toEqual([{ type: 'model.switch', provider: 'minimax-m2' }])
    expect(app.rows()).toEqual([])
  })

  /**
   * 不认得的 slash——**如实说一句**（不发命令、也不当交代发出去）。
   *
   * ⚠️ **原锚是 `/grants`**（那时内核还没有它，它正是「不认得」的那个例子）。
   * `U22` 到站后 `/grants` **真存在了**，故换一个**真的不认得**的（`/nope`）——
   * 判据本身（说一句、不发命令）一字不改，换的只是那件道具。
   */
  test('不认得的 slash——**如实说一句**（不发命令、也不当交代发出去）', () => {
    const app = live()

    app.type('/nope')
    app.press(ENTER)

    expect(app.commands()).toEqual([])
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt' })
  })

  /**
   * **命令表里的每一条按下去都有归处**（原型 · 场景 11 的自律：列一个按下去会报错的，
   * 比不列更坏）。
   *
   * 原锚是一条**逐命令点名**的快照式断言（「`/grants` 内核还没有，不列」）——那种写法
   * 每加一条命令都要人去改测试，而**自律本身**（表里列的＝真认得的）反倒没人钉。
   * 这里改成**遍历命令表**：新加一条命令而 `runSlash` 没接，这条用例当场红。
   */
  test('命令表里的每一条**都认得**——按下去不会得到「不认得的命令」', async () => {
    const { COMMANDS } = await import('../src/view.ts')

    for (const command of COMMANDS) {
      const app = live()
      app.type(command.name)
      app.press(ENTER)

      const last = app.rows().at(-1)
      const said = last?.kind === 'receipt' ? last.text : ''
      expect(said, command.name).not.toContain('不认得的命令')
    }
  })
})

// ══ 接管 ═════════════════════════════════════════════════════════════

describe('接管（裁决挂着时占住输入框）', () => {
  test('作答 `y` —— 发一次答复，带请求事件 id', () => {
    const app = live()
    ask(app)

    app.press({ kind: 'char', char: 'y' })
    expect(app.commands()).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])
  })

  test('作答 `a` ——「总是允许」带上 remember 位（轻的那件）', () => {
    const app = live()
    ask(app, 'light')

    app.press({ kind: 'char', char: 'a' })
    expect(app.commands()).toEqual([
      { type: 'decision.answer', id: 88, decision: 'approve', remember: true },
    ])
  })

  test('必闸类按 `a` ——**不发命令**，当场说清缘由', () => {
    const app = live()
    ask(app, 'heavy')

    app.press({ kind: 'char', char: 'a' })
    expect(app.commands()).toEqual([])
    expect(app.view().flash).toContain('必闸类不可')
  })

  test('**草稿不丢**——接管时收起来、答完原样归还、不自动发送', () => {
    const app = live()

    app.type('打了一半')
    ask(app)
    expect(app.view().draft).toBe('')
    expect(app.view().stashed).toBe('打了一半')

    app.press({ kind: 'char', char: 'y' })
    // 答复发出去；**裁决落定那一刻**（内核回 `tool.decision`）才归还草稿
    expect(app.commands()).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])
    expect(app.view().dock.kind).toBe('decision')

    app.spy.emit(event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 900 }))
    expect(app.view().draft).toBe('打了一半')
    expect(app.view().stashed).toBeNull()
    expect(app.view().dock.kind).toBe('input')
    // **不自动发送**——归还的草稿仍在输入框里，没被发出去
    expect(app.commands()).toHaveLength(1)
  })

  test('**不静默吞键**——按了别的字，忽略但当场说一句', () => {
    const app = live()
    ask(app)

    app.press({ kind: 'char', char: 'x' })
    expect(app.commands()).toEqual([])
    expect(app.view().flash).toContain('先答复')
    expect(app.view().draft).toBe('') // 那一下没有进草稿
  })

  test('粘贴一律拒并提示；`esc` **无动作**', () => {
    const app = live()
    ask(app)

    app.press({ kind: 'paste', text: '粘一段' })
    expect(app.view().draft).toBe('')
    expect(app.view().flash).toContain('粘不了')

    app.press({ kind: 'escape' })
    expect(app.view().dock.kind).toBe('decision') // 还在接管里
  })

  test('多件逐件问——答完一件接着下一件，草稿一直收着', () => {
    const app = live()

    app.type('草稿')
    ask(app)
    app.press({ kind: 'char', char: 'y' })

    // 第二件到（内核接着问）
    app.spy.emit(
      event('tool.decision.request', { call: 72, name: 'write', material: 'm', weight: 'light' }, { id: 89 }),
    )
    expect(app.view().dock.kind).toBe('decision')
    expect(app.view().stashed).toBe('草稿') // 只收一次

    app.press({ kind: 'char', char: 'n' })
    app.spy.emit(event('tool.decision', { call: 72, decision: 'reject', decider: 'user', elapsedMs: 100 }))
    expect(app.view().draft).toBe('草稿')
  })
})

// ══ 选择器 ═══════════════════════════════════════════════════════════

describe('选择器（`/session` · `/model`）', () => {
  const state = (active: string, rows: readonly { id: string; title?: string }[]) =>
    event('session.state', {
      active,
      sessions: rows.map((row) => ({ id: row.id, at: 0, ...(row.title === undefined ? {} : { title: row.title }) })),
    })

  test('`/session` 回车后：目录到手才开选择器，记录区仍不进东西', () => {
    const app = live()

    app.type('/session')
    app.press(ENTER)
    app.spy.emit(state('s1', [{ id: 's1', title: '甲的事' }, { id: 's2', title: '乙的事' }]))

    expect(app.view().dock.kind).toBe('picker')
    expect(app.rows()).toEqual([])
  })

  test('上下选 ＋ 回车选定 —— 发 `session.open`，**留一行回执**', () => {
    const app = live()

    app.type('/session')
    app.press(ENTER)
    app.spy.emit(state('s1', [{ id: 's1', title: '甲的事' }, { id: 's2', title: '乙的事' }]))
    app.press({ kind: 'down' })
    app.press(ENTER)

    expect(app.commands()).toContainEqual({ type: 'session.open', session: 's2' })
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt' })
    expect(app.view().dock.kind).toBe('input')
  })

  test('`esc` 取消 —— **不留痕迹**（记录区与回执都没有）', () => {
    const app = live()

    app.type('/session')
    app.press(ENTER)
    app.spy.emit(state('s1', [{ id: 's1' }]))
    app.press({ kind: 'escape' })

    expect(app.view().dock.kind).toBe('input')
    expect(app.rows()).toEqual([])
  })

  /**
   * ⚠️ **本条 2026-09-19 改过**（阶段 3 批 2 · 接 D10 的读数）——原锚钉的是**当时的形状**
   * （发空参的 `model.switch`、拿**失败缘由**当列表说明）。
   *
   * - **原锚**：`command: model.switch`（空参）＋ `model.switched{ok:false}` 开选择器；
   * - **规格为什么变**：D10 立了**读侧命令** `model.list`（答复 `model.catalog`，**不落库**），
   *   并给了**注册表全量**——契约注里明写这条与 `model.switch` 的分工：「读面不该以
   *   『换失败了』作答，也不该因此落库一笔」；
   * - **新锚**：`/model` 不带参数 ⇒ 发 `model.list`；答复 `model.catalog` 开选择器，
   *   列表＝**全量**（含这趟会话从未调用过的条目）。
   */
  test('`/model` 不带参数 —— **问一次条目表**（读侧命令），答复开选择器', () => {
    const app = live()

    app.type('/model')
    app.press(ENTER)
    expect(app.commands()).toContainEqual({ type: 'model.list' })
    // **不是**换模型：读面以「换失败了」作答是旧形状（见上）
    expect(app.commands()).not.toContainEqual({ type: 'model.switch' })

    app.spy.emit(
      event('model.catalog', {
        entries: [
          { provider: 'minimax', model: 'MiniMax-M3' },
          { provider: 'local', model: 'qwen3' },
        ],
        current: { provider: 'minimax', model: 'MiniMax-M3' },
      }),
    )

    expect(app.view().dock.kind).toBe('picker')
    const dock = app.view().dock
    // **全量**——两条都列出来，哪怕这趟会话一条都没调用过
    expect(dock.kind === 'picker' ? dock.picker.rows.map((row) => row.label) : []).toEqual([
      'minimax',
      'local',
    ])
  })

  /**
   * 阶段 3 批 2 · **顺序判据**（接 D10 的读数时查出来的）。
   *
   * 钉的规格＝「先接订阅、后放开输入」那条**顺序纪律**在「命令 → 答复」这一跳上的另一面：
   * 答复可能在 `send` **之内**就回来——进程内传输是**直连**的（`createInProcessTransportPair`
   * 的 `send` 直接 publish）。故提交 slash 必须**先落地、后发命令**：反过来，外层那次
   * **基于旧快照**的 `commit` 会把答复刚写进视图的东西**整个盖掉**。
   *
   * ⚠️ 判据必须**同步应答**才咬得住——在回车**之后**再投答复是模拟异步回话，那样旧实现也绿。
   * （既有那几条正是那么写的，所以这个缺陷在真机上活了下来：`/model` 的选择器**一直开不出来**，
   * `model.catalog` 到了、`view.models` 也写上了，随即被盖回输入区。）
   */
  test('答复**在 `send` 之内**同步回来时，`/model` 的选择器照样开（顺序）', () => {
    const commands: Command[] = []
    const listeners: ((event: KernelEvent) => void)[] = []
    const transport = {
      send: (command: Command) => {
        commands.push(command)
        // **同步应答**——进程内传输的真样子（直连，不经队列）
        if (command.type === 'model.list') {
          const reply = event('model.catalog', {
            entries: [
              { provider: 'minimax', model: 'MiniMax-M3', contextWindow: 200_000 },
              { provider: 'minimax-m2', model: 'MiniMax-M2' },
            ],
            current: { provider: 'minimax', model: 'MiniMax-M3' },
          })
          for (const listener of [...listeners]) listener(reply)
        }
      },
      subscribe: (listener: (event: KernelEvent) => void) => {
        listeners.push(listener)
        return () => {}
      },
    }

    const shell = createShell(transport as never)
    for (const char of '/model') shell.key({ kind: 'char', char })
    shell.key({ kind: 'enter' })

    const view = shell.getView()

    expect(commands.map((command) => command.type)).toEqual(['model.list'])
    expect(view.dock.kind).toBe('picker') // **没被盖回输入区**
    expect(view.models).toHaveLength(2) // 条目表留住了
    expect(view.status.window).toBe(200_000) // ④ 的分母也留住了
  })
})

// ══ Ctrl+C ═══════════════════════════════════════════════════════════

describe('Ctrl+C（空闲退出 · 工作中中断）', () => {
  test('空闲 ⇒ 退出（交回组件去退）；工作中 ⇒ 发 `turn.interrupt`，不退', () => {
    const idle = live()
    expect(idle.press({ kind: 'ctrl+c' }).exit).toBe(true)

    const busy = live()
    busy.spy.emit(event('turn.start', {}))
    expect(busy.press({ kind: 'ctrl+c' }).exit).toBe(false)
    expect(busy.commands()).toEqual([{ type: 'turn.interrupt' }])
  })

  test('接管中按 Ctrl+C ⇒ 中断本轮（全局键，接管不吞）', () => {
    const app = live()
    ask(app)

    expect(app.press({ kind: 'ctrl+c' }).exit).toBe(false)
    expect(app.commands()).toEqual([{ type: 'turn.interrupt' }])
  })
})

// ══ 重建 ═════════════════════════════════════════════════════════════

describe('重建（`session.history` 分块）', () => {
  const entry = (id: number, text: string) => ({ id, kind: 'user' as const, content: { text }, at: id })

  test('分块攒、`done` 到了才铺屏；条目按序成行', () => {
    const app = live()

    app.spy.emit(state1('s1'))
    app.spy.emit(event('session.history', { session: 's1', entries: [entry(1, '第一句')], done: false }))
    expect(app.rows()).toEqual([]) // 还没收齐——不铺

    app.spy.emit(event('session.history', { session: 's1', entries: [entry(2, '第二句')], done: true }))
    expect(app.rows().map((row) => row.kind === 'user' && row.text)).toEqual(['第一句', '第二句'])
  })

  test('**不是当下那条的块直接丢**（分块会跨切换）', () => {
    const app = live()

    app.spy.emit(state1('s1'))
    app.spy.emit(event('session.history', { session: '别的会话', entries: [entry(9, '不该出现')], done: true }))

    expect(app.rows()).toEqual([])
  })

  test('切换 ⇒ 主动读一次历史（重建由那次触发）', () => {
    const app = live()

    app.spy.emit(state1('s1'))
    app.spy.emit(event('session.state', { active: 's2', sessions: [{ id: 's2', at: 0 }] }))

    expect(app.commands()).toContainEqual({ type: 'history.read', session: 's2' })
  })
})

function state1(active: string) {
  return event('session.state', { active, sessions: [{ id: active, at: 0 }] })
}

// ══ 补：会话命令与粘贴的其余分支 ═════════════════════════════════════

describe('会话命令的其余分支', () => {
  test('`/session new`——发 `session.new` ＋ 留一行回执', () => {
    const app = live()

    app.type('/session new')
    app.press(ENTER)

    expect(app.commands()).toEqual([{ type: 'session.new' }])
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt' })
  })

  test('`/session title <文本>`——发 `session.rename`（带上当下那条的 id）', () => {
    const app = live()
    app.spy.emit(
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] }),
    )

    app.type('/session title 换个名字')
    app.press(ENTER)

    expect(app.commands()).toEqual([{ type: 'session.rename', session: 's1', title: '换个名字' }])
  })

  test('`/session title` 不带文本——只提示用法，不发命令', () => {
    const app = live()

    app.type('/session title')
    app.press(ENTER)

    expect(app.commands()).toEqual([])
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt' })
  })

  test('`/session <不认得>`——如实说一句，不发命令', () => {
    const app = live()

    app.type('/session 乱写的')
    app.press(ENTER)

    expect(app.commands()).toEqual([])
    expect(app.rows().at(-1)?.kind === 'receipt').toBe(true)
  })
})

describe('粘贴（非接管）', () => {
  test('落进草稿——不当作按键序列', () => {
    const app = live()

    app.press({ kind: 'paste', text: '粘一段' })
    expect(app.view().draft).toBe('粘一段')

    app.press(ENTER)
    expect(app.commands()).toEqual([{ type: 'input.submit', text: '粘一段' }])
  })
})

describe('选择器选定模型', () => {
  test('选定 ⇒ 发 `model.switch`（回执由内核的 `model.switched` 给）', () => {
    const app = live()
    app.spy.emit(event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }))

    app.type('/model')
    app.press(ENTER)
    // 条目表回来了才开选择器（D10 的读侧答复）——选定那一步与入口无关，故这条判据不变
    app.spy.emit(
      event('model.catalog', {
        entries: [{ provider: 'minimax', model: 'MiniMax-M3' }],
        current: { provider: 'minimax', model: 'MiniMax-M3' },
      }),
    )
    app.press(ENTER) // 选定当前那一条

    expect(app.commands()).toContainEqual({ type: 'model.switch', provider: 'minimax' })
    expect(app.view().dock.kind).toBe('input')
  })
})
