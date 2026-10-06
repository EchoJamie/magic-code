/**
 * **查看那一屏**（U110）——**终端的那一半**：备用屏、键、画。
 *
 * ## 它怎么拿到终端
 *
 * 由 `components/app.ts` 那一头经 **Ink 的 `suspendTerminal`** 借出来（那是 Ink 给
 * 「把终端交给一个子程序」开的那道门，文档里点的例子就是 `$EDITOR` / `less` / `fzf`）。
 * 借出来之后 Ink 那一侧**不画也不收键**（`onRender` 直接返回、`useInput` 的监听已摘），
 * 于是这一屏独占终端；还回去时 Ink **强制整帧重画**（`endSuspend` 把 `lastOutput` 清空），
 * 故它的帧账目与屏**又对得上**。
 *
 * ## 为什么是「备用屏」而不是在主屏上画
 *
 * `CSI ? 1 0 4 9 h`（enter alternative screen）＝**存光标 ＋ 切到备用缓冲 ＋ 清屏**；
 * 对应的 `l` 是**换回主缓冲 ＋ 还光标**。主缓冲那一整屏**一个字节都没动过**——这正是
 * 设计要的那条：「退出后回到对话原样，**对话的历史一个字不动**」。
 *
 * ⚠️ **备而不占**：这一屏上写的每一笔都落在备用缓冲里，退出即消失（不进 scrollback、
 * 不产生对话内容）——设计「这一屏只用来显示，不产生对话内容」。
 *
 * ## 三件自己来（Ink 那边不管，也不该让它管）
 *
 * `stdin` 的 **raw mode**（Ink 在 `pauseInput` 里关掉了，这一屏得自己开）、**键的解析**
 * （Ink 的解键那一支没导出，见下面 `parseScreenKeys` 的注）、**画**（整帧自己拼字节）。
 */

import { emitKeypressEvents, type Key } from 'node:readline'
import { PassThrough } from 'node:stream'
import { clip } from './components/composer.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync, writeFileSync } from 'node:fs'
import { displayWidth, PALETTE } from './components/lines.ts'
import type { LogLine } from './components/log.ts'
import type { LogRow, PendingDecision } from './view.ts'
import { decisionLayout } from './components/decision.ts'
import { matchesOf, screenKey, screenLayout, screenOpened, textOfLine, textOfLines } from './transcript.ts'
import type { ScreenKey, ScreenLayout, ScreenState } from './transcript.ts'
import type { UserImage } from './view.ts'

/** 进备用屏：存光标 ＋ 切缓冲 ＋ 清屏。 */
const ENTER_ALT = '\u001b[?1049h'
/** 出备用屏：换回主缓冲 ＋ 还光标。 */
const EXIT_ALT = '\u001b[?1049l'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'

/** 复用 Node 的流式解键器；未知控制序列丢弃，Esc 由解键器判定。 */
export function createScreenKeyParser(onKey: (key: ScreenKey) => void) {
  const stream = new PassThrough()
  emitKeypressEvents(stream)
  stream.on('keypress', (text: string | undefined, key: Key) => {
    const mapped = screenKeyOf(text, key)
    if (mapped !== null) onKey(mapped)
  })
  return { push: (chunk: string | Buffer) => { stream.write(chunk) }, close: () => stream.destroy() }
}
function screenKeyOf(text: string | undefined, key: Key): ScreenKey | null {
  if (key.ctrl) {
    if (key.name === 'o' || key.name === 'c') return {kind:'close'}
    if (key.name === 'u') return {kind:'halfUp'}
    if (key.name === 'd') return {kind:'halfDown'}
    return null
  }
  if (key.name === 'tab' && !key.shift && !key.meta) return {kind:'tab'}
  const mapped: Record<string, ScreenKey> = {
    up:{kind:'lineUp'}, down:{kind:'lineDown'}, pageup:{kind:'pageUp'}, pagedown:{kind:'pageDown'},
    escape:{kind:'cancel'}, return:{kind:'accept'}, enter:{kind:'accept'}, backspace:{kind:'backspace'},
  }
  if (key.name !== undefined && mapped[key.name] !== undefined) return mapped[key.name]!
  if (key.meta || key.sequence?.includes('\x1b') || text === undefined || /[\x00-\x1f\x7f]/.test(text)) return null
  return {kind:'text',text}
}
/** 完整输入的便捷入口；实际阅读始终使用持续 parser。 */
export function parseScreenKeys(text: string): readonly ScreenKey[] {
  if (text === '\x1b') return [{kind:'cancel'}]
  const keys: ScreenKey[] = []
  const parser = createScreenKeyParser(key => {
    const previous = keys.at(-1)
    if (key.kind === 'text' && previous?.kind === 'text') {
      keys[keys.length - 1] = { kind: 'text', text: previous.text + key.text }
    } else keys.push(key)
  })
  parser.push(text); parser.close()
  return keys
}

