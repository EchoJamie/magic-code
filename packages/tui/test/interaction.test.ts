/**
 * 交互（缺陷轮 II）——**真按键**走活体渲染：打字 / 回车 / 接管 / Ctrl+C 语义。
 *
 * 这一层测的是键从 Ink 到外壳那一跳（`toShellKeys` ＋ `TuiApp`），比外壳用例多出来的
 * 正是这一跳：快照测不到它，而它正是用户手上那件事。
 *
 * ⚠️ **假终端是取件的**（`ink-testing-library`，U23 换）——U09 当时手搓过一份
 * （`ink-harness.ts`：一对假流 ＋ `debug: true` 的 Ink）。那份已删：它做的正是这个库做的事，
 * 而按当前口径**取件优先**（少一处自己维护的假流）。本文件只剩两点胶水，
 * 都是库**不提供**而这一层真要用的：
 *
 * - `ready()`——**Ink 接管 stdin 之前敲的键会静默丢掉**（实测踩过），故敲键前先等监听挂上；
 * - `waitForFrame / waitForExit`——库只给 `frames` / `lastFrame()`（同步快照），
 *   而 Ink 的渲染是**异步**的，断言前得等画面跟上。
 */

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink-testing-library'
import { createElement as h } from 'react'
import type { Command, KernelEvent } from '@magic/contracts'
import { TuiApp, toShellKeys } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import { HINT_EXIT_ARMED } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { plain } from './screen.ts'

const POLL_MS = 5
const TIMEOUT_MS = 2000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 库转出来的那一坨（只要用到的那几样）。 */
type Ui = ReturnType<typeof render>

/**
 * 帧 → **只剩文字与布局**（剥掉 ANSI）。
 *
 * ⚠️ **不剥就是缺陷 D17**：`ink-testing-library` 交的是**带色码的帧**（有 `FORCE_COLOR` 时），
 * 而这一层的断言全是「屏上有没有这一段文字」——色码插在中间，子串**不再连续**，
 * 于是三条用例**每次都要白等满 2 秒超时**才红（实测：`FORCE_COLOR=3` 下三条各耗 2050ms）。
 * 色不在这一层量（要量色去 `screen.ts` 那条真终端的路）。
 */
function plainFrame(ui: Ui): string {
  return plain(ui.lastFrame() ?? '')
}

/** 等一帧满足条件（超时抛——时间给了，还是没等到就是真没渲染出来）。 */
async function waitForFrame(
  ui: Ui,
  predicate: (frame: string) => boolean,
  label?: string,
): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS

  while (Date.now() < deadline) {
    const frame = plainFrame(ui)
    if (predicate(frame)) return frame
    await sleep(POLL_MS)
  }

  throw new Error(`等不到满足条件的帧${label === undefined ? '' : `（${label}）`}：\n${plainFrame(ui)}`)
}

/** 起一个活壳：外壳 ＋ 间谍传输（可按需投事件）。 */
function liveApp() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)
  const ui = render(h(TuiApp, { shell }))

  /** 等 Ink 真正接管 stdin——`useInput` 的 effect 先于 App 挂监听，故 `readable` 在监听上，两个都就位了。 */
  const ready = async (): Promise<void> => {
    const stdin = ui.stdin as unknown as EventEmitter
    const deadline = Date.now() + TIMEOUT_MS

    while (Date.now() < deadline) {
      if (stdin.listenerCount('readable') > 0) return
      await sleep(POLL_MS)
    }

    throw new Error('Ink 未接管 stdin——`readable` 监听没挂上')
  }

  const app = {
    /** 最近一帧（还没渲染过则为空串）——同样**先归一化**（见 `plainFrame`）。 */
    frame: (): string => plainFrame(ui),

    /** 敲键（`\r` 回车 · `\u0003` Ctrl+C · `\u000f` ctrl+o · `y` / `n` 答复）。 */
    type: async (data: string): Promise<void> => {
      await ready()
      ui.stdin.write(data)
    },

    waitForFrame: (predicate: (frame: string) => boolean, label?: string) =>
      waitForFrame(ui, predicate, label),

    /**
     * 等进程退出（Ink 的 `exit()`）。
     *
     * 库不转出 Ink 的 `waitUntilExit`，故认**收尾帧**：退出时 Ink 写最后一笔
     * （`log.done()`），此后 `lastFrame()` 只剩空白（实测：内容帧 → `"\n"`）。
     */
    waitForExit: () => waitForFrame(ui, (frame) => frame.trim() === '', '退出'),

    unmount: () => ui.unmount(),
  }

  return {
    spy,
    shell,
    app,
    commands: (): readonly Command[] => spy.commands,
    /** 投事件并等画面跟上。 */
    async push(events: readonly KernelEvent[], expectFrame?: (frame: string) => boolean) {
      for (const item of events) spy.emit(item)
      if (expectFrame !== undefined) await app.waitForFrame(expectFrame)
    },
  }
}

