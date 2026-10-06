/**
 * U100 · **Ctrl+C 任务去向与后台续跑**——规格即测试。
 *
 * 设计 [[设计/会话与运行管理#Ctrl+C：选择当前任务去向]]（2026-09-26 用户授权实施）＋
 * [[设计/终端交互]]。真帧与真进程那一半在 `packages/app/test/frames-u100-tui.ts`
 * （`bun test` 不收它）；本文件量的是**不起 Ink 也说得清**的那几条。
 *
 * 四组：
 *
 * | 那一组 | 量什么 |
 * | --- | --- |
 * | **那一屏** | 三项文案与顺序 · 默认第一项 · 打开不发命令 · 待答时标题换一版 · 再按 ctrl+c / esc 都只返回 |
 * | **绑定与竞态** | 选项绑的是**打开那一刻那一件活**：原活结束、换了会话、起了下一轮、换了新的一代 ⇒ 旧菜单**不执行** |
 * | **只剩后台命令** | 后台那一形不占着这一轮，可它**也算在途** ⇒ 照样给三选（设计：「后台命令仍在执行……也属于有在途工作」） |
 * | **失联** | 连接断了 ⇒ **留在界面**（不自动退场）、状态那一格改成「状态待确认」、输入不受理、ctrl+c 走离开那条路 |
 */

import { describe, expect, test } from 'bun:test'
import { HINT_EXIT_ARMED, hasRunningTool } from '../src/view.ts'
import { TEST_AT, event } from './events.ts'
import { createRunsFeed, createStage } from './screen.ts'
import type { Command, RunRow } from '@magic/contracts'
import type { Frame, ScreenOptions, Stage } from './screen.ts'

const WIDE: ScreenOptions = { columns: 100, rows: 40 }
const ARM = { kind: 'ctrl+c' } as const
const ENTER = { kind: 'enter' } as const

/**
 * 这一屏**认得出是哪条会话**——三选里那两件「要落到某条会话上」的选项靠它。
 *
 * 首条消息刚开张的那几百毫秒里 `view.sessionId` 还是 `null`（`session.state` 那一声答复
 * 没到），那一档另有一条用例（`waitsForSession`）管着，这一节量的是**常态**。
 */
const withSession = (stage: Stage, id = 's1'): Stage => {
  stage.feed([event('session.state', { active: id, sessions: [{ id, at: 0, title: '甲的事' }] })])
  ;(stage.spy.commands as Command[]).splice(0)

  return stage
}

/**
 * 工具行**头一行行尾那一位状态**（U112：`▸ 工具名(关键参数)` 靠右摆着的那一位）。
 *
 * 由头：旧那一版把「在跑」写成行首的 `⟳`，故拿 `frame.has('⟳')` 就分得出跑/不跑；
 * U112 起身份记号线首固定是 `▸`，跑/停**全在紧挨着它的那一位上**（`●` 进行中 · `✓` 成 ·
 * `×` 败 · `!` 没跑成/已停止）。这一支只看那一行，**不受状态行上那颗 `●` 干扰**。
 *
 * ⚠️ **2026-10-01 改定**：那一位**从行尾挪到身份记号右边**（`▸ ● 名(参数)`）——
 * 故取的是**下标 2**（trim 之后：`▸` 0 · 空格 1 · 状态位 2），不再是最后一格。
 */
const toolBit = (frame: Frame): string | undefined =>
  frame.record
    .map((line) => line.text.trim())
    .find((text) => text.startsWith('▸ '))
    ?.slice(2, 3)

/** 一条运行事实行（三选绑定它）——只有用例关心的那几格。 */
const runRow = (extra: Partial<RunRow> = {}): RunRow => ({
  session: 's1',
  state: 'running',
  since: 0,
  startedAt: 1_000,
  workspace: ['/tmp/ws'],
  holds: true,
  ...extra,
})

/**
 * ⚠️ **U100 改判**（原锚 / 为何变 / 新锚）——这一节原先叫「工作中按 Ctrl+C ⇒ 仍是中断本轮
 * （不退出、也不冒那一行）」，两条判据都锚在 `turn.interrupt` 上。
 *
 * - **原锚**：工作中那一下**替用户发一次中断**（不退出、不冒那一行）。
 * - **为何变**：2026-09-26 用户以「Ctrl+C 三选」截图要求派发 U100——有在途工作时，那一下
 *   **只把问题摆出来**：**停掉**（留在界面）· **转后台**（界面退出、它继续跑）· **停掉并退出**。
 *   「替用户选中第一项」正是设计明文禁的（「没有倒计时或自动确认」），故旧锚钉的行为
 *   恰恰是被撤掉的那一个。
 * - **新锚**：那一下开三选那一屏；**打开本身不停、不暂停、不退出**（一个命令都不发）；
 *   标题按打开那一刻的事实挑（在跑 / 待答两版）；菜单里再按一下只**返回**。
 */
