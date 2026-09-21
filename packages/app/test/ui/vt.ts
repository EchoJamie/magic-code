/**
 * 界面验收 · 终端模型（U40）——**字节按真实时序喂进去，读回此刻的屏**。
 *
 * ## 与仓里既有那一支的关系（先读这段，别急着当重复实现）
 *
 * `packages/tui/test/terminal.ts` 已有一支「录字节 → 放成屏幕」：**一次性**把一整段
 * 字节喂进 `@xterm/headless`，读回矩阵。那支服务的是**离线标本**（一帧一录）。
 *
 * 这一层要的是**活的那只**：进程还在跑、字节还在长、窗口还会变。两者的差别不在读法，
 * 在**喂法**——故本文件与它共用同一支 VT 模型、同一组关键选项（`convertEol` /
 * `allowProposedApi`）、同一套字格读法（`getChars/getWidth/isBold/…`，按**非零**判位段），
 * 只把「喂」这半边换成增量：
 *
 * - **逐块写**——stdout 来一块喂一块，不攒到结束（攒＝把异步次序压平成一个快照）；
 * - **resize 就地生效**——窗口变化插在字节序列的**那一刻**（旧字节按旧宽度解过、
 *   新字节按新宽度解），而不是「全部历史按最终尺寸重放」；
 * - **可释放**——长活的那台 VT 用完要 `dispose()`（离线那支一次一开，不涉及这一条）。
 *
 * ⚠️ **跨包引用被守护挡住**（`test/scaffold.test.ts`：相对路径跨包＝越界；
 * `@magic/tui` 的公开面只出 `.`）——故这里**不是** import 它，而是照同一读法写这一层。
 * 不自己发明 ANSI 解析、宽度算法或行模型：那些**全在 VT 模型里**（这正是「取件不自造」）。
 *
 * ## 三处踩过的坑（都按实测写死）
 *
 * 1. **`convertEol` 在这一档是无害的（幂等）**——真 PTY 的 line discipline 开着 `ONLCR`
 *    （`\n` 到我们手上已经是 `\r\n`，实测：子进程写一个 `\n`，master 收到 `\r\n`），
 *    故这一开关不会再补一次回车；留着它是**防另一个方向**：万一哪天 pty 关了 `opost`，
 *    没有它就读成「只下移不回列」——列号一路累积，屏上每行往前缩一截，
 *    **真缺陷与假缺陷混在一起分不出来**。
 * 2. **读屏必须按可见区**——内联渲染下内容会滚进 scrollback：`viewportY` 一变，
 *    第 0 行就不是屏幕上那第 0 行了（实测：resize 之后 `viewportY = 10`）。
 *    「当前屏」＝ `[viewportY, viewportY + rows)`，其余归存档。
 * 3. **读格前要等写完**——`write()` 是异步解析的，不等回调就读会读到半截屏，故本层
 *    把每次写接成一条**队列**（`settled()` 等它落地）。
 * 4. **按「同步更新」切帧**（D30）——见 `splitFrames` 的注：应用画一帧是**事务性**的，
 *    屏上该落的是画完的整帧。
 */

import { Terminal } from '@xterm/headless'
import type { IBufferCell } from '@xterm/headless'

/** 一格的样子——与仓里既有读法**同口径**（右半宽字符格 `text` 为空串、`width` 为 0）。 */
export type VtCell = {
  readonly text: string
  readonly width: number
  /** 前景色：`#rrggbb` · `ansi:N` · `null`（默认色）。 */
  readonly fg: string | null
  readonly bg: string | null
  readonly bold: boolean
  readonly strikethrough: boolean
  /** 反显（输入行那只「光标」早年就是这么画的；U31 真光标落地后仍可能有）。 */
  readonly inverse: boolean
}

/** 可见屏的一行。 */
export type VtLine = {
  /** 屏幕矩阵里的行号（0 ＝ 可见区顶行）。 */
  readonly row: number
  readonly text: string
  /** 终端自己折出来的续行（＝上游写宽了）。 */
  readonly wrapped: boolean
}

/**
 * 光标这一刻的样子——**坐标只有这一套**（`x` 是列、`y` 是**屏内**行号，与 `viewportY` 无关），
 * 另带一格**终端自己说的显隐**。
 *
 * 为什么要显隐：U31 那支真光标落地之后，应用（Ink）**起手就把终端光标藏了**，自己另画
 * 一个——而「藏起来的那个光标」停在下方回退位上，只按坐标画出来就是**把没显示的光标画给人看**
 * （规划侧看帧时点出来的）。故显隐必须跟坐标一起记，查看页才画得对。
 */