describe('输入行', () => {
  test('打字显示在输入行，回车提交并清空', async () => {
    const { app, commands } = liveApp()

    await app.waitForFrame((frame) => frame.includes('交代一件事'))
    await app.type('看下工作区')
    await app.waitForFrame((frame) => frame.includes('› 看下工作区'))

    await app.type('\r')
    await app.waitForFrame((frame) => frame.includes('交代一件事'))

    // `ref` ＝ 提交的配对键（U33）——`input.settled` 按它认回这份草稿
    expect(commands()).toEqual([{ type: 'input.submit', text: '看下工作区', ref: 'draft-1' }])

    app.unmount()
  })

  test('控制键不往输入框里塞字（Ctrl+D 不是字母 d）', async () => {
    const { app } = liveApp()

    await app.waitForFrame((frame) => frame.includes('交代一件事'))
    await app.type('ok')
    await app.waitForFrame((frame) => frame.includes('› ok'))

    await app.type('\u0004') // Ctrl+D
    await app.type('\u001b[1;5C') // Ctrl+右（转义序列）
    await app.type('!')
    await app.waitForFrame((frame) => frame.includes('› ok!'))

    app.unmount()
  })
})

describe('审批答复（接管）', () => {
  test('提示出现 → **接管**（卡与底行在、输入行收走）；按 `y` 作答', async () => {
    const { app, commands, push } = liveApp()

    // 先等首帧落上再投事件（Ink 接管 stdin 之前投的事件不会丢——视图是外壳的；
    // 但首帧没出来时 `frame()` 是空的，断言会瞎等）
    await app.waitForFrame((frame) => frame.includes('交代一件事'))

    await push(
      [
        event('turn.start', {}),
        event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'exec', material: '命令 ls', weight: 'light' },
          { id: 88 },
        ),
      ],
      // 等的锚是**接管到了**（状态行那三个字），不是输入行那句占位——接管态不再画输入行（D29）
      (frame) => frame.includes('● 等你定夺'),
    )

    await app.type('y')
    expect(commands()).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])

    // 裁决落定（内核回 `tool.decision`）才解除接管——输入行回到**此刻**那张脸。
    //
    // ⚠️ 本条 2026-09-19（U20）**换过脸**：原先期待的是「交代一件事」（常态）。
    //    - **原锚**：它其实没钉规格，钉的是**当时的状态行还没归位**——那一刻底行赖在
    //      「● 等你定夺」上（答都答完了），而输入行按状态翻脸时看的是 `working/waiting`
    //      之外的档，于是顺手翻成了「常态」。两处互相打架。
    //    - **规格为什么变**：状态行「只放此刻」——答完球就回到内核那边（这一轮还在跑），
    //      底行该说「● 工作中」（U20 真跑留帧时当场看出来的）。
    //    - **新锚**：同一条规格（接管解除 ⇒ 输入行回来）＋ **输入行与底行同口径**
    //      ——这一轮还在跑 ⇒ 「（工作中——想插话可以打，发不出去就排队）」。
    //    - **2026-09-22 再收一次锚**（D29）：接管态不画输入行了 ⇒「不再说『等你的答复』」已**恒真**，
    //      换成它的正题：**输入行回来了**，且卡不在。
    await push([event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 300 })],
      (frame) => frame.includes('想插话可以打'))
    expect(app.frame()).toContain('› ')
    expect(app.frame()).not.toContain('等你的答复')
    expect(app.frame()).not.toContain('y 批准')
    expect(app.frame()).toContain('● 工作中')

    app.unmount()
  })

  test('必闸类按 `a` —— 不发命令，屏上多一句缘由（`▲ …`）', async () => {
    const { app, commands, push } = liveApp()

    await push(
      [
        event('turn.start', {}),
        event('tool.call', { name: 'write', args: { path: 'a' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'write', material: '覆盖 a', weight: 'heavy' },
          { id: 88 },
        ),
      ],
      // 等的锚是**接管到了**（状态行那三个字），不是输入行那句占位——接管态不再画输入行（D29）
      (frame) => frame.includes('● 等你定夺'),
    )

    await app.type('a')
    await app.waitForFrame((frame) => frame.includes('必闸类不可'))

    expect(commands()).toEqual([])

    app.unmount()
  })

  test('等裁决时打的字不进输入框——忽略但当场说一句', async () => {
    const { app, push } = liveApp()

    await push(
      [
        event('turn.start', {}),
        event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
        event('tool.decision.request', { call: 71, name: 'exec', material: 'ls', weight: 'light' }, { id: 88 }),
      ],
      // 等的锚是**接管到了**（状态行那三个字），不是输入行那句占位——接管态不再画输入行（D29）
      (frame) => frame.includes('● 等你定夺'),
    )

    await app.type('x')
    await app.waitForFrame((frame) => frame.includes('先答复'))

    app.unmount()
  })
})