describe('工作中按 Ctrl+C ⇒ 开「当前任务去向」三选（打开本身不改变执行）', () => {
  /** 这一轮跑起来了（工具在跑 ⇒ 状态行报 `ctrl+c 停或离开`）。 */
  const working = (): Stage => {
    const stage = createStage({ stop: () => {} })
    stage.feed([
      event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
      event('turn.start', {}),
    ])

    return stage
  }

  /** 一张挂着的裁决卡（工具在跑 ＋ 这一轮在等你答）。 */
  const asked = (): Stage => {
    const stage = createStage({ stop: () => {} })
    stage.feed([
      event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
      event(
        'tool.decision.request',
        { call: 71, name: '跑测试', material: '命令 bun test', weight: 'light' },
        { id: 88 },
      ),
    ])
    stage.press({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。

    return stage
  }

  test('三项都在、顺序固定，**一个命令都不发**（那一行也不冒出来）', async () => {
    const stage = working()

    expect(stage.press(ARM).exit).toBe(false)
    const frame = await stage.screen(WIDE)

    expect(frame.has('当前任务仍在运行')).toBe(true)
    // 顺序即设计那张表：停止任务 → 转到后台 → 停止并退出
    const dock = stage.shell.getView().dock
    expect(dock.kind === 'picker' ? dock.picker.rows.map(row => row.label) : []).toEqual([
      '停止任务',
      '转到后台',
      '停止并退出',
    ])
    // **打开不改变执行**：不发中断、不退出；那一行（空闲那条路的门）也不冒出来
    expect(stage.commands()).toEqual([])
    expect(frame.has(HINT_EXIT_ARMED)).toBe(false)
  })

  test('待答时：标题改成「当前任务正在等待你」，且**照样不发中断**', async () => {
    const stage = asked()

    expect(stage.press(ARM).exit).toBe(false)
    const frame = await stage.screen(WIDE)

    expect(frame.has('当前任务正在等待你')).toBe(true)
    expect(stage.commands()).toEqual([]) // **不替用户拒、也不替用户中断**
    // 那张卡被这一屏压下去了（`←` / `esc` 返回时照原样摆回来，见下一条）。
    // ⚠️ 锚用卡上那句键位（内置件是 `y 批准`）——**不是**标题或材料：那些是全屏都可能有的话
    expect(frame.has('y 批准')).toBe(false)
  })

  test('菜单里再按 Ctrl+C ⇒ **只返回**，不隐式执行任何一项', async () => {
    const stage = working()
    stage.press(ARM)

    expect(stage.press(ARM).exit).toBe(false)
    const frame = await stage.screen(WIDE)

    expect(frame.has('当前任务仍在运行')).toBe(false) // 屏收了
    expect(frame.has('停止任务')).toBe(false)
    expect(stage.stops()).toEqual([]) // 一个动作都没执行
    expect(stage.commands()).toEqual([])
    expect(stage.shell.getView().leaving).toBe(false)
  })

  test('`esc` 返回：待答那一屏**照原样摆回来**（审批不丢、也不被答掉）', async () => {
    const stage = asked()
    stage.press(ARM)

    expect(stage.press({ kind: 'escape' }).exit).toBe(false)
    const frame = await stage.screen(WIDE)

    expect(frame.has('y 批准')).toBe(true) // 卡回来了
    expect(frame.has('当前任务正在等待你')).toBe(false)
    expect(stage.commands()).toEqual([]) // 一个字都没替用户答
    // 状态行那一格也跟着回来（`● 等你定夺`）——两处不能各说各的
    expect(frame.statusLine).toContain('等你定夺')
  })

  test('「停止任务」⇒ **走 U50 那条停止通路**（这条会话 · **整体**那一档），界面留下', () => {
    const stage = withSession(working())
    stage.press(ARM)
    stage.press(ENTER) // 默认第一项就是「停止任务」

    // ⚠️ **整体那一档**（`run`）——2026-09-26 规划裁决：两项停止**工作范围相同**，
    // 都必须收回这条会话的在途模型、工具**与后台命令**。局部那一档（`turn`）只送一句
    // `turn.interrupt` 就回「done」，**那不是「资源确已停止」**，也收不走后台命令
    // （由头写在 `shell.ts` 的 `taskAction` 那一处）。
    expect(stage.stops()).toEqual([{ session: 's1', scope: 'run' }])
    expect(stage.commands()).toEqual([]) // 停止不经命令面（U50 起它止于管理者）
    const view = stage.shell.getView()
    expect(view.leaving).toBe(false) // 「留在 Magic」——不放行退出
    expect(view.dock.kind).toBe('input') // 屏收了，接着能交代
  })

  test('「转到后台」⇒ **一条命令都不发**，只放行退出 + **留一条可复制的接回入口**', () => {
    const stage = withSession(working())
    stage.press(ARM)
    stage.press({ kind: 'down' })
    stage.press(ENTER)

    expect(stage.shell.getView().leaving).toBe(true) // 界面这一头可以走了
    expect(stage.stops()).toEqual([]) // **不停**——这正是「退出界面，任务继续运行」
    expect(stage.commands()).toEqual([])

    // **设计明文**：「转后台成功离开时，留一条**可复制的接回入口**（沿用 `magic --session
    // <id>`），不追加常驻状态栏」。判据落在 `leavingNote` 上——**它不经记录区**
    // （那里的行会按列数**硬折行**，而这一句是要整行复制去敲的：硬折行之后复制到的东西
    // 里带着换行，粘进终端就断了）。它由 `app.ts` **直接写字节**出去、交给终端软折行。
    expect(stage.shell.getView().leavingNote).toBe('· 转到后台了 · 接回来：magic --session s1')
  })

  /**
   * **非默认落点要带 `MAGIC_HOME`**（U100 · `resumeCommandOf`）——设计那句「按实际配置保留
   * 必要启动参数」：不带的话，用户复制到**另一个终端**会接到 `~/.magic` 那个库，
   * 会话不在，报「没有这条会话」。
   *
   * 三条：**默认那一形一字不加** · **非默认那一形带上根目录** ·
   * **路径按 POSIX 单引号包住**（有空格也照敲不误）。
   */
  describe('接回入口按落点写（默认简短 / 非默认带 MAGIC_HOME）', () => {
    const resumeLineOf = (options: { readonly home?: string; readonly magicBase?: string }): string => {
      const stage = createStage({ stop: () => {}, ...options })
      withSession(stage)
      stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] })])
      stage.feed([event('turn.start', {})])
      stage.press(ARM)
      stage.press({ kind: 'down' })
      stage.press(ENTER)

      return stage.shell.getView().leavingNote ?? ''
    }

    test('**默认落点**（`<家>/.magic`）⇒ 短的那一句，一字不多', () => {
      expect(resumeLineOf({ home: '/Users/someone', magicBase: '/Users/someone/.magic' })).toBe(
        '· 转到后台了 · 接回来：magic --session s1',
      )
    })

    test('**非默认落点** ⇒ 带上 `MAGIC_HOME=<根>`（根 ＝ `base` 的上一级）', () => {
      expect(resumeLineOf({ home: '/Users/someone', magicBase: '/tmp/another-place/.magic' })).toBe(
        "· 转到后台了 · 接回来：MAGIC_HOME='/tmp/another-place' magic --session s1",
      )
    })

    test('路径里有空格 ⇒ 单引号包住（整行复制照敲不误）', () => {
      expect(resumeLineOf({ home: '/Users/someone', magicBase: '/tmp/my magic dir/.magic' })).toBe(
        "· 转到后台了 · 接回来：MAGIC_HOME='/tmp/my magic dir' magic --session s1",
      )
    })

    test('**落点不知道**（用例 / 演示没给）⇒ 不编一个 `MAGIC_HOME`', () => {
      expect(resumeLineOf({})).toBe('· 转到后台了 · 接回来：magic --session s1')
    })
  })

  /**
   * **会话还没认出来就选「转到后台」**（U100 · 规划裁决点出的竞态）——首条消息刚发出去那
   * 几百毫秒里 `view.sessionId` 还是 `null`。那一档**不许**当场走掉再说一句「没有可接的入口」
   * （设计要的是**成功离开时留下可复制的接回入口**）：**等在界面上**，活跃位一到才走、
   * 写出**真命令**。⚠️ 那一轮收场了会话还没来 ⇒ 才如实说「没有可接的入口」（第 2 条）。
   */
  describe('会话还没认出来时选「转到后台」', () => {
    const backgroundNow = (stage: Stage): Stage => {
      stage.press(ARM)
      stage.press({ kind: 'down' })
      stage.press(ENTER)
      return stage
    }

    test('**先等**（不退、不假报），活跃位一到再走 —— 写的是**真命令**', () => {
      const stage = createStage({ stop: () => {} })
      stage.feed([event('turn.start', {})]) // 首条消息正跑着，`session.state` 还没到
      backgroundNow(stage)

      // **不退**：还没认出来就没有可接的入口
      expect(stage.shell.getView().leaving).toBe(false)
      expect(stage.shell.getView().leavingNote).toBeNull()

      // 活跃位到了 ⇒ 接着把刚才那一下办完
      stage.feed([event('session.state', { active: 's9', sessions: [{ id: 's9', at: 0, title: '甲的事' }] })])
      expect(stage.shell.getView().leaving).toBe(true)
      expect(stage.shell.getView().leavingNote).toBe('· 转到后台了 · 接回来：magic --session s9')
    })

    test('那一轮收场了、会话始终没来 ⇒ 如实说「没有可接的入口」（不假报成功）', () => {
      const stage = createStage({ stop: () => {} })
      stage.feed([event('turn.start', {})])
      backgroundNow(stage)
      expect(stage.shell.getView().leaving).toBe(false)

      stage.feed([event('turn.end', { reason: 'settled' })])
      expect(stage.shell.getView().leaving).toBe(true)
      expect(stage.shell.getView().leavingNote).toBe('· 转到后台了 · 这一趟没有落成会话，没有可接的入口')
    })
  })

  /**
   * **新开的三选恒选第一项**（U100 合前复核 · 返修一）——真反例：先开 `/resume`、把选中
   * 挪到第 2/3/4 条，再按 `ctrl+c`；旧写法把那**另一张列表**的索引带了进来，回车于是落在
   * 「转到后台」「停止并退出」，甚至什么都不做 ✗。
   *
   * ⚠️ 与「菜单开着时的刷新保留本屏选中」（`parkDecision`）不冲突：那一档是**同一张菜单**
   * 被审批顶了一下又摆回来；这一条是**新开一屏**——从 0 起。
   */
  describe('新开三选恒选第一项', () => {
    const withList = (selected: number): Stage => {
      const stage = createStage({ stop: () => {}, runsFeed: createRunsFeed([runRow()]) })
      stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] })])
      // 开 `/resume` 那张列表，把选中挪到第 N 条
      stage.type('/resume ')
      stage.press(ENTER)
      stage.feed([
        event('session.state', {
          active: 's1',
          sessions: ['s1', 's2', 's3', 's4'].map((id, at) => ({ id, at: 4 - at, title: id })),
        }),
      ])
      for (let at = 0; at < selected; at += 1) stage.press({ kind: 'down' })

      return stage
    }

    for (const selected of [1, 2, 3]) {
      test(`列表里挪到第 ${selected + 1} 条之后按 ctrl+c ⇒ 三选仍从**第一项**起`, () => {
        const stage = withList(selected)
        const before = stage.shell.getView().dock
        expect(before.kind === 'picker' ? before.picker.selected : -1).toBe(selected)

        stage.press(ARM)
        const after = stage.shell.getView().dock
        expect(after.kind === 'picker' ? after.picker.selected : -1).toBe(0)
        expect(after.kind === 'picker' ? after.picker.rows[0]?.label : '').toBe('停止任务')
      })
    }

    test('取消（`esc`）之后**原列表照原样回来**（还是第 3 条 · 筛词没被动过）', () => {
      const stage = withList(2)
      stage.press(ARM)
      stage.press({ kind: 'escape' })

      const back = stage.shell.getView().dock
      expect(back.kind).toBe('picker')
      expect(back.kind === 'picker' ? back.picker.source : '').toBe('session')
      expect(back.kind === 'picker' ? back.picker.selected : -1).toBe(2) // 原列表还是第 3 条
      expect(back.kind === 'picker' ? (back.picker.filter ?? '') : 'x').toBe('') // 筛词照旧是空
      expect(stage.shell.getView().draft).toBe('') // 那一条路也没给草稿里塞东西
    })

    test('**菜单里再按一次 `ctrl+c`** 与 `←` 也一样回到原列表（三条路同一处收）', () => {
      for (const close of [ARM, { kind: 'left' } as const]) {
        const stage = withList(1)
        stage.press(ARM)
        stage.press(close)

        const back = stage.shell.getView().dock
        expect(back.kind === 'picker' ? back.picker.source : '').toBe('session')
        expect(back.kind === 'picker' ? back.picker.selected : -1).toBe(1)
      }
    })
  })

  /**
   * **那一代核销了 ⇒ 还在跑的那一行改判「已中断」**（U100 合前复核 · 呈现补）。
   *
   * 由头（真帧上量到的）：停掉 / 失联之后执行者没了，那一件的 `tool.result` **不会再来**
   * ——那一行于是永远停在「⟳ 运行中」、秒数还往上涨 ✗：屏上一句话把一件**已经不可能在执行**
   * 的调用说成正在执行（33b 帧：状态行已是「空闲」，上面那行还在 `⟳`）。
   *
   * 措辞只表一件事：**这一代已核销，这一件的结果无从确认**——不写成功、不写失败、
   * 也不写「未执行」（那一笔有没有跑过我们并不知道）。
   */
  describe('核销之后那一行的呈现', () => {
    const withRunningTool = (): { stage: Stage; push: (rows: readonly RunRow[]) => void } => {
      const feed = createRunsFeed([runRow({ state: 'running' })])
      const stage = createStage({ stop: () => {}, runsFeed: feed })
      stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] })])
      stage.feed([
        event('message.user', { entry: 101 }, { id: 101 }),
        event('turn.start', {}),
        event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
      ])

      ;(stage.spy.commands as Command[]).splice(0)
      return { stage, push: (rows) => stage.pushRuns(rows) }
    }

    test('**正常在跑**那一档照旧：行尾 `●` ＋ 真秒数（别的档不许把这一档也改了）', async () => {
      const { stage } = withRunningTool()
      // ⚠️ 事件的 `at` 由工厂给（`TEST_AT + id`）——钟要按它算：发起于 `TEST_AT + 71` ⇒ 0.6s
      stage.at(TEST_AT + 71 + 1_600)

      const frame = await stage.screen(WIDE)
      expect(frame.has('1.6s')).toBe(true) // 真秒数照旧
      expect(toolBit(frame)).toBe('●') // 行尾那一位照旧是「在跑」
    })

    test('那一代**核销了** ⇒ 那一行改判「已停止 · 结果未确认」：不再是在跑、也不报秒数', async () => {
      const { stage, push } = withRunningTool()
      expect(hasRunningTool(stage.shell.getView())).toBe(true)

      push([runRow({ state: 'stopped' })])
      stage.at(TEST_AT + 71 + 9_999) // 就算钟给到，也不许再报秒数

      const row = stage.shell.getView().rows.find((one) => one.kind === 'tool')
      expect(row?.kind === 'tool' ? row.state : '').toBe('interrupted')

      const frame = await stage.screen(WIDE)
      expect(frame.has('已停止 · 结果未确认')).toBe(true) // 那句话照实说
      expect(toolBit(frame)).toBe('!') // 行尾那一位改判（**不再冒充在跑**——不是 `●`）
      expect(frame.has('1.6s')).toBe(false) // 也不报秒数
      // **不冒充结果**：没有成功/失败/未执行那一套话
      expect(frame.has('✓')).toBe(false)
      expect(frame.has('未执行')).toBe(false)
    })

    /**
     * ⚠️ **失联那一档不许走「已停止」**（2026-09-29 裁决）：那一条是「**不知道**」，
     * 不是「停了」——生命连接通常会让执行者收摊，但**那不是我们能确证的事**。
     * 失联只做一件事：**那一行不再计时**（秒数停下），字句与既有输出照旧。
     */
    test('**失联** ⇒ 那一行只停表：秒数与「运行中」都消失，既有内容照旧', async () => {
      const { stage } = withRunningTool()

      // ① **连着的时候**：真秒数看得见（先把这一档钉住——不然下面那几条可能是空的）
      stage.at(TEST_AT + 71 + 1_600)
      const live = await stage.screen(WIDE)
      expect(live.has('1.6s')).toBe(true)
      expect(toolBit(live)).toBe('●') // 连着的时候：行尾那一位是「在跑」

      // ② **失联**：同一个钟下，秒数与「运行中」**都消失**（那一行只剩头一行）
      stage.shell.disconnected()
      const lost = await stage.screen(WIDE)
      expect(lost.has('1.6s')).toBe(false)
      expect(lost.has('运行中')).toBe(false)
      expect(lost.has('▸ ● 跑测试')).toBe(true) // 头一行照画（**既有内容不擦**）
      expect(toolBit(lost)).toBe('●') // 行尾那一位照旧不动
      expect(hasRunningTool(stage.shell.getView())).toBe(true) // 行本身照旧是「在跑」

      // ③ 钟再往前推 ⇒ **也不许冒出秒数**（这一条把「缓存换脸」一起咬住：失联前那一份
      //    「⟳ 1.6s」若被缓存带回来，它当场红）
      stage.at(TEST_AT + 71 + 3_600)
      const later = await stage.screen(WIDE)
      expect(later.has('3.6s')).toBe(false)
      expect(later.has('1.6s')).toBe(false)
      expect(later.has('运行中')).toBe(false)
      // **不冒充「停了」，也不冒充结果**
      expect(later.has('已停止')).toBe(false)
      expect(later.has('✓')).toBe(false)
      expect(later.has('未执行')).toBe(false)
    })
  })

  /**
   * **过期的审批不许从屏栈复活**（U100 合前复核 · 返修二）——两条实测路：
   * ① 菜单开着时那一代**核销了**；② 菜单开着时**连接断了**。
   * 两条都要求：回来之后**没有那张卡**、**不发任何命令**，且 `ctrl+c` 回到**离开**那条路。
   */
  describe('过期的审批不许从屏栈复活', () => {
    const parked = (): { stage: Stage; push: (rows: readonly RunRow[]) => void } => {
      const feed = createRunsFeed([runRow({ state: 'waiting' })])
      const stage = createStage({ stop: () => {}, runsFeed: feed })
      stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] })])
      // **卡之前**录一段独立、未提交的草稿（卡接管时收进 `stashed`）
      stage.type('半截草稿')
      stage.feed([
        event('message.user', { entry: 101 }, { id: 101 }),
        event('turn.start', {}),
        event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
        event('tool.decision.request', { call: 71, name: '跑测试', material: '命令', weight: 'light' }, { id: 88 }),
      ])
      stage.press({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
      stage.press(ARM) // 卡被三选罩住

      ;(stage.spy.commands as Command[]).splice(0)
      return { stage, push: (rows) => stage.pushRuns(rows) }
    }

    test('那一代**核销了** ⇒ `esc` 回来没有卡、不发命令，`ctrl+c` 走离开那条路', () => {
      const { stage, push } = parked()
      push([runRow({ state: 'stopped' })])

      stage.press({ kind: 'escape' })

      expect(stage.shell.getView().dock.kind).toBe('input') // 卡没回来
      expect(stage.stops()).toEqual([])
      expect(stage.commands()).toEqual([])
      expect(stage.press(ARM).exit).toBe(false)
      expect(stage.shell.getView().exitArmed).toBe(true) // **离开**那条路（不是又进三选）
    })

    test('**连接断了** ⇒ `esc` 回来仍是失联、没有卡、不发命令，`ctrl+c` 走离开那条路', () => {
      const { stage } = parked()
      stage.shell.disconnected()
      expect(stage.shell.getView().status.state).toBe('lost')

      stage.press({ kind: 'escape' })

      expect(stage.shell.getView().status.state).toBe('lost') // **失联不许被改成「等你定夺」**
      expect(stage.shell.getView().dock.kind).toBe('input')
      expect(stage.commands()).toEqual([])
      expect(stage.press(ARM).exit).toBe(false)
      expect(stage.shell.getView().exitArmed).toBe(true)
    })

    /**
     * **两件同时为真：失联优先**（U100 合前复核补的那一条）——审批 → 三选 → 同一运行
     * `stopped` → 断开 → `esc`。顺序不能反：走 `gone` 那一支会把状态那一格改回「空闲」，
     * 于是**失联被抹掉**、输入行又开始承诺「回车发送」✗。判据直接量那一格。
     */
    test('**已核销 ＋ 失联**同时为真 ⇒ `esc` 之后仍是失联（状态那格不许被改成空闲）', () => {
      const { stage, push } = parked()
      push([runRow({ state: 'stopped' })])
      stage.shell.disconnected()

      stage.press({ kind: 'escape' })

      expect(stage.shell.getView().status.state).toBe('lost')
      expect(stage.shell.getView().dock.kind).toBe('input')
      expect(stage.commands()).toEqual([])
      // 而离开那扇门照旧开着
      expect(stage.press(ARM).exit).toBe(false)
      expect(stage.shell.getView().exitArmed).toBe(true)
    })

    test('失联时**裁决键一个答复都不发**（不向内核代答）', () => {
      const { stage } = parked()
      stage.press({ kind: 'escape' }) // 卡丢了（连接断了）
      stage.shell.disconnected()

      for (const char of ['y', 'a', 'n']) stage.press({ kind: 'char', char })

      expect(stage.commands()).toEqual([])
    })

    /**
     * **裁决有人答了 / 那一轮收束了 ⇒ 屏栈里那张卡的快照作废**（U100 合前复核 · 返修二补）。
     *
     * 由头：菜单把卡罩住时 `undock` 只撤**当前那一屏**（`dock` 不是 decision 就直接返回 ✗）
     * ——快照没人撤，裁决早答过、那一轮都收完了（运行也回到空闲），`esc` 一返回照样把旧卡
     * 摆回来、状态改回「等你定夺」✗。故这一条量**从产生处撤**（两条事件各撤一次）：
     * `tool.decision` 与 `turn.end`。
     */
    test('**裁决已答 ＋ 那一轮收束** ⇒ 菜单收起、**草稿当场归还**、状态是空闲', () => {
      const { stage, push } = parked()
      // 卡接管前录的那一段草稿（在被它收进 `stashed` 之前）
      expect(stage.shell.getView().stashed).not.toBeNull()

      stage.feed([
        event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 120 }, { id: 89 }),
        event('tool.result', { call: 71, ok: true, output: { text: 'done' } }, { id: 90 }),
        event('turn.end', { reason: 'settled' }, { id: 91 }),
      ])
      push([runRow({ state: 'idle' })])

      // ⚠️ **不按任何键**：这一条量的是「事件一被消费，那一格上是什么」（菜单此时已按原设计
      // 收起；再按 `esc` 是**正常语义**「清草稿」，那就把要验的东西自己擦掉了）
      const view = stage.shell.getView()
      expect(view.dock.kind).toBe('input')
      expect(view.draft).toBe('半截草稿') // **草稿当场归还**（不是留在 `stashed` 里）
      expect(view.stashed).toBeNull()
      expect(view.status.state).toBe('idle')
      expect(stage.commands()).toEqual([])
      expect(stage.press(ARM).exit).toBe(false)
      expect(stage.shell.getView().exitArmed).toBe(true) // 离开那条路
    })

    test('**只有裁决落地**（工具还在跑）⇒ 卡作废、菜单收起、状态转**工作中**', () => {
      const { stage } = parked()
      stage.feed([
        event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 120 }, { id: 89 }),
      ])

      const view = stage.shell.getView()
      expect(view.dock.kind).toBe('input') // 卡作废、菜单收起
      // **状态由「等你定夺」转「工作中」**（裁决给了、那件工具正在跑）——不是停在等你定夺，
      // 也不是「空闲」
      expect(view.status.state).toBe('working')
      expect(stage.commands()).toEqual([])
    })

    test('**有效**的审批照旧照原样回来（两条路都只挡过期的那一档）', () => {
      const { stage } = parked()
      stage.press({ kind: 'escape' })

      const back = stage.shell.getView().dock
      expect(back.kind).toBe('decision')
      expect(stage.commands()).toEqual([])
    })
  })

  /**
   * **没有停止来路时如实说**（用例 / 演示那种空壳：`options.stop` 没接上）——
   * 不留一个按下去没反应的选项（同 `/resume` 那两个键那条先例）。
   */
  test('没有停止来路 ⇒ 如实回一句，**不假装停过**', async () => {
    // ⚠️ 这一台**故意不给** `stop`（`createStage` 缺省就是没有）
    const stage = createStage()
    stage.feed([
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] }),
      event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
      event('turn.start', {}),
    ])
    stage.press(ARM)
    stage.press(ENTER)

    const frame = await stage.screen(WIDE)
    expect(frame.has('没有连着运行管理')).toBe(true)
    expect(stage.stops()).toEqual([])
  })

  test('「停止并退出」⇒ 与 `/exit` 同一条路：**先停，核销之后才走**', () => {
    const stage = withSession(working())
    stage.press(ARM)
    stage.press({ kind: 'down' })
    stage.press({ kind: 'down' })
    stage.press(ENTER)

    expect(stage.stops()).toEqual([{ session: 's1', scope: 'run' }])
    // 还没核销 ⇒ **不退**（`/exit` 那条「资源确认退出之后」一字不改）
    expect(stage.shell.getView().leaving).toBe(false)
  })

  /**
   * **菜单开着的时候那一轮自己收场了**（设计：「执行前再核对，目标已结束或更换则收起菜单，
   * **不误停下一轮**」）。
   *
   * ⚠️ 这一条咬的是**真的**：菜单一开，屏上换的是三选，可事件照旧在流——
   * 那一轮随时可能跑完。若不核对，用户按下的那一下就会停一条**已经不在的运行**
   * （更坏的一种：停到他自己刚派出去的下一轮）。
   */
  test('菜单开着时任务自然结束 ⇒ 那一项**不执行**，菜单收起（不误停下一轮）', async () => {
    const stage = withSession(working())
    stage.press(ARM)

    stage.feed([event('turn.end', { reason: 'settled' })]) // 这一轮自己收束了
    stage.press(ENTER)

    expect(stage.stops()).toEqual([]) // 一条停止都不发
    expect(stage.commands()).toEqual([])
    expect(stage.shell.getView().leaving).toBe(false)
    expect((await stage.screen(WIDE)).has('停止任务')).toBe(false) // 菜单也收了
  })

  /**
   * **菜单开着的时候新卡到了 ⇒ 卡不顶掉菜单**（U100 · `parkDecision`）。
   *
   * 由头：那一刻正是**最想按停**的时候（模型一个接一个地要工具），而这一屏是唯一能把
   * 在途工作停下来的入口——它一被顶掉，用户手上那点意图就没处落了（回车只会换来
   * 「先答复」）。卡本身不急着看：它挂在那件工具上不会过期、这一轮照旧卡着等答复。
   *
   * 判据三条：**菜单还在**（标题换成「正在等待你」）· 卡压在下层**没画出来** ·
   * `esc` 之后**卡照原样回来**（审批不丢、也没被答掉）。
   */
  test('菜单开着时新卡到了 ⇒ 卡压在菜单之下，`esc` 之后照原样回来', async () => {
    const stage = withSession(working())
    stage.press(ARM)

    stage.feed([
      event(
        'tool.decision.request',
        { call: 71, name: '跑测试', material: '命令 bun test', weight: 'light' },
        { id: 88 },
      ),
    ])

    const held = await stage.screen(WIDE)
    expect(held.has('当前任务仍在运行')).toBe(true) // 菜单还在，标题按此刻的事实换了
    expect(held.has('停止任务')).toBe(true)
    expect(held.has('y 批准')).toBe(false) // 卡压在下面（没画出来）
    expect(stage.commands()).toEqual([]) // 也没替用户答

    // `esc` 返回 ⇒ 卡照原样摆回来
    stage.press({ kind: 'escape' })
    const back = await stage.screen(WIDE)
    expect(back.has('y 批准')).toBe(false)
    expect(stage.shell.getView().dock.kind).toBe('input')
    stage.press({kind:'ctrl+g'})
    expect((await stage.screen(WIDE)).has('y 批准')).toBe(true)
    expect(back.statusLine).toContain('等你定夺')
    expect(stage.commands()).toEqual([])

    // 而**此刻**（卡占着屏、模型不会再往前跑）再按一下 `ctrl+c`，这一屏就出来了——
    // 这正是「按下回车得到的是先答复」那个死角被解开的地方
    expect(stage.press(ARM).exit).toBe(false)
    expect((await stage.screen(WIDE)).has('停止任务')).toBe(true)
    stage.press(ENTER)
    expect(stage.stops()).toEqual([{ session: 's1', scope: 'run' }])
  })
})