export type ScreenHost = {
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  /** 取此刻要画的那些行与尺寸（每次重画问一次——流式进来的新行据此上屏）。 */
  readonly read: () => { readonly rows: readonly LogRow[]; readonly columns: number; readonly screenRows: number; readonly pending?: PendingDecision | undefined }
  /** 底下那些变了就叫一声（可省）——**叫不叫只影响新内容几时上屏**，不影响键。 */
  /** 主界面需要呈现决策时，归还终端并保留阅读位置。 */
  readonly interrupted?: (() => boolean) | undefined
  /** 阅读期间仍显示现有待决策卡，Tab 归还给决策面板。 */
  readonly decide?: (() => void) | undefined
  readonly subscribe?: ((listener: () => void) => () => void) | undefined
  /** 开屏时从第几行起（阅读位置记着——设计：「退出保留原来的阅读位置」）。 */
  readonly title?: string
  readonly memberAction?: ((kind: 'input' | 'menu', top:number) => void) | undefined
  readonly startTop?: number | undefined
  /**
   * **加入本次输入**（U110）——把选中的那一处材料放回输入行。
   *
   * 由 `components/app.ts` 那一头接（它握着外壳：放回稿子是外壳的事）。这一屏**就此退出**
   * ——用户要的是接着打字，不是继续看。
   */
  readonly attach?: ((material: UserImage) => void) | undefined
  /**
   * **导出原图**（U110）——把那一张的字节落到一个本地文件上。
   *
   * 也由那一头接（字节在内核那一侧，要发一条命令）；这一屏**不退出**——出路是一条回执，
   * 而这条回执落的是**记录区**，也就是这一屏正在画的东西。
   */
  readonly exportImage?: ((material: UserImage) => void) | undefined
}

/**
 * 开这一屏，**一直转到用户退出**（`q` / `esc` / `ctrl+o`）。
 *
 * 返回**退出时的阅读位置**——调用方记着它，下次开屏从那儿起。
 */
export async function runScreen(host: ScreenHost): Promise<number> {
  const { stdin, stdout } = host
  let state = screenOpened(host.startTop ?? 0)
  let queued: ScreenKey[] = []
  let awake: (() => void) | null = null
  let dirty = false
  let closing = false

  const nudge = (): void => {
    dirty = true
    const go = awake
    awake = null
    go?.()
  }

  const parser = createScreenKeyParser(key => { queued.push(key); nudge() })
  const onData = (chunk: Buffer | string): void => { parser.push(chunk) }

  const raw = (on: boolean): void => {
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(on)
  }

  stdout.write(ENTER_ALT + HIDE_CURSOR)
  raw(true)
  stdin.resume()
  stdin.on('data', onData)
  stdout.on('resize', nudge)
  const unsubscribe = host.subscribe?.(nudge)

  try {
    /**
     * ⚠️ **次序是「先按键、再画」**（不是先画再按）：这一屏上按一下就该立刻看得见结果，
     * 而画在前头的话，那一帧画的还是**按之前**的状态——要等下一次唤醒才补上
     * （真帧上量到过：按了 `G` 屏上还停在顶上，按第二下才动）。
     */
    for (;;) {
      dirty = false
      if (host.interrupted?.()) break

      const { rows, columns, screenRows, pending } = host.read()
      const footer = pending === undefined ? [] : decisionLayout(pending, columns, screenRows, false).lines.map(line => ` │ ${line}`)
      const body = screenLayout(rows, { columns, screenRows: screenRows - footer.length - (host.title === undefined ? 0 : 1) })
      const layout = body

      const keys = queued
      queued = []

      for (const key of keys) {
        if (key.kind === 'tab' && pending !== undefined) { host.decide?.(); break }
        if (host.memberAction !== undefined && state.asking === null && state.picked === null && key.kind === 'text' && (key.text === 'i' || key.text === 'm')) { host.memberAction(key.text === 'i' ? 'input' : 'menu', state.top); closing = true; break }
        const step = screenKey(state, key, layout)
        if (step.kind === 'state') state = step.state
        if (step.kind === 'close') closing = true
        if (step.kind === 'edit') {
          state = await handToEditor(stdout, raw, layout, state)
          nudge()
        }
        // **加入本次输入**（U110）——交给外壳放回稿子，这一屏**就此退出**
        // （用户要的是接着打字；留在这一屏上看不见自己那句话）
        if (step.kind === 'attach') {
          host.attach?.(step.material)
          closing = true
        }
        // **导出原图**（U110）——发一条命令（字节在内核那一侧）；这一屏不退出，
        // 回执到了它会跟着重画（`subscribe` 那一头）
        if (step.kind === 'export') host.exportImage?.(step.material)
      }
      if (closing) break

      if (host.interrupted?.()) break
      const frame = screenFrame({ layout, state, columns, footer, hits: matchesOf(layout.lines, state.term),...(host.memberAction===undefined?{}:{hint:'↑↓ / PgUp PgDn · / 搜索 · i 补充 · m 操作 · Esc 返回'}) })
      stdout.write(host.title === undefined ? frame : `\x1b[H\x1b[0m${clip(host.title, columns)}\x1b[K\r\n` + frame.slice(3) )

      // 按过键（或按键那会儿底下又变了）⇒ 立刻再走一圈；否则等下一个动静
      if (dirty || queued.length > 0) continue

      await new Promise<void>((resolve) => { awake = resolve })
    }
  } finally {
    parser.close()
    stdin.off('data', onData)
    stdout.off('resize', nudge)
    unsubscribe?.()
    raw(false)
    // ⚠️ **不许 `stdin.pause()`**——`pause()` 会把这条流按停，而 Ink 的 `resumeInput`
    // （还终端那一跳）**只 ref ＋ setRawMode ＋ 挂回它自己的监听，不 resume**：按停了
    // 就再没人拉开，回来之后**一个键都收不到**（老帧套件实测踩到：退出那一屏之后打字
    // 屏上不动，直到超时）。我们从头到尾没 pause 过，这里也就不该 pause。
    stdout.write(SHOW_CURSOR + EXIT_ALT)
  }

  return state.top
}

