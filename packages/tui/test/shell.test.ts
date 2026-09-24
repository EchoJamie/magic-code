/**
 * 会话壳（缺陷轮 II 重画）——**键位语义**的判据。
 *
 * 这一层测的是「按键 → 视图 ＋ 命令」：slash 两种走法 · 接管三兜底（看得见 / 草稿不丢 /
 * 不静默吞键）· 选择器 · 重建分块。**不起 Ink**（键是喂进去的，规矩是纯的）——
 * 这正是把键位语义收进外壳的理由。
 */

import { describe, expect, test } from 'bun:test'
import type { Command, KernelEvent, SessionId, StopPhase, StopScope } from '@magic/contracts'
import type { StopReport } from '../src/shell.ts'
import { createShell } from '../src/shell.ts'
import type { ShellKey, ShellOptions } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'

/** 起一个壳 ＋ 间谍传输（`options` 给「停止那条线」这类外部来路——缺省＝一个都不接）。 */
function live(options: ShellOptions = {}) {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, options)

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

/**
 * **打 `/` 那一下，外壳先问一次技能目录**（U33）——`skills.list`。
 *
 * 为什么要问：输入行的候选要按技能名筛（`/ui` 能认出 `/ui-review`），而技能目录在外壳
 * 够不着的那一头，只能问（见 `shell.ts` 的 `askSkills`）。**每屏只问一次**，故它出现在
 * 「这一下发了什么命令」那些判据的**最前面**——它不是被测那一跳发的，别把它记在那一跳账上。
 *
 * 下面凡是有 `ASK_SKILLS` 的地方，判据说的都是「除这次目录查询之外」的命令序列。
 */
const ASK_SKILLS: Command = { type: 'skills.list' }

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
    // `ref` ＝ 提交的配对键（U33）：`input.settled` 按它认回这份草稿（失败时原样还回来）
    expect(app.commands()).toEqual([{ type: 'input.submit', text: '看下目录', ref: 'draft-1' }])
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

    // **`/help` 本身一条都不发**——列里那一条是打 `/` 时那次目录查询（见 `ASK_SKILLS`）
    expect(app.commands()).toEqual([ASK_SKILLS])
    expect(app.rows()).toHaveLength(1)
    expect(app.rows()[0]).toMatchObject({ kind: 'output' })
    // 记录区里**没有** `› /help` 那一行（操作不混进对话）
    expect(app.rows().some((row) => row.kind === 'user')).toBe(false)
  })

  test('`/resume`——记录区什么都不进，只发 `session.list`', () => {
    const app = live()

    app.type('/resume')
    app.press(ENTER)

    expect(app.commands()).toEqual([ASK_SKILLS, { type: 'session.list' }])
    expect(app.rows()).toEqual([])
  })

  test('`/model refresh [连接]`——刷新意图，不进记录区', () => {
    // **原锚**：`/model <条目>` ＝ 直接发一条 `model.switch { provider }`（换到那个条目）。
    // **为何变**（U41 · 2026-09-23）：列表的取材从「配置条目」换成「模型」，同一个词
    //   现在既可能是连接也可能是模型——按字面猜一个再切过去，猜错就是「换到了另一个
    //   模型上」而用户以为只是敲了个名字。故那条直达**取消**，`/model` 后面改认**子动作**
    //   （`refresh` / `connect` / `manage`——设计：三个动作沿 `/model` 展开）。
    // **新锚**：`/model refresh` 发刷新意图；带不带连接各一条（缺省＝当前那条连接）。
    const app = live()

    app.type('/model refresh')
    app.press(ENTER)

    expect(app.commands()).toEqual([ASK_SKILLS, { type: 'model.refresh' }])
    expect(app.rows()).toEqual([])
  })

  test('`/model <不认得的词>`——如实说一句（不猜、不当交代发出去）', () => {
    const app = live()

    app.type('/model minimax-m2')
    app.press(ENTER)

    expect(app.commands()).toEqual([ASK_SKILLS])
    expect(app.rows().some((row) => row.kind === 'receipt')).toBe(true)
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

    // 目录查询那一条不算它发的（见 `ASK_SKILLS`）；`/nope` 自身一条都不发
    expect(app.commands()).toEqual([ASK_SKILLS])
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

  test('外部操作按 `a`（U38）——**不发命令**，缘由按它自己的说法（效果由服务器决定）', () => {
    const app = live()
    app.spy.emit(
      event(
        'tool.decision.request',
        { call: 71, name: 'fake / echo', material: '参数：{}', weight: 'heavy', external: true },
        { id: 88 },
      ),
    )

    app.press({ kind: 'char', char: 'a' })
    expect(app.commands()).toEqual([])
    expect(app.view().flash).toContain('外部操作不可「总是允许」')
    // 说清「这次批的是哪一件」：`y` 在外部件上答的是**这一次**，不是本机的一条长期授权。
    // **原锚**「按 y 批准这一次」（带键位写法）；**为何变**（返工 B）：一屏键位只说一次，
    // 卡上已经写着键位，回执里就不再列一遍；**新锚**只说「只能批准这一次」这件事本身。
    expect(app.view().flash).toContain('只能批准这一次')
  })

  test('**草稿不丢**——接管时收起来、答完原样归还、不自动发送', () => {
    const app = live()

    app.type('打了一半')
    ask(app)
    expect(app.view().draft).toBe('')
    // 草稿**连同插入点与它里面的引用**一起收着（返工轮：插入点不再一律摆到末尾；
    // U36：引用也是那份草稿的一部分——归还时少一件就是把用户的草稿改掉了一半，见 `Stashed`）
    expect(app.view().stashed).toEqual({ draft: '打了一半', caret: 4, refs: [] })

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
    expect(app.view().stashed).toEqual({ draft: '草稿', caret: 2, refs: [] }) // 只收一次

    app.press({ kind: 'char', char: 'n' })
    app.spy.emit(event('tool.decision', { call: 72, decision: 'reject', decider: 'user', elapsedMs: 100 }))
    expect(app.view().draft).toBe('草稿')
  })
})