// ══ 绑定与竞态：选项绑的是**打开那一刻那一份交代** ═════════════════════════

/**
 * 设计：「选项绑定打开时的当前会话与运行；**执行前再核对，目标已结束或更换则收起菜单，
 * 不误停下一轮**」。这一组逐形钉它。
 *
 * ⚠️ **边界是「一份交代」，不是「一轮」**：一轮 ＝ 一次模型调用 ＋ 它请求的工具，而一份
 * 用户输入会跑好几轮（模型 → 工具 → 模型…）。故这里**头一条**就是「同一份交代的下一轮
 * 照旧管用」——拿「轮」当边界会在工具跑完那一刻把菜单作废（实测栽过），而用户眼里那还是
 * 同一件事。
 */
describe('绑定与竞态：旧菜单不许停新工作', () => {
  /** 一份交代的条目 id（内核 `message.user` 给的那一个）。 */
  const ENTRY = 101
  const ENTRY2 = 202

  /** 一台带运行事实的台（事实由 `pushRuns` 推——真管理者也是推的）。 */
  const withFacts = (
    rows: readonly RunRow[] = [runRow()],
  ): { stage: Stage; push: (rows: readonly RunRow[]) => void } => {
    const feed = createRunsFeed(rows)
    const stage = createStage({ stop: () => {}, runsFeed: feed })
    withSession(stage)
    stage.feed([event('message.user', { entry: ENTRY }, { id: ENTRY })])

    return { stage, push: (next) => stage.pushRuns(next) }
  }

  /** 这一份交代跑起来了（工具在跑）。 */
  const busy = (stage: Stage): void => {
    stage.feed([
      event('turn.start', {}),
      event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
    ])
  }

  test('**同一份交代的下一轮**（模型 → 工具 → 模型）⇒ 菜单照旧管用、照样停这件事', () => {
    const { stage } = withFacts()
    busy(stage)
    stage.press(ARM)
    expect(stage.shell.getView().dock).toMatchObject({ picker: { source: 'task' } })

    // 第一轮收束、下一轮又起来（同一份交代：**没有**新的 `message.user`）
    stage.feed([
      event('tool.result', { call: 71, ok: true, output: { text: '跑完了' } }, { id: 72 }),
      event('turn.end', { reason: 'settled' }),
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '接着来' }),
    ])

    stage.press(ENTER)
    expect(stage.stops()).toEqual([{ session: 's1', scope: 'run' }])
  })

  test('**另交办了一件新事**（新的一份 `message.user`）⇒ 旧菜单不执行', () => {
    const { stage } = withFacts()
    busy(stage)
    stage.press(ARM)

    stage.feed([event('message.user', { entry: ENTRY2 }, { id: ENTRY2 })])
    stage.press(ENTER)

    expect(stage.stops()).toEqual([]) // 新那一件照旧在跑，不许被这一下停掉
  })

  test('原活自己收场了（手上没活了）⇒ 不执行、菜单收起', () => {
    const { stage } = withFacts()
    busy(stage)
    stage.press(ARM)

    // 工具跑完、这一轮收束，而**手上没活**了（执行者回到等输入）——运行事实那一格跟着收
    stage.feed([
      event('tool.result', { call: 71, ok: true, output: { text: '跑完了' } }, { id: 72 }),
      event('turn.end', { reason: 'settled' }),
    ])
    stage.pushRuns([runRow({ state: 'idle' })])
    stage.press(ENTER)

    expect(stage.stops()).toEqual([])
    expect(stage.shell.getView().dock.kind).toBe('input')
  })

  test('**换了新的一代**（`startedAt` 变了）⇒ 旧菜单不执行', () => {
    const { stage, push } = withFacts()
    busy(stage)
    stage.press(ARM)

    push([runRow({ startedAt: 9_000 })]) // 别的窗口把它收了又起了新一代
    stage.press(ENTER)

    expect(stage.stops()).toEqual([])
  })

  test('**换了会话** ⇒ 旧菜单不执行（停的是别人那条）', () => {
    const { stage } = withFacts()
    busy(stage)
    stage.press(ARM)

    stage.feed([event('session.state', { active: 's2', sessions: [{ id: 's2', at: 0, title: '乙的事' }] })])
    stage.press(ENTER)

    expect(stage.stops()).toEqual([])
  })

  test('**一件都没变** ⇒ 照常执行（守护不是「一律不执行」）', () => {
    const { stage } = withFacts()
    busy(stage)
    stage.press(ARM)

    stage.press(ENTER)
    expect(stage.stops()).toEqual([{ session: 's1', scope: 'run' }])
  })
})