export type VtCursor = {
  readonly x: number
  readonly y: number
  /** 藏没藏（DECTCEM）——`CSI ?25l` 藏 / `CSI ?25h` 显 / 软复位 `CSI !p` 回到显。 */
  readonly hidden: boolean
}

/** 此刻的一屏——**只含可见区**；存档另有其数。 */
export type VtScreen = {
  readonly columns: number
  readonly rows: number
  readonly lines: readonly VtLine[]
  readonly cursor: VtCursor
  /** 可见区之上压着多少行（滚进 scrollback 的）——「屏上还有没有它」看这个数。 */
  readonly scrollback: number
  /** 缓冲总行数（含 scrollback）。 */
  readonly total: number
  /**
   * **整个缓冲**的文本（顶 → 底，含滚进 scrollback 的），右侧空白已裁。
   *
   * 与 `lines` 的分工：`lines` 是**此刻看得见**的那一屏（判「屏上有没有」用它）；
   * `history` 是**到过屏上的全部**——判「记录有没有丢 / 有没有重」得看它：
   * 记录区会滚动，只比可见那一截，滚出去的行就成了「丢了」（实测踩过）。
   */
  readonly history: readonly string[]
  /** 第 `row` 行的格子（到最后一个非空格为止）。 */
  cellsOf(row: number): readonly VtCell[]
  /** 第 `row` 行的格子，**含右侧空白**（整行 `columns` 格）——量「铺到哪」用它。 */
  rawCellsOf(row: number): readonly VtCell[]
}

export type Vt = {
  /** 喂一块字节（按到达次序）。 */
  write(chunk: string): void
  /** 等已喂的字节全部解析完——读屏之前必等（坑 3）。 */
  settled(): Promise<void>
  /**
   * **屏对应的字节水位**——已经交给 VT、屏上算数的那一段有多长（见 `splitFrames`）。
   *
   * 为什么要有这一格：取了帧就要说得出「这一屏是应用写到哪儿的样子」。它必须与屏
   * **同刻**取（两条语句挨着、中间不许有 `await`）——不然记下的数落在后面，帧就
   * 「落后于自己标注的字节数」（D30）。
   *
   * ⚠️ 它与「应用一共写出了多少字节」**不是一回事**：应用正写在半截的那一帧还没交出去，
   * 那一截不算。不认同步更新的应用（如探针）两者恒等。
   */
  screenBytes(): number
  /** 改窗口尺寸：**就地**生效（此后的字节按新宽度解）。 */
  resize(columns: number, rows: number): void
  /** 此刻的一屏。 */
  screen(): VtScreen
  /** 整个缓冲的文本（含 scrollback）——「不在屏上、但确实到过」的对照物。 */
  bufferText(): string
  dispose(): void
}

export type VtOptions = {
  readonly columns: number
  readonly rows: number
  /** 存档行数上限（缺省 2000）——**有界**，触界即丢最旧的（`run.json` 记这个数）。 */
  readonly scrollback?: number
}

/**
 * 开一台长活 VT。
 *
 * ⚠️ 尺寸**不是常量**：`resize()` 会就地改它——故内部处处取当前值，不缓存构造时的那个。
 */
