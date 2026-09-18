/**
 * 终端层（U23）——**录真字节 → 放成屏幕**。
 *
 * ## 为什么要有这一层
 *
 * 仓里八百多个用例测的都是「**视图对象**怎么变」，而 `renderToString` 交出来的是**纯帧文本**：
 * 没有光标移动、没有擦行、没有「这个 `\n` 到了终端上会把后面那行往下推几格」。
 * 用户亲跑撞的三跤全死在**字节怎么写进终端**这一层，八百多个用例一个都没拦住：
 *
 * - **D11**——每条显示行的 `<Text>` 里多写了一个 `'\n'`，而 Ink 的竖排 Box 本来就一子节点一行
 *   ⇒ 每行实占两行 ⇒ 重绘「上移 N 行」擦不干净 ⇒ 同一段留在屏上又画一遍；
 * - **D13**——首行按**可见宽度**重切整段（不切换行），`\n` 被留在首行里 ⇒ 终端上首行自己展开、
 *   续行又画一遍 ⇒ 正文两遍；
 * - **D8**——状态行把身份与此刻挤在一行，标题一长就把键位挤出屏。
 *
 * 这三条的判据**都不在视图里**，只在屏上。
 *
 * ## 两件事
 *
 * - `record()`——**录**：把 Ink 架在假 TTY 上，逐帧重绘，收下 stdout 收到的每一个字节；
 * - `screenOf()`——**放**：把那串字节喂进 `@xterm/headless`（**真 VT 模型，取件不自造**），
 *   读回**屏幕矩阵**。
 *
 * ## ⚠️ 三条不能省的讲究（每一条都踩过）
 *
 * 1. **假 stdout 必须 `isTTY: true`**——Ink 只在「真终端」时才走擦行 / 上移那条路
 *    （`interactive`）；`isTTY` 为假时它退化成「只写最终帧」，**残影根本录不到**，
 *    这一层就白搭了。同理要给出 `columns` / `rows`（Ink 从流上读窗口尺寸）。
 * 2. **`maxFps: 0`**——Ink 默认按 30fps 节流合并帧；录制要「一帧就是一帧」。
 *    注意**不能**用 `debug: true` 关节流：它**同时**把擦行逻辑也关了
 *    （见 `ink/build/ink.js` 的 `unthrottled`），而那正是要测的那一段。
 * 3. **每帧之间 `await waitUntilRenderFlush()`**——`rerender()` 只是排了个 React 更新，
 *    不等落盘就录下一帧，帧序会乱。屏幕是**时序**的产物，时序错了标本就不算数。
 */

import { Terminal } from '@xterm/headless'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import type { Instance } from 'ink'
import type { ReactElement } from 'react'

// —— 放：字节 → 屏幕矩阵 ——

/**
 * 屏幕矩阵——**一段字节在真终端上最终长什么样**。
 *
 * ⚠️ 这是**终端的**账，不是视图的账：行数、折行、光标全由终端算。
 * 内联渲染下已定局的内容会滚进 scrollback，故 `lines` **含 scrollback**（顶 → 底）。
 */
export type Screen = {
  readonly columns: number
  readonly rows: number
  /** 屏上每一行（含滚进 scrollback 的）——右侧空白已裁。 */
  readonly lines: readonly string[]
  /**
   * 与 `lines` 一一对应：这行是不是**终端自己折出来的续行**。
   *
   * ＝上游写宽了（渲染层本该自己折，没折）。这是「溢出」在终端层的**唯一**可判定形态——
   * 终端从不报错，它只会默默折行。
   */
  readonly wrapped: readonly boolean[]
  /** 光标落在哪（残影类缺陷要看它——擦干净没擦干净，光标位置先露馅）。 */
  readonly cursor: { readonly x: number; readonly y: number }
}

export type ScreenOptions = {
  readonly columns: number
  readonly rows: number
  /** 回滚缓冲——内联渲染下内容会滚出去，取默认值足够。 */
  readonly scrollback?: number
}