// ══ 只剩后台命令：也算在途 ═══════════════════════════════════════════════

/**
 * 设计：「**后台命令仍在执行**、或审批尚待答复时，也属于有在途工作；不只按『模型正在出字』
 * 判断」。后台那一形**不占着这一轮**（发起它的轮早收了），故那一格由**运行事实**给
 * （`RunRow.background`，产生处是执行者那本自有进程账）。
 */
describe('只剩后台命令 ⇒ 照样给三选', () => {
  const backgroundOnly = (): Stage => {
    const stage = createStage({ stop: () => {}, runsFeed: createRunsFeed([runRow({ background: 1 })]) })
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] })])
    // 这一屏自己那一套事件**一件都没有**：不在跑模型、不在跑工具、没有卡
    stage.feed([event('turn.end', { reason: 'settled' })])

    return stage
  }

  test('那一轮早收了、只有后台命令在跑 ⇒ `ctrl+c` 开的是**三选**（不是「按两次退出」）', async () => {
    const stage = backgroundOnly()

    expect(stage.press(ARM).exit).toBe(false)
    const frame = await stage.screen(WIDE)

    expect(frame.has('当前任务仍在运行')).toBe(true)
    expect(frame.has(HINT_EXIT_ARMED)).toBe(false) // **不走**空闲那条路
  })

  test('后台命令跑完之后（那一格没了）⇒ 回到「按两次退出」', () => {
    const stage = createStage({ stop: () => {}, runsFeed: createRunsFeed([runRow({ background: 1 })]) })
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] })])
    stage.pushRuns([runRow({ state: 'idle' })]) // 它退了

    expect(stage.press(ARM).exit).toBe(false)
    expect(stage.shell.getView().exitArmed).toBe(true) // 空闲那一条路
  })
})

