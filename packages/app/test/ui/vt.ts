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

/** 此刻的一屏——**只含可见区**；存档另有其数。 */
export type VtScreen = {
  readonly columns: number
  readonly rows: number
  readonly lines: readonly VtLine[]
  /** 光标落在这一屏的哪儿（`x` 是列、`y` 是**屏内**行号——与 `viewportY` 无关）。 */
  readonly cursor: { readonly x: number; readonly y: number }
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

  return {
    write: (chunk) => {
      const next = queue.then(
        () =>
          new Promise<void>((resolve) => {
            terminal.write(chunk, () => resolve())
          }),
      )
      queue = next
    },

    settled: () => queue,

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
        cursor: { x: active.cursorX, y: active.cursorY },
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