/** 把一段 stdout 原始字节喂进终端模型，读回屏幕矩阵。 */
export async function screenOf(bytes: string, options: ScreenOptions): Promise<Screen> {
  const terminal = new Terminal({
    cols: options.columns,
    rows: options.rows,
    scrollback: options.scrollback ?? 1000,
    // ⚠️ **必开**：真终端收到 `\n` 会**回车**，靠的不是终端而是**内核 tty 驱动**
    // （`opost` 的 `ONLCR`——把 `\n` 翻成 `\r\n`）。VT 模型本身是照规范来的（LF 只下移不回列），
    // 不开这个开关就成了「只下移不回列」：列号一路累积，屏上每行都往前缩一截，
    // 于是**真缺陷与假缺陷混在一起分不出来**（实测踩过）。
    // `convertEol` 正是那一步翻译——不开，这一层量到的就不是用户看到的那个屏。
    convertEol: true,
    allowProposedApi: true,
  })

  // `write` 是异步的（VT 解析器按块推进）——必须等它报完再读，否则读到半截屏
  await new Promise<void>((resolve) => {
    terminal.write(bytes, () => resolve())
  })

  const buffer = terminal.buffer.active
  const lines: string[] = []
  const wrapped: boolean[] = []

  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y)
    lines.push(line === undefined ? '' : line.translateToString(true))
    wrapped.push(line?.isWrapped ?? false)
  }

  return {
    columns: options.columns,
    rows: options.rows,
    lines,
    wrapped,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
  }
}

// —— 录：Ink → 字节 ——

/** 假 stdout——Ink 只用 `write` / `columns` / `rows` / `isTTY`。⚠️ `isTTY` 必须为真（见文件头注 1）。 */
class FakeTty extends EventEmitter {
  readonly columns: number
  readonly rows: number
  readonly isTTY = true
  readonly destroyed = false
  readonly writableEnded = false
  /** 收到过的每一个字节（按到达次序拼）。 */
  private readonly chunks: string[] = []

  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }

  write = (chunk: string): boolean => {
    this.chunks.push(chunk)
    return true
  }

  /** 录到此刻的全部字节。 */
  bytes(): string {
    return this.chunks.join('')
  }
}

/** 假 stdin——录制不按键，但 Ink 要一个流才肯挂起来。 */
class FakeStdin extends EventEmitter {
  readonly isTTY = true

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => null
}

export type RecordOptions = {
  readonly columns: number
  readonly rows: number
}

/**
 * 录一段真字节——把 `frames` 逐帧画过去，收下 stdout 收到的全部字节。
 *
 * 帧序即真终端的时序：同一份视图**一次性画** 与 **流式长出来** 在屏上是两回事，
 * D11 那种残影只在后者出现。
 */
export async function record(frames: readonly ReactElement[], options: RecordOptions): Promise<string> {
  const first = frames[0]
  if (first === undefined) throw new Error('record() 至少要一帧')

  const stdout = new FakeTty(options.columns, options.rows)
  const stdin = new FakeStdin()

  const instance: Instance = render(first, {
    // 类型上要 NodeJS.WriteStream——假流只实现 Ink 真正用到的那几个成员
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    // 非 debug：要的是擦行 / 上移那条路（debug 会把它关掉——见文件头注 2）
    debug: false,
    // 不节流：一帧就是一帧（默认 30fps 会把帧合并掉）
    maxFps: 0,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  for (const frame of frames.slice(1)) {
    instance.rerender(frame)
    // 等这一帧真写出去再画下一帧——不等就录，帧序会乱（见文件头注 3）
    await instance.waitUntilRenderFlush()
  }

  instance.unmount()

  return stdout.bytes()
}

// —— 标本的存法：字节写成可读、可 diff 的转义文本 ——

/**
 * 字节 → 转义文本（`\e` 起头、`\n` / `\r` 照写、其余控制字符走 `\xNN`）。
 *
 * 为什么要转义：标本要**入库、进 diff、给人看**。原始 ESC 字节混在文件里既 diff 不出、
 * 也读不懂「上移几行」。转义之后 `\e[1A\e[2K` 长什么样一眼就是一眼。
 */
export function escapeBytes(bytes: string): string {
  let out = ''

  for (const char of bytes) {
    const code = char.codePointAt(0) ?? 0

    if (char === '\u001b') out += '\\e'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += char
  }

  return out
}

/** 转义文本 → 字节（`escapeBytes` 的逆）。 */
export function unescapeBytes(text: string): string {
  return text.replace(/\\(e|x[0-9a-fA-F]{2}|n|r|t)/g, (whole: string, token: string) => {
    if (token === 'e') return '\u001b'
    if (token === 'n') return '\n'
    if (token === 'r') return '\r'
    if (token === 't') return '\t'
    if (token.startsWith('x')) return String.fromCharCode(Number.parseInt(token.slice(1), 16))

    return whole
  })
}