export function createVt(options: VtOptions): Vt {
  const terminal = new Terminal({
    cols: options.columns,
    rows: options.rows,
    scrollback: options.scrollback ?? 2_000,
    // 见文件头注 1：真 pty 下幂等，留着防另一头
    convertEol: true,
    // 6.x 里 `viewportY` 这类读数仍挂在 proposed API 上（仓里既有那一支同样开着）
    allowProposedApi: true,
  })

  let queue: Promise<void> = Promise.resolve()
  let columns = options.columns
  let rows = options.rows
  /** 收到、但还没交给 VT 的那一截——**应用正写在半截的那一帧**（见 `splitFrames`）。 */
  let pending = ''
  /** 已交给 VT 的字节数＝屏对应的水位（`screenBytes`）。 */
  let consumed = 0

  const buffer = (): Terminal['buffer']['active'] => terminal.buffer.active

  const rawCellsOf = (row: number): readonly VtCell[] => {
    const line = buffer().getLine(row)
    if (line === undefined) return []

    const cells: VtCell[] = []
    for (let x = 0; x < columns; x += 1) {
      const cell = line.getCell(x)
      if (cell === undefined) break
      cells.push(readCell(cell))
    }

    return cells
  }

  /** 交给 VT 解析（接在同一条队列上——次序即语义）。 */
  const feed = (chunk: string): void => {
    const next = queue.then(
      () =>
        new Promise<void>((resolve) => {
          terminal.write(chunk, () => resolve())
        }),
    )
    queue = next
  }

  return {
    write: (chunk) => {
      const { ready, rest } = splitFrames(pending + chunk)
      pending = rest
      if (ready === '') return
      consumed += Buffer.byteLength(ready, 'utf8')
      feed(ready)
    },

    settled: () => queue,

    screenBytes: () => consumed,

    resize: (nextColumns, nextRows) => {
      columns = nextColumns
      rows = nextRows
      // 就地在队列**之间**改：已喂的字节仍按旧宽度解完，之后的按新宽度解（顺序即语义）
      const resized = queue.then(() => {
        terminal.resize(nextColumns, nextRows)
      })
      queue = resized
    },

    screen: () => {
      const active = buffer()
      const top = active.viewportY
      const lines: VtLine[] = []

      for (let y = 0; y < rows; y += 1) {
        const line = active.getLine(top + y)
        lines.push({
          row: y,
          // 右侧空白裁掉（同仓里既有的 `translateToString(true)` 口径再加一道——
          // 带属性的空格也算内容，铺了背景的行靠这一道才与「文本面」同形）
          text: line === undefined ? '' : line.translateToString(true).replace(/\s+$/u, ''),
          wrapped: line?.isWrapped ?? false,
        })
      }

      const history: string[] = []
      for (let y = 0; y < active.length; y += 1) {
        history.push(active.getLine(y)?.translateToString(true).replace(/\s+$/u, '') ?? '')
      }

      return {
        columns,
        rows,
        lines,
        cursor: { x: active.cursorX, y: active.cursorY, hidden: cursorHiddenIn(terminal) },
        scrollback: top,
        total: active.length,
        history,
        cellsOf: (row) => {
          const cells = rawCellsOf(top + row)
          let end = cells.length
          while (end > 0 && (cells[end - 1] as VtCell).text.trim() === '') end -= 1

          return cells.slice(0, end)
        },
        rawCellsOf: (row) => rawCellsOf(top + row),
      }
    },

    bufferText: () => {
      const active = buffer()
      const out: string[] = []
      for (let y = 0; y < active.length; y += 1) {
        out.push(active.getLine(y)?.translateToString(true).replace(/\s+$/u, '') ?? '')
      }

      return out.join('\n')
    },

    dispose: () => terminal.dispose(),
  }
}

/**
 * 应用画一帧，两头各发一次「同步更新」——`CSI ?2026h` 起、`CSI ?2026l` 止。
 *
 * 这就是 Ink 的帧协议（`ink/build/write-synchronized.js` 的 `bsu` / `esu`，`ink.js` 每次渲染
 * 两头各写一次；实测本仓外壳的字节流里严格交替出现）。
 */
const SYNC_ON = '\u001b[?2026h'
const SYNC_OFF = '\u001b[?2026l'
const SYNC_LEN = SYNC_ON.length