// ══ 失联：留在界面、如实说、只剩离开 ═══════════════════════════════════

/**
 * 规划裁决：「控制连接丢失……**留在界面如实说明；不得自动退场**或伪报转后台成功」。
 * 设计那一行：「管理者不可达时界面显示失联，**不把历史 running 当现况**」。
 */
describe('连接断了 ⇒ 留在界面如实说', () => {
  const lost = (): Stage => {
    const stage = createStage({ stop: () => {}, runsFeed: createRunsFeed([runRow()]) })
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] })])
    stage.feed([event('turn.start', {})])
    stage.shell.disconnected()

    return stage
  }

  test('状态那一格改成**状态待确认**（不把历史 working 当现况），并留下一句实话', async () => {
    const stage = lost()
    const frame = await stage.screen(WIDE)

    expect(frame.statusLine).toContain('状态待确认')
    expect(frame.statusLine).not.toContain('工作中')
    expect(frame.has('连接已断开')).toBe(true)
    // **没人替用户退场**：这一屏照旧在（输入行照旧画着）
    expect(frame.has('› ')).toBe(true)
  })

  test('打字照旧进草稿，回车**如实说发不出去**（草稿不丢）', async () => {
    const stage = lost()
    stage.type('写了一半')

    expect(stage.shell.getView().draft).toBe('写了一半')
    stage.press(ENTER)

    expect(stage.shell.getView().draft).toBe('写了一半') // **草稿一个字没动**
    expect(stage.commands()).toEqual([{ type:'history.read',session:'s1' }])
    expect((await stage.screen(WIDE)).has('暂时发不出这一句')).toBe(true)
  })

  /**
   * **那一代核销了 ⇒ 悬着的卡作废**（U100）——真帧上撞到的死角：整体停完，执行者没了，
   * `turn.end` 不会再来 ⇒ 卡永远挂着 ⇒ `ctrl+c` 永远走「有在途工作」那条路，
   * **想按两次 ctrl+c 离开都走不掉** ✗。判据取运行事实（管理者说「已核销」）。
   */
  test('那一代核销了 ⇒ 悬着的卡作废（否则「按两次 ctrl+c 离开」这条路走不掉）', async () => {
    const feed = createRunsFeed([runRow({ state: 'waiting' })])
    const stage = createStage({ stop: () => {}, runsFeed: feed })
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] })])
    stage.feed([
      event('message.user', { entry: 101 }, { id: 101 }),
      event('turn.start', {}),
      event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
      event('tool.decision.request', { call: 71, name: '跑测试', material: '命令', weight: 'light' }, { id: 88 }),
    ])
    stage.press({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
    expect(stage.shell.getView().dock.kind).toBe('decision')

    stage.pushRuns([runRow({ state: 'stopped' })]) // 那一代核销了

    expect(stage.shell.getView().dock.kind).toBe('input') // 卡作废
    expect((await stage.screen(WIDE)).has('y 批准')).toBe(false)
    // 而**离开那扇门**此刻是开着的：那一下走的是「按两次退出」那条路
    expect(stage.press(ARM).exit).toBe(false)
    expect(stage.shell.getView().exitArmed).toBe(true)
  })

  test('`ctrl+c` 走**离开**那条路（不是三选——此刻停不了，也不假装能停）', async () => {
    const stage = lost()

    expect(stage.press(ARM).exit).toBe(false)
    expect(stage.shell.getView().exitArmed).toBe(true)
    expect((await stage.screen(WIDE)).has('停止任务')).toBe(false)
  })

  test('正等着走的那一趟（`/exit`）**不放行**，如实说「停止尚未确认」', async () => {
    const stage = createStage({ stop: () => {}, runsFeed: createRunsFeed([runRow()]) })
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] })])
    stage.type('/exit ')
    stage.press(ENTER)
    expect(stage.shell.getView().leaving).toBe(false)

    stage.shell.disconnected()

    expect(stage.shell.getView().leaving).toBe(false) // **没有悄悄放行**
    expect((await stage.screen(WIDE)).has('停止尚未确认')).toBe(true)
  })
})