// ══ 选择器 ═══════════════════════════════════════════════════════════

describe('选择器（`/resume` · `/model`）', () => {
  const state = (active: string, rows: readonly { id: string; title?: string }[]) =>
    event('session.state', {
      active,
      sessions: rows.map((row) => ({ id: row.id, at: 0, ...(row.title === undefined ? {} : { title: row.title }) })),
    })

  test('`/resume` 回车后：目录到手才开选择器，记录区仍不进东西', () => {
    const app = live()

    app.type('/resume')
    app.press(ENTER)
    app.spy.emit(state('s1', [{ id: 's1', title: '甲的事' }, { id: 's2', title: '乙的事' }]))

    expect(app.view().dock.kind).toBe('picker')
    expect(app.rows()).toEqual([])
  })

  /**
   * 选定之后**不再当场发回执**（U44）——回执挪到**答复**那一侧。
   *
   * 由头：换会话要**翻页**（清可见屏），而清屏发生在「页号一变」那一瞬——选定那一刻写下的
   * 字会被一并推进 scrollback，新那一页的界上就没有它了。故这里连着判两跳：
   * **选定＝发命令 ＋ 收起抽屉**（还没回执）→ **答复到了＝留回执**。
   */
  test('上下选 ＋ 回车选定 —— 发 `session.open`；**回执等答复到了才留**', () => {
    const app = live()

    app.type('/resume')
    app.press(ENTER)
    app.spy.emit(state('s1', [{ id: 's1', title: '甲的事' }, { id: 's2', title: '乙的事' }]))
    app.press({ kind: 'down' })
    app.press(ENTER)

    expect(app.commands()).toContainEqual({ type: 'session.open', session: 's2' })
    expect(app.view().dock.kind).toBe('input')
    // 还没答复：一个字都不许说（说了就是「切过去」这句谎话先落地）
    expect(app.rows().some((row) => row.kind === 'receipt')).toBe(false)

    // 答复到了（活跃位真换了）⇒ 留一行，且**带上那条的名字**（不是拿 id 顶上）
    app.spy.emit(state('s2', [{ id: 's1', title: '甲的事' }, { id: 's2', title: '乙的事' }]))
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt', text: '已切到 乙的事' })
  })

  test('选的是**当下这条**——当场回执，不发命令（内核那一侧本就不发事件）', () => {
    const app = live()

    app.type('/resume')
    app.press(ENTER)
    app.spy.emit(state('s1', [{ id: 's1', title: '甲的事' }, { id: 's2', title: '乙的事' }]))
    app.press(ENTER) // 光标起点就是当下这条

    expect(app.commands()).not.toContainEqual(expect.objectContaining({ type: 'session.open' }))
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt', text: '已切到 甲的事' })
  })

  /** 内核忙时切不动（`BUSY_NOTE`）——**不说「已切到」**，照内核那句说（U44 接上 `note`）。 */
  test('答复带 `note`（切不动）——留的是那句 note，不冒「已切到」', () => {
    const app = live()

    app.type('/resume')
    app.press(ENTER)
    app.spy.emit(state('s1', [{ id: 's1', title: '甲的事' }, { id: 's2', title: '乙的事' }]))
    app.press({ kind: 'down' })
    app.press(ENTER)

    app.spy.emit(
      event('session.state', {
        active: 's1',
        sessions: [{ id: 's1', at: 0, title: '甲的事' }],
        note: '正在跑一轮——先 Ctrl+C 中断，再切会话（同一时刻只有一个活跃会话）',
      }),
    )

    const last = app.rows().at(-1)
    expect(last).toMatchObject({ kind: 'receipt' })
    expect(last?.kind === 'receipt' ? last.text : '').toContain('正在跑一轮')
    expect(app.rows().some((row) => row.kind === 'receipt' && row.text.startsWith('已切到'))).toBe(false)
  })

  test('`esc` 取消 —— **不留痕迹**（记录区与回执都没有）', () => {
    const app = live()

    app.type('/resume')
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
    // **全量**——两条都列出来，哪怕这趟会话一条都没调用过。
    // **原锚**：行 ＝ 连接（`label` 是 `minimax` / `local`）。
    // **为何变**（U41）：一行改报**模型**（设计：「行主文案为模型名，副文案为供应商/连接名」）
    //   ——连接名挪到副文案那一格。
    // **新锚**：行的主文案是各自的默认模型，副文案里带着连接名。
    // **再原锚一次**（U41 返修）：列表末尾现在还常驻着几条**入口行**（连接供应商 /
    // 管理连接 / 刷新模型）——它们不是「有哪些模型」，故这一条只看 `pick` 有值的那些行。
    const rows = dock.kind === 'picker' ? dock.picker.rows.filter((row) => row.pick !== undefined) : []
    expect(rows.map((row) => row.label)).toEqual(['MiniMax-M3', 'qwen3'])
    // 副文案**以连接名打头**（其后可能还有别的话——如「不在最近一次列表里」）；
    // 断「打头」而不是断整串：那些尾巴是有内容的判据，另外几条在 `spec.u41.test.ts` 里咬
    expect(rows.map((row) => row.meta.split(' · ')[0])).toEqual(['minimax', 'local'])
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
              { provider: 'minimax', model: 'MiniMax-M3' },
              { provider: 'minimax-m2', model: 'MiniMax-M2' },
            ],
            current: { provider: 'minimax', model: 'MiniMax-M3' },
            // 分母随答复来（U41 返修：按 `current` 算的那一格，不从默认行推算）
            currentInputBudget: 200_000,
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

    // 头一条是打 `/` 时那次目录查询（见 `ASK_SKILLS`）；被测的是**它的答复与 `model.list`
    // 的答复都在 `send` 之内同步回来**时，视图有没有被盖回去
    expect(commands.map((command) => command.type)).toEqual(['skills.list', 'model.list'])
    expect(view.dock.kind).toBe('picker') // **没被盖回输入区**
    expect(view.models).toHaveLength(2) // 条目表留住了
    // ④ 的分母也留住了——**数值来自答复那一格**（U41 返修：按 `current` 算，不从默认行推算）
    expect(view.status.window).toBe(200_000)
  })
})