/**
 * 把收到的字节切成「**已经画完的整帧**」与「还在写的那一截」。
 *
 * ## 为什么要切
 *
 * 认得同步更新的终端，在 `l` 那一下**整帧一次落地**：起手擦掉旧帧、中间那一段（**擦完了
 * 还没画**）谁也看不见（2026 就是为这个发明的）。不切会出什么，D30 有实测：取帧正好落在
 * 那个空档里，存下来的帧就是「半截帧」——屏上是空的，而它自己标注的字节数里那一段明明
 * 已经写出来了。
 *
 * ⚠️ **本层的 VT 不认这个开关**：xterm 只**记**这个模式（`modes.synchronizedOutputMode`
 * 有这一格），缓冲区照样来一块写一块（读它源码见 resetMode/setMode 里那个 `case 2026`——
 * 只置一位、不推迟任何写入）。所以我们**自己切**：只把画完的整帧交出去。
 *
 * ## 怎么切
 *
 * `pending` 一定从「块外」开始（上一轮把块外那一段都切走了），故扫一遍就够：
 *
 * - 遇 `h` 找配对的 `l`：找着 ⇒ 整帧画完了，切点推过去；找不着 ⇒ **正写在半截**，切点停在 `h` 之前；
 * - 再没有 `h` ⇒ 后面不会有块了，剩下的全能交（**不认这套协议的应用恒等＝照旧立刻落屏**）；
 * - `pending` 末尾若是**半个标记**（标记被切在两块之间），这一段也不切——切过去就把
 *   「还没画完」误判成「画完了」。
 *
 * ## 已知限度
 *
 * 半截那一帧的**解析**也一并推迟了。真终端推迟的只是**显示**、字节照样即到即解，故
 * 「一帧写到一半时改窗」这种情形本层与真终端会有出入。应用收到 `SIGWINCH` 之后整帧重画，
 * 下一帧按新宽度落地，稳态一致；D27 那几条判据看的是**改窗之后的字节**（`writtenFrame`），
 * 不经这一层，不受影响。
 */
function splitFrames(pending: string): { ready: string; rest: string } {
  let cut = 0
  let scan = 0

  for (;;) {
    const open = pending.indexOf(SYNC_ON, scan)
    if (open === -1) {
      cut = pending.length
      break
    }
    const close = pending.indexOf(SYNC_OFF, open + SYNC_LEN)
    if (close === -1) {
      cut = open
      break
    }
    cut = close + SYNC_LEN
    scan = cut
  }

  const at = Math.min(cut, Math.max(0, pending.length - partialMarkerTail(pending)))

  return { ready: pending.slice(0, at), rest: pending.slice(at) }
}

/**
 * `pending` 末尾那**半个标记**有多长（不是半个就是 0）——取最长的那一截。
 *
 * 标记是逐块到的，`\u001b[?2` 这种半截完全正常；照它算进「画完了」就会漏掉后面那个 `l`，
 * 于是**永远**停在「块里」、之后一个字节都不落屏。
 */
function partialMarkerTail(pending: string): number {
  for (let len = Math.min(SYNC_LEN - 1, pending.length); len >= 1; len -= 1) {
    const tail = pending.slice(pending.length - len)
    if (SYNC_ON.startsWith(tail) || SYNC_OFF.startsWith(tail)) return len
  }

  return 0
}

/**
 * 终端此刻**藏没藏光标**。
 *
 * ⚠️ 这一格只能从 xterm 的**内部面**读（`coreService.isCursorHidden`）：它没进公开的
 * `IModes`（那张表是 SM/DECSET 那批，没有 DECTCEM）。读的是**它自己的解析状态**——
 * 不自己扫字节找 `?25l`（那＝另造一套 VT，见文件头注）。内部面哪天不在了就退回 `false`
 * （＝照旧画），那是**看得见**的退化，不会悄悄少画一个光标。
 */
function cursorHiddenIn(terminal: Terminal): boolean {
  const core = (terminal as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core

  return core?.coreService?.isCursorHidden ?? false
}

/**
 * 一格的样子。
 *
 * ⚠️ **位段按非零判**：xterm 的 `isBold()` / `isStrikethrough()` / `isInverse()`
 * 返回的是**掩过位的位段**（`isBold()` 加粗时是 `134217728`），写成 `=== 1` 永远为假
 * ——判据当场空转，且「谁都没加粗」看着还挺像那么回事（仓里既有一支的注记）。
 */
function readCell(cell: IBufferCell): VtCell {
  return {
    text: cell.getChars(),
    width: cell.getWidth(),
    fg: colorOf(cell, 'fg'),
    bg: colorOf(cell, 'bg'),
    bold: cell.isBold() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
    inverse: cell.isInverse() !== 0,
  }
}

/** 格子的颜色——`#rrggbb` / `ansi:N` / `null`（默认色）。 */
function colorOf(cell: IBufferCell, which: 'fg' | 'bg'): string | null {
  const isDefault = which === 'fg' ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault === true) return null

  const isRgb = which === 'fg' ? cell.isFgRGB() : cell.isBgRGB()
  const value = which === 'fg' ? cell.getFgColor() : cell.getBgColor()

  return isRgb === true ? `#${value.toString(16).padStart(6, '0')}` : `ansi:${value}`
}
