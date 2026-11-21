/**
 * **这一屏此刻有没有输入焦点**（D75）——DECSET 1004 的读数，与「那一下轻点算不算」的准入。
 *
 * ## 为什么非问终端不可
 *
 * 右 ⌥ 由本机只读监听取得（U135）：`CGEvent.tapCreate(.listenOnly)` 是**系统级**的，
 * 同一台机器上每个 Magic 窗口的监听都听得见**同一下按键**。不加判断，五个窗口就一起录音、
 * 一起往各自的草稿里落字——D75 报的正是这一条。
 *
 * ## 三条规矩（照 D75「设计思路与取舍」）
 *
 * 1. **只认当前拿焦点的那一屏**；**焦点未知时不触发**——终端一次都没上报过，就说不上
 *    此刻是哪一屏，宁可不响（`unknown` 不等于「大概是我」）。
 * 2. **按下至松开之间换过焦点，不算一次轻点**：按下那一刻的焦点要记下来，松开时要它
 *    仍然亮着、且中途没换过（`since <= 按下时刻` 就是这一条）。只判「松开时我有焦点」
 *    会漏掉「在 A 按下、切到 B 再松开」——B 明明是新来的，却成了发起者。
 * 3. **退出复原**（`FOCUS_OFF`）：焦点模式是**终端**的状态，留着就把 `[I` / `[O` 塞给
 *    下一个程序。
 *
 * ## 上报长什么样
 *
 * 终端在窗口/标签页/分屏**拿到**键盘焦点时往 stdin 写 `CSI I`（`\x1b[I`）、**失去**时写
 * `CSI O`（`\x1b[O`）——一条 3 字节，都落在 CSI 的末字节区（`I` / `O`）。开了模式之后
 * 只在**变化时**报，故「未知」只出现在开头那一小会儿。
 *
 * ⚠️ **Ink 会把这两条当按键递进来**（它剥掉 ESC，交上来的是 `[I` / `[O`）——它们不是正文，
 * 见 `stripFocusReports`（`input.ts` 在认键之前先剥一遍，否则屏上会多出两个字母）。
 */

/** 开／关焦点上报（DECSET 1004）。**成对出现**：开了就得关，别留给下一个程序。 */
export const FOCUS_ON = '\u001b[?1004h'
export const FOCUS_OFF = '\u001b[?1004l'

/** 两条上报（终端 → 我们）。 */
const FOCUS_IN = '\u001b[I'
const FOCUS_OUT = '\u001b[O'

/** 此刻的状态：`unknown` ＝ 终端还没报过（不支持，或者刚开模式）。 */
type TerminalFocus = 'in' | 'out' | 'unknown'

/** 那一下轻点的两半——按下与松开（**同一个窗口**才算一次）。 */
type FocusPhase = 'down' | 'up'

export type FocusGate = {
  /** 把 stdin 的原始字节喂进来（**认这些字节，不消费**——Ink 那一头照旧读同一份）。 */
  readonly feed: (chunk: string) => void
  /** 这一下算不算一次有效的轻点；只有**松开**那一半可能为真。 */
  readonly tap: (phase: FocusPhase, now: number) => boolean
  /** 此刻的读数（诊断与测试用）。 */
  readonly focus: () => TerminalFocus
}

/**
 * 造一个闸门。`clock` 可注入（用例不用等真时间）。
 *
 * ⚠️ 跨块：一次读里可能只到 `\x1b` 或 `\x1b[`（终端与事件循环说了算），故留一截尾巴
 * 等下一块——不留就会把一条上报拆成两半，正好谁都不认。
 */
export function createFocusGate(clock: () => number = Date.now): FocusGate {
  let state: TerminalFocus = 'unknown'
  /** 状态变成此刻这个值的时刻——「按下之后才换过来的」靠它认。 */
  let since = 0
  /** 按下那一刻：焦点在不在我这儿（`null` ＝ 这一下没有按下那一半）。 */
  let held: { readonly at: number; readonly focused: boolean } | null = null
  let tail = ''

  const move = (next: TerminalFocus): void => {
    if (state === next) return
    state = next
    since = clock()
  }

  const feed = (chunk: string): void => {
    let text = tail + chunk
    tail = ''
    for (let at = 0; at < text.length;) {
      if (text[at] !== '\u001b') { at += 1; continue }
      const rest = text.slice(at)
      // 只到了半条（`\x1b` 或 `\x1b[`）：留到下一块
      if (rest.length < 3 && (FOCUS_IN.startsWith(rest) || FOCUS_OUT.startsWith(rest))) {
        tail = rest
        return
      }
      if (rest.startsWith(FOCUS_IN)) { move('in'); at += FOCUS_IN.length; continue }
      if (rest.startsWith(FOCUS_OUT)) { move('out'); at += FOCUS_OUT.length; continue }
      at += 1
    }
  }

  const tap = (phase: FocusPhase, now: number): boolean => {
    if (phase === 'down') {
      held = { at: now, focused: state === 'in' }
      return false
    }
    const press = held
    held = null
    // 没有按下那一半：**老助手**（只报「按完了」）只能按此刻判——新助手一定先报按下。
    if (press === null) return state === 'in'
    // 按下时没有焦点（含 unknown）⇒ 不算；松开时没了焦点 ⇒ 不算；
    // 中途换过焦点（`since` 晚于按下）⇒ 不算——那是「在 A 按下、切到 B 松开」。
    return press.focused && state === 'in' && since <= press.at
  }

  return { feed, tap, focus: () => state }
}

/**
 * **开一次焦点上报**：写 `FOCUS_ON`、把 stdin 的字节喂给闸门、收摊时复原。
 *
 * 单拎出来是为了可测（`run.ts` 那一头要真终端才跑得起来）：这一件只碰「写两串字节」
 * 「挂一条监听」，与 Ink 无关。
 *
 * ⚠️ **只认不消费**：同一根 stdin 上 Ink 也在读——这里 `on('data')` 只旁听。
 */
export function openFocusReport(
  stdin: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
    off(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  },
  stdout: { write(chunk: string): unknown },
  gate: FocusGate = createFocusGate(),
): { readonly gate: FocusGate; readonly close: () => void } {
  const feed = (chunk: Buffer | string): void => {
    gate.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }
  stdout.write(FOCUS_ON)
  stdin.on('data', feed)
  let closed = false
  return {
    gate,
    close: () => {
      if (closed) return
      closed = true
      stdin.off('data', feed)
      stdout.write(FOCUS_OFF)
    },
  }
}

/**
 * 把 Ink 交上来的焦点上报剥掉——Ink 剥了 ESC，剩 `[I` / `[O`，落到认键那一支会变成
 * **两个正文字母**（`[` 与 `I`），草稿里凭空多一串。
 *
 * ⚠️ **只剥行首那几条**：正文里真打出来的 `[I`（方括号＋字母）是用户写的字，不能吃；
 * 而一条上报总是从这一块的开头起（Ink 按序列切块递进来）。
 */
export function stripFocusReports(input: string): string {
  let text = input
  while (text.startsWith('[I') || text.startsWith('[O')) text = text.slice(2)
  return text
}