describe('Ctrl+C 语义', () => {
  test('空闲 —— **按两次**才退出（第一下只印那一行；改前是一次就走）', async () => {
    const { app } = liveApp()

    await app.waitForFrame((frame) => frame.includes('交代一件事'))

    // 第一下：**不退出**，只在输入行上方多出那一行（U46）
    await app.type('\u0003')
    await app.waitForFrame((frame) => frame.includes(HINT_EXIT_ARMED))

    // 第二下：走
    await app.type('\u0003')
    await app.waitForExit()
    app.unmount()
  })

  test('工作中 —— 中断本轮，不退出', async () => {
    const { app, commands, push } = liveApp()

    await push([event('turn.start', {})], (frame) => frame.includes('● 工作中'))
    await app.type('\u0003')

    expect(commands()).toEqual([{ type: 'turn.interrupt' }])
    // 还活着（没退出）：再敲一个字仍在输入框
    await app.type('a')
    await app.waitForFrame((frame) => frame.includes('› a'))

    app.unmount()
  })
})

describe('展开 / 折叠', () => {
  test('`ctrl+o` 展开——思考从一行变成全文', async () => {
    const { app, push } = liveApp()

    await push([
      event('model.delta', { channel: 'thinking', text: '第一行想法\n第二行想法' }),
    ])
    await app.waitForFrame((frame) => frame.includes('（思考）'))

    await app.type('\u000f') // ctrl+o
    await app.waitForFrame((frame) => frame.includes('第二行想法'))

    app.unmount()
  })
})

// ══ 攒块里的正文（U36 · 独立复核）═════════════════════════════════════

describe('攒块里的正文', () => {
  /**
   * ⚠️ **原文照收**（2026-09-22 独立复核）：早先这里把攒块里的控制字符清掉，结果
   * **粘贴里的 Tab 被静默删了**——`if ready:\n\tprint(1)` 到模型手上成了不带缩进的两行。
   * Tab 是**合法的粘贴内容**（Python 缩进就靠它），不是「用户打不出来」的东西。
   * 故攒块逐字符摊成正文，一个都不改；换行另有两处管（裸 `\n` 与 `key.return`）。
   */
  test('攒块逐字符摊开——`\t` 照收（Python 缩进那类粘贴）', () => {
    expect(toShellKeys('\tprint', {})).toEqual([
      { kind: 'char', char: '\t' },
      { kind: 'char', char: 'p' },
      { kind: 'char', char: 'r' },
      { kind: 'char', char: 'i' },
      { kind: 'char', char: 'n' },
      { kind: 'char', char: 't' },
    ])
  })

  test('单个 `\r` / `\n` 的老两条来路照旧（回车 / 换行）', () => {
    expect(toShellKeys('\r', { return: true })).toEqual([{ kind: 'enter' }])
    expect(toShellKeys('\n', {})).toEqual([{ kind: 'newline' }])
  })

  /**
   * **D35 · 那一按要作数**——正文与回车挤进同一个读块时（真 PTY 实测：`/exit` 与紧接的回车
   * 并成一个读块），Ink 把整块当一串正文 ⇒ 回车当场没有 ⇒ 整条命令按下去什么都不发生。
   *
   * 认的条件就三条（见 `trailingEnterOf`）：**末尾是 `\r` · 块里 `\r` 只这一个 · 块里没有 `\n`**。
   * 下面正面那一组钉「认回来了」，反面那一组钉「**粘贴不许被切碎**」——**后者比前者重要**。
   */
  test('**正文＋回车挤进一个读块** ⇒ 末尾那一下仍是回车（D35）', () => {
    expect(toShellKeys('/exit\r', {})).toEqual([
      { kind: 'char', char: '/' },
      { kind: 'char', char: 'e' },
      { kind: 'char', char: 'x' },
      { kind: 'char', char: 'i' },
      { kind: 'char', char: 't' },
      { kind: 'enter' },
    ])

    // 一个字 ＋ 回车、以及中文字那句，同一条规矩（不与字数挂钩）
    expect(toShellKeys('a\r', {})).toEqual([{ kind: 'char', char: 'a' }, { kind: 'enter' }])
    expect(toShellKeys('你好\r', {})).toEqual([
      { kind: 'char', char: '你' },
      { kind: 'char', char: '好' },
      { kind: 'enter' },
    ])
  })

  test('反面 · **带换行的块一个字符都不动**（多行粘贴不许被切碎）', () => {
    // 裸 LF 的多行粘贴（终端不认 bracketed paste 时就是这样落进来的）
    expect(toShellKeys('line1\nline2\n', {})).toEqual(
      [...'line1\nline2\n'].map((char) => ({ kind: 'char', char })),
    )
    // CRLF 的多行粘贴：`\r` 不止一个 ⇒ 不认
    expect(toShellKeys('line1\r\nline2\r\n', {})).toEqual(
      [...'line1\r\nline2\r\n'].map((char) => ({ kind: 'char', char })),
    )
    // 「一段 CR 结尾的多行」：末尾虽然只有一个 `\r`，但块里还有一个 ⇒ 不认
    expect(toShellKeys('a\rb\r', {})).toEqual(
      [...'a\rb\r'].map((char) => ({ kind: 'char', char })),
    )
    // **敲了一半的多行草稿 ＋ 回车**：块里有 `\n` ⇒ 照样不认（代价如实记在 `trailingEnterOf`）
    expect(toShellKeys('a\nb\r', {})).toEqual(
      [...'a\nb\r'].map((char) => ({ kind: 'char', char })),
    )
  })

  test('反面 · `\r` 在块中间、以及连着两个 `\r` ⇒ 都不是回车', () => {
    expect(toShellKeys('a\rb', {})).toEqual([
      { kind: 'char', char: 'a' },
      { kind: 'char', char: '\r' },
      { kind: 'char', char: 'b' },
    ])
    expect(toShellKeys('\r\r', {})).toEqual([
      { kind: 'char', char: '\r' },
      { kind: 'char', char: '\r' },
    ])
  })
})