// ══ Ctrl+C ═══════════════════════════════════════════════════════════

describe('Ctrl+C（空闲按两次退出 · 工作中中断）', () => {
  test('空闲第一下**不退出**——只把那一行挂上；第二下才走', () => {
    const idle = live()

    expect(idle.press({ kind: 'ctrl+c' }).exit).toBe(false)
    expect(idle.view().exitArmed).toBe(true) // 那一行挂上了（画不画是渲染层的事）

    expect(idle.press({ kind: 'ctrl+c' }).exit).toBe(true) // 第二下：交回组件去退
    expect(idle.commands()).toEqual([]) // 两下都没惊动内核
  })

  test('两下之间**敲一个字** ⇒ 那一行撤掉，且「再按一次」不作数了（要重新按两下）', () => {
    const idle = live()

    idle.press({ kind: 'ctrl+c' })
    idle.type('甲') // 用户又不想走了
    expect(idle.view().exitArmed).toBe(false)
    expect(idle.view().draft).toBe('甲') // 那一个字正常落进草稿

    // 那一下**不作数**：再按一次只是重新挂上，不是退出
    expect(idle.press({ kind: 'ctrl+c' }).exit).toBe(false)
    expect(idle.view().exitArmed).toBe(true)
    expect(idle.press({ kind: 'ctrl+c' }).exit).toBe(true)
  })

  test('两下之间**别的键**（`esc` 这类不落草稿的）同样把它撤掉', () => {
    const idle = live()

    idle.press({ kind: 'ctrl+c' })
    idle.press({ kind: 'escape' })

    expect(idle.view().exitArmed).toBe(false)
    expect(idle.press({ kind: 'ctrl+c' }).exit).toBe(false) // 又从第一下起算
  })

  test('挂上之后这一轮又跑起来了 ⇒ 那一下是**中断**，不是「第二次按」（门也当场撤掉）', () => {
    // ⚠️ 常态下够不着（提交那一跳是按键，已经把门撤了）；够得着的情形是「恢复跑出在途
    //    那一轮」——第一下按在恢复跑完之前。这一条钉的是：真碰上了也**不许**直接退出。
    const app = live()
    app.press({ kind: 'ctrl+c' })
    app.spy.emit(event('turn.start', {}))
    expect(app.view().exitArmed).toBe(true) // 起手挂上的那一下还在

    expect(app.press({ kind: 'ctrl+c' }).exit).toBe(false) // 中断，不退
    expect(app.view().exitArmed).toBe(false)
    expect(app.commands()).toEqual([{ type: 'turn.interrupt' }])
  })

  test('工作中按 Ctrl+C ⇒ 只发中断，不退（与改前一致）', () => {
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

// ══ `/exit`（U52）══════════════════════════════════════════════════════

/**
 * **`/exit` 一次就走**（设计 · 命令行与配置的会话入口表 ＋ 会话与运行管理的
 * 「离开、停止与异常退出」）。
 *
 * 那三条判据的由来：**「按两次」那条规矩针对的是 Ctrl+C 这个随手按的键**（它在
 * 「工作中＝中断／空闲＝退出」之间跳，用户没法预期）；`/exit` 是**打出来的词**，
 * 本来就已经是「有意的」。故它**不挂 `exitArmed`**——那一格是给 Ctrl+C 的。
 *
 * ⚠️ **它退的方式与 Ctrl+C 不同**（2026-09-24 用户裁）：`/exit`＝**停掉当前这条会话，
 * 资源确认退出之后才退界面**；Ctrl+C 两次＝**只离开**，工作继续。故下面这组用例判的是
 * **两跳**：敲下去那一跳只把停止的意图发出去（**不退**），等 `done` 到了才放行。
 */
describe('/exit（停掉这条会话，然后退出界面）', () => {
  /** 打一整条 slash 并回车——回的是**回车那一下**的效果。 */
  function run(app: ReturnType<typeof live>, text: string) {
    app.type(text)
    return app.press(ENTER)
  }

  /** 一条会话在场（`session.state` 把活跃位定下来）。 */
  function withSession(app: ReturnType<typeof live>, id = 's1'): void {
    app.spy.emit(event('session.state', { active: id, sessions: [{ id, at: 0, title: '甲的事' }] }))
  }

  /**
   * **停止那条线的假来路**（U50 的形：`stop` 发意图、`stopped` 回报告）。
   *
   * 它就是外壳与「本机管理者」之间的那两格——用例据此**按拍子**把报告喂回去，
   * 判「等到了没有」。
   */
  function stopWire() {
    const asked: { readonly session: string; readonly scope: StopScope }[] = []
    let report: ((one: StopReport) => void) | undefined

    return {
      asked,
      stop: (session: SessionId, scope: StopScope) => {
        asked.push({ session, scope })
      },
      stopped: (listener: (one: StopReport) => void) => {
        report = listener
      },
      /** 管理者回一拍（`accepted` / `done` / `unconfirmed`）——缺省是整体那一档。 */
      tell: (session: string, phase: StopPhase, extra: { scope?: StopScope; note?: string } = {}) =>
        report?.({
          session,
          scope: extra.scope ?? 'run',
          phase,
          ...(extra.note === undefined ? {} : { note: extra.note }),
        }),
    }
  }

  test('敲下去 ⇒ **发一条整体停止**（当前这条会话），**当场不退**', () => {
    const wire = stopWire()
    const app = live({ stop: wire.stop, stopped: wire.stopped })
    withSession(app)

    expect(run(app, '/exit').exit).toBe(false) // 不走 ShellEffect.exit 那条（那是不等的路）
    expect(app.view().leaving).toBe(false) // 也还没到「可以走了」
    expect(app.view().exitArmed).toBe(false) // 门是给 ctrl+c 的，这一条不走它

    // **整体那一档**（「停这件事」）——不是 `turn`：`/exit` 说的是「这条我不做了」
    expect(wire.asked).toEqual([{ session: 's1', scope: 'run' }])
    // 这一条**不发** `turn.interrupt`（那是局部那一档的事），目录查询那一条是打 `/` 发的
    expect(app.commands()).toEqual([ASK_SKILLS])
  })

  test('**受理了还不走**——`done` 到了才放行（「资源确认退出之后」）', () => {
    const wire = stopWire()
    const app = live({ stop: wire.stop, stopped: wire.stopped })
    withSession(app)
    run(app, '/exit')

    wire.tell('s1', 'accepted')
    // 这一拍只是「受理」——此刻走出门就是「发出去就走」，正是设计防的那件事
    expect(app.view().leaving).toBe(false)
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt', text: '正在停「甲的事」' })

    wire.tell('s1', 'done')
    expect(app.view().leaving).toBe(true) // 可以走了（界面那一层看着这一格收摊）
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt', text: '「甲的事」停了' })
  })

  test('**停不掉**：如实说「没能停掉…」，**也照样放行**（不把用户卡在这儿）', () => {
    const wire = stopWire()
    const app = live({ stop: wire.stop, stopped: wire.stopped })
    withSession(app)
    run(app, '/exit')

    wire.tell('s1', 'accepted')
    wire.tell('s1', 'unconfirmed', { note: '那一个进程认不出归属——一个信号都没发' })

    expect(app.rows().at(-1)).toMatchObject({
      kind: 'receipt',
      text: '没能停掉「甲的事」：那一个进程认不出归属——一个信号都没发',
    })
    // **不谎称已停**（那一行说的是「没能停掉」）· **也不把用户卡住**：要只离开，
    // 另一扇门（Ctrl+C 两次）一直开着，而实话已经落进 scrollback 了
    expect(app.view().leaving).toBe(true)
  })

  test('**别的报告不放行**——别的会话 / 局部那一档都与我这一趟无关', () => {
    const wire = stopWire()
    const app = live({ stop: wire.stop, stopped: wire.stopped })
    withSession(app)
    run(app, '/exit')

    wire.tell('s2', 'done') // 别的窗口停的 —— 与我这一趟无关
    expect(app.view().leaving).toBe(false)

    // 同一会话、但**局部**那一档（`turn`）——那不是「这条停了」（那条运行还在）
    wire.tell('s1', 'done', { scope: 'turn' })
    expect(app.view().leaving).toBe(false)

    // 正等的那一条、那一档来了才放行
    wire.tell('s1', 'accepted')
    expect(app.view().leaving).toBe(false)
    wire.tell('s1', 'done')
    expect(app.view().leaving).toBe(true)
  })

  /**
   * **首条消息正跑着的那几百毫秒**（U52 在真 PTY 上撞到的）：这一轮在跑，而外壳手上
   * **还没有会话 id**（`session.state` 那一声答复还没到）。
   *
   * 此刻**不许降级成「只离开」**——那正是这一单要补的那个缺（工作中退出＝真停）；
   * 也不许猜一条。故：把意图挂上，活跃位一到接着办。
   */
  test('**会话还没认出来时敲**：挂上等着，活跃位一到再停（不降级成「只离开」）', () => {
    const wire = stopWire()
    const app = live({ stop: wire.stop, stopped: wire.stopped })
    app.spy.emit(event('turn.start', {})) // 这一轮在跑，但 `session.state` 还没来

    expect(run(app, '/exit').exit).toBe(false)
    expect(app.view().leaving).toBe(false) // 也不走——停了才走
    expect(wire.asked).toEqual([]) // 还不知道是哪一条，一条都不停

    // 活跃位到了（这一声答复把会话 id 带出来）⇒ 接着把刚才那一下办完
    app.spy.emit(
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] }),
    )
    expect(wire.asked).toEqual([{ session: 's1', scope: 'run' }])

    wire.tell('s1', 'done')
    expect(app.view().leaving).toBe(true)
  })

  /**
   * **那道闸不活过头**：等的那一轮收场了、会话 id 始终没来 ⇒ 已经没有可停的东西了。
   *
   * 不带这条的话，它会一直挂到**下一次**活跃位到达——而那可能是用户后来才开/切的那一条，
   * 停它就是**停错了一条**（项目里「不误杀」那条硬规矩）。
   */
  test('等的那一轮**收场了**、会话还是没认出来 ⇒ 没有可停的：直接走', () => {
    const wire = stopWire()
    const app = live({ stop: wire.stop, stopped: wire.stopped })
    app.spy.emit(event('turn.start', {}))
    run(app, '/exit')
    expect(app.view().leaving).toBe(false) // 还在等

    app.spy.emit(event('turn.end', { reason: 'settled' }))
    expect(app.view().leaving).toBe(true) // 直接走
    expect(wire.asked).toEqual([]) // 一条都没停（没有可停的）

    // 而且**不会**在后来的那一条上补一刀
    app.spy.emit(
      event('session.state', { active: 's2', sessions: [{ id: 's2', at: 0, title: '乙的事' }] }),
    )
    expect(wire.asked).toEqual([])
  })

  test('**真·空手开机**（一个会话都没有、也没在跑）：没有可停的东西——直接走', () => {
    const wire = stopWire()
    const app = live({ stop: wire.stop, stopped: wire.stopped })

    run(app, '/exit')

    expect(app.view().leaving).toBe(true)
    expect(wire.asked).toEqual([]) // 一条停止都不发
  })

  test('多写了词 ⇒ 如实回一句，**不退也不停**（不带参数，同 `/clear` 的姿势）', () => {
    const wire = stopWire()
    const app = live({ stop: wire.stop, stopped: wire.stopped })
    withSession(app)

    expect(run(app, '/exit 现在').exit).toBe(false)
    expect(app.view().leaving).toBe(false)
    expect(wire.asked).toEqual([])
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt', text: '认得的用法：/exit（不带参数）' })
  })

  /**
   * **接管（裁决挂着、这一轮在等你答复）期间发不出去**——回车归答复，那条是既有接管
   * 规矩（敲进去的每个字都当答复键判，非答复键当场说一句），本单不动它。
   *
   * 这一条钉的是**边界**，不是「/exit 不好使」：要退，`ctrl+c` 照旧能中断这一轮
   * （见上面那条「全局键，接管不吞」），中断之后再 `/exit` 就走——两件事各归各的入口。
   */
  test('接管期间敲不进去——回车归答复（既有接管规矩）', () => {
    const app = live()
    ask(app)

    expect(run(app, '/exit').exit).toBe(false)
    expect(app.view().draft).toBe('') // 那几个字进不了草稿（都当答复键走了）
  })
})

// ══ 终端没了（`hangUp`）═══════════════════════════════════════════════

describe('hangUp（终端断了 / 收到收摊信号——**不设「按两次」那道门**）', () => {
  test('空闲 ⇒ 当场放行（对面已经没人在按了）', () => {
    const idle = live()
    expect(idle.shell.hangUp().exit).toBe(true)
    expect(idle.view().exitArmed).toBe(false) // 也不留下那一行
  })

  test('工作中 ⇒ 替我们发中断，不退（沿既有）', () => {
    const busy = live()
    busy.spy.emit(event('turn.start', {}))

    expect(busy.shell.hangUp().exit).toBe(false)
    expect(busy.commands()).toEqual([{ type: 'turn.interrupt' }])
  })

  test('刚好挂上那一行时断了 ⇒ 照样当场放行（不是「第二次」）', () => {
    const idle = live()
    idle.press({ kind: 'ctrl+c' })

    expect(idle.shell.hangUp().exit).toBe(true)
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
  /**
   * `/clear`——**回执就是清屏本身**，不另发文案（设计 · 命令行与配置）。
   *
   * ⚠️ **U43 补条那句 `· 已开一条新会话` 随之作废**（工单明文）：换个会话要翻页，
   * 屏上那一下**已经说明了一切**，再补一句「开了」就是把同一件事说两遍。
   */
  test('`/clear`——发 `session.new`；记录区**一行都不添**', () => {
    const app = live()

    app.type('/clear')
    const before = app.rows().length
    app.press(ENTER)

    expect(app.commands()).toEqual([ASK_SKILLS, { type: 'session.new' }])
    expect(app.rows().length).toBe(before)
    expect(app.rows().some((row) => row.kind === 'receipt')).toBe(false)
  })

  /** `/clear` 是**一个动作**，不是一族动作的入口——多写的词照实说一句，不当交代发出去。 */
  test('`/clear <多余>`——只说用法，不发命令', () => {
    const app = live()

    app.type('/clear 别的')
    app.press(ENTER)

    expect(app.commands()).toEqual([ASK_SKILLS])
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt' })
  })

  test('`/rename <文本>`——发 `session.rename`（带上当下那条的 id）', () => {
    const app = live()
    app.spy.emit(
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] }),
    )

    app.type('/rename 换个名字')
    app.press(ENTER)

    expect(app.commands()).toEqual([
      ASK_SKILLS,
      { type: 'session.rename', session: 's1', title: '换个名字' },
    ])
  })

  test('`/rename` 不带文本——只提示用法，不发命令', () => {
    const app = live()

    app.type('/rename')
    app.press(ENTER)

    expect(app.commands()).toEqual([ASK_SKILLS])
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt' })
  })

  test('`/rename` 还没有会话——如实说一句，不发命令（改名不是开张的动作）', () => {
    const app = live()

    app.type('/rename 叫个名字')
    app.press(ENTER)

    expect(app.commands()).toEqual([ASK_SKILLS])
    expect(app.rows().at(-1)).toMatchObject({ kind: 'receipt' })
  })

  test('`/resume <不认得>`——如实说一句，不发命令', () => {
    const app = live()

    app.type('/resume 乱写的')
    app.press(ENTER)

    expect(app.commands()).toEqual([ASK_SKILLS])
    expect(app.rows().at(-1)?.kind === 'receipt').toBe(true)
  })
})

describe('粘贴（非接管）', () => {
  test('落进草稿——不当作按键序列', () => {
    const app = live()

    app.press({ kind: 'paste', text: '粘一段' })
    expect(app.view().draft).toBe('粘一段')

    app.press(ENTER)
    expect(app.commands()).toEqual([{ type: 'input.submit', text: '粘一段', ref: 'draft-1' }])
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

    // **原锚**：`{ type: 'model.switch', provider: 'minimax' }`（选择键＝条目名一件）。
    // **为何变**（U41）：选择键是**连接 id ＋ 精确模型 id** 两件（设计明文——合法的两条
    //   连接可以有同名模型，只报连接名认不出是谁）。契约的 `ModelSwitchRequest.model`
    //   本来就是给这个用的。
    // **新锚**：两件一起给。
    expect(app.commands()).toContainEqual({
      type: 'model.switch',
      provider: 'minimax',
      model: 'MiniMax-M3',
    })
    expect(app.view().dock.kind).toBe('input')
  })
})