/**
 * `v`——**把这一屏交给 `$VISUAL` / `$EDITOR`**（设计 · 查看那一节列的最后一档键）。
 *
 * 交货方式：**先出备用屏**（编辑器要的是终端本身，而不是我们这一屏的一角），把这一屏的
 * 纯文本落一份临时文件，起了编辑器等它回来，回来再进备用屏重画。
 *
 * ⚠️ **用的是 `$VISUAL` 优先**（那是「全屏编辑器」那一格，`$EDITOR` 是行编辑器那一格）
 * ——两个都没有就**说一句**（「不静默吞键」），不装成做过。
 *
 * ⚠️ **限度**：编辑器退出后它画在主屏上的东西**我们不擦**（擦不了——那一屏的内容不归我们
 * 记帐；`less` 那类分页器当年也一样）。下一步进备用屏重画，主屏那一头由 Ink 还回终端时
 * **整帧重画**它自己那一块。
 */
async function handToEditor(
  stdout: NodeJS.WriteStream,
  raw: (on: boolean) => void,
  layout: ScreenLayout,
  state: ScreenState,
): Promise<ScreenState> {
  const editor = (process.env['VISUAL'] ?? '') !== '' ? (process.env['VISUAL'] as string) : (process.env['EDITOR'] ?? '')
  if (editor.trim() === '') return { ...state, note: '没有 $VISUAL / $EDITOR——这一份看不了别的' }

  const path = join(tmpdir(), `magic-transcript-${process.pid}.txt`)
  writeFileSync(path, textOfLines(layout.lines), 'utf8')

  stdout.write(SHOW_CURSOR + EXIT_ALT)
  raw(false)

  try {
    const [command, ...args] = editor.split(/\s+/).filter((piece) => piece !== '')
    const child = Bun.spawn([command as string, ...args, path], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await child.exited
  } catch (error) {
    return { ...state, note: `起不了编辑器：${String(error)}` }
  } finally {
    try {
      unlinkSync(path)
    } catch {
      // 临时文件删不掉不影响读——留着就留着（不再拿它兜底）
    }
  }

  stdout.write(ENTER_ALT + HIDE_CURSOR)
  raw(true)

  return { ...state, note: null }
}

/**
 * 一整帧的字节——**纯函数**（给排版、状态与尺寸就有；单测与真帧都拿它比）。
 *
 * 形制：
 * - `CSI H` 归位（左上角）——**整屏重画**，不做增量（这一屏是自己的地盘，没有别人的帧账要顾）；
 * - 内容区 `height` 行 ＋ 底下**一条状态行**（＝屏高那一行：位置 · 命中 · 键位提示）；
 * - 每行末尾 `CSI K` 擦到行尾（上一帧比这一帧长时不留残影）。
 */
export function screenFrame(input: {
  readonly layout: ScreenLayout
  readonly state: ScreenState
  readonly columns: number
  readonly hits: readonly number[]
  readonly hint?: string
  readonly footer?: readonly string[]
}): string {
  const { layout, state, columns, hits } = input
  const rows: string[] = []

  for (let at = 0; at < layout.height; at += 1) {
    const line = layout.lines[state.top + at]
    const row = state.top + at
    // 命中与选中都用反显（同一屏上「被标出来的那一行」只有一种样子）
    const lit = (state.term !== '' && hits.includes(row)) || state.picked === row
    rows.push(line === undefined ? '' : paintLine(line, columns, lit))
  }
  rows.push(paintStatus(layout, state, columns, hits.length,input.hint), ...(input.footer ?? []))

  return `\u001b[H${rows.map((row) => `${row}\u001b[0m\u001b[K`).join('\r\n')}`
}

/** 一行的字节——色段 ＋ 底色（用户行那一条整行淡青，同记录区）。 */
function paintLine(line: LogLine, columns: number, highlight: boolean): string {
  if (line.segments.length === 0) {
    return line.background === undefined ? '' : `${background(line.background)}${' '.repeat(columns)}`
  }

  const body = line.segments.map((piece) => paintSegment(piece.text, piece.color, piece.bold)).join('')
  // ⚠️ **底色要铺满整行**（同记录区那条：短句子不能看着像块小补丁）
  const tail = line.background === undefined ? '' : `${background(line.background)}${' '.repeat(Math.max(0, columns - displayWidth(textOfLine(line))))}`
  // **命中那一行反显**——搜到的每一行都标出来（`n` / `N` 跳的就是它们）
  const head = highlight ? '\u001b[7m' : ''
  const end = highlight ? '\u001b[27m' : ''

  return `${head}${body}${tail}${end}`
}

/** 底下一那条状态行——位置 · 命中 · `note` · 键位提示（窄窗从右往左省）。 */
function paintStatus(layout: ScreenLayout, state: ScreenState, columns: number, found: number,hint=SCREEN_HINT): string {
  const total = layout.lines.length
  const place = total === 0
    ? '（还没有记录）'
    : `${state.top + 1}–${Math.min(total, state.top + layout.height)} / ${total} 行`

  // 打字那一档：把词与光标摆出来（这一屏此刻归搜索）
  if (state.asking !== null) {
    return faint(clip(`搜索：${state.asking}▏  ·  Enter 跳过去 · Esc 取消`, columns))
  }

  const searched = state.term === ''
    ? ''
    : `  ·  /${state.term} 第 ${found === 0 ? 0 : state.at + 1}/${found} 处`

  /**
   * **选中一处材料时才给那两条动作**（U110 · 反向判据）：没选的时候底下这行**一个字都不提**
   * 它们——照旧只报位置与翻页键；选了才出来，而且说的是**这一条**的名字。
   */
  const picked = state.picked === null ? undefined : layout.materials.find((one) => one.line === state.picked)
  const actions = picked === undefined
    ? ''
    : `  ·  ${picked.image.marker} · ${picked.image.name}：Enter 加入本次输入 · e 导出原图`

  const tail = state.note !== null
    ? `  ·  ${state.note}`
    : `${searched}${actions}  ·  ${hint}`

  return faint(clip(`${place}${tail}`, columns))
}

/**
 * 底下那行键位提示——**设计那一节列的键位就是这一串**（一屏提示按语义去重：
 * 同一件事只说一遍）。
 *
 * ⚠️ **写短是量出来的**：100 列那一档，左边那句「1–29 / 112 行」加这一串**要放得下**——
 * 早先那版（每一项都带全称）到 `{/}` 就被裁掉，`q 退出` 干脆看不见（而它是**退出**键，
 * 最不该被省的那个）。故只在认不出意思的那几个后面留一句短的，其余只报键。
 */
const SCREEN_HINT = '↑↓ 移动 · PgUp/PgDn 翻页 · / 搜索 · n/N · Esc 返回'

function paintSegment(text: string, color?: string, bold?: boolean): string {
  const head = `${bold === true ? '\u001b[1m' : ''}${color === undefined ? '' : foreground(color)}`

  return `${head}${text}\u001b[22m\u001b[39m`
}

/** 一行淡色（状态行用——与记录区那几条提示同一个色）。 */
function faint(text: string): string {
  return `${foreground(PALETTE.faint)}${text}\u001b[39m`
}

function foreground(color: string): string {
  const rgb = rgbOf(color)

  return rgb === null ? '' : `\u001b[38;2;${rgb}m`
}

function background(color: string): string {
  const rgb = rgbOf(color)

  return rgb === null ? '' : `\u001b[48;2;${rgb}m`
}

/** `#rrggbb` → `r;g;b`（不认的色号**什么都不发**——宁可用默认前景，也不发一个假色）。 */
function rgbOf(color: string): string | null {
  const matched = /^#([0-9a-f]{6})$/i.exec(color)
  if (matched === null) return null

  const value = Number.parseInt(matched[1] as string, 16)

  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
}