// ══ 合块那一跳走到底（D35）═══════════════════════════════════════════

describe('挤进同一个读块的正文与回车', () => {
  /**
   * `toShellKeys` 那一层认回来了还不够——**得走到底**：键进了外壳、草稿清了、命令发出去了。
   * 这一支钉的正是「按下去**屏上有反应**」（修前：一动不动）。
   */
  test('一次写「正文＋回车」⇒ 提交（外壳收到输入，输入行清空）', async () => {
    const { app, commands } = liveApp()

    await app.waitForFrame((frame) => frame.includes('交代一件事'))
    // ⚠️ **一次 `write`**——「敲完立刻回车」那一形（`app.type` 把整串交给假 stdin，
    // 走的就是 Ink 的解析，与真 PTY 里那一个读块同形）
    await app.type('看下工作区\r')

    await app.waitForFrame((frame) => frame.includes('交代一件事'))
    expect(commands()).toEqual([{ type: 'input.submit', text: '看下工作区', ref: 'draft-1' }])

    app.unmount()
  })

  test('反面：多行粘贴那一次写 ⇒ **不提交**，整段原样进草稿', async () => {
    const { app, commands } = liveApp()

    await app.waitForFrame((frame) => frame.includes('交代一件事'))
    await app.type('第一行\n第二行\n')

    // 两行都在草稿里（`\n` 在正文里是真换行），命令一条都没发
    await app.waitForFrame((frame) => frame.includes('第一行') && frame.includes('第二行'))
    expect(commands()).toEqual([])

    app.unmount()
  })

  /**
   * **审批卡上那一下**（`y\\r` 挤一块）——这里钉的是**它不越界**：
   * 认回来的那个回车只走「回车该走的那条路」，**不会顺手把草稿发出去**。
   *
   * 裁决卡那一屏回车本来就不好使（`submit()` 里 `decision` 那支是 `refuse('回车')`），
   * 故此刻它当场说一句、什么都不发——与「先按 y、再单独按一下回车」逐字同形。
   */
  test('裁决卡上 `y\\r` 挤一块 ⇒ 答复发出去了，**草稿没被捎带发出去**', async () => {
    const { app, push, commands } = liveApp()

    await push(
      [
        event('turn.start', {}),
        event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
        event('tool.decision.request', { call: 71, name: 'exec', material: 'ls', weight: 'light' }, { id: 88 }),
      ],
      (frame) => frame.includes('● 等你定夺'),
    )

    await app.type('y\r')
    await app.waitForFrame((frame) => frame.includes('先答复'))

    // **只有答复那一条**——没有 `input.submit`
    expect(commands()).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])

    app.unmount()
  })
})
