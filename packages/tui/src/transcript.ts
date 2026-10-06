/**
 * **查看那一屏**（U110 · 设计 · 终端交互「查看：另开一屏」）——**纯的那一半**。
 *
 * ## 这一屏是什么
 *
 * 对话照旧内联（主缓冲、终端自己的滚动条，见 `components/app.ts`）；**要细看时另开一屏**：
 * `ctrl+o` 把终端切到**备用屏**、画满一整屏，**只用来显示**，退出后对话原样。
 * 本文件只管那一屏上**画什么、键位怎么走**——不碰终端、不碰 stdin（那一半在 `./screen.ts`）。
 *
 * ## 三件都是既有那套的复用，没有第二套
 *
 * - **行**：`logLines(rows, { expanded: true })`——就是记录区那一支纯函数，只是**展开态**
 *   （设计：「**里面不折**——要看的都在那儿」）。故工具正文、思考、diff 全量都在，
 *   折叠那条 `… 还有 N 行` 在这儿**一行都不会出现**（它就是「折」本身）。
 * - **折行**：仍按 `columns` 折——那一支已经在里面了。⚠️ **此「折」非彼「折」**：
 *   **折行**（wrap，按宽度换行）照旧，**折叠**（fold，藏起来只报行数）在这儿没有——
 *   设计那句「视图里没有『折行』这个类别要你导航」说的是**后者**（导航的单位是用户的
 *   单位：一条交代、一处命中，不是我们的裁剪单位）。
 * - **导航的单位是「用户交代」**（`{` / `}`）——判据同设计那一条：**用用户的单位，
 *   不用我们的裁剪单位**。故锚点是 `kind === 'user'` 那几条的**头一行**。
 */

import { rowDrawn, rowLines, spacerWalk } from './components/log.ts'
import type { LogLine } from './components/log.ts'
import { PALETTE } from './components/lines.ts'
import type { LogRow, UserImage } from './view.ts'

/** 一行的缩进（与记录区同一格：`components/log.ts` 的 `INDENT`）。 */
const INDENT = '  '

/**
 * **一屏上的一处材料**（U110）——它落在第几行，以及它是哪一张图。
 *
 * 两格缺一不可：「第几行」是给光标与反显用的（选中＝选中那一行），「哪一张」是给两个
 * 动作用的（放回输入要 `blob` / 位置，导出要 `blob` / 名字 / 类型）。
 */
export type MaterialSpot = {
  /** 这一处在显示行里的下标（`lines` 的坐标）。 */
  readonly line: number
  readonly image: UserImage
}

/** 一屏的排版——**纯的**（给视图与尺寸就有；取帧与快照据此确定）。 */
export type ScreenLayout = {
  /** 全部显示行（展开态、已按列数折好）。 */
  readonly lines: readonly LogLine[]
  /**
   * 每一条**用户交代**的头一行下标（`{` / `}` 跳的就是它）。
   *
   * 空的那几条不进来（`rowDrawn` 为假＝一行都不占，它没有「头一行」可跳）。
   */
  readonly turns: readonly number[]
  /**
   * 这一屏上的**材料行**（有图的那几条交代，一张一行）——`[` / `]` 跳的就是它们。
   *
   * ⚠️ **它们只在那一屏上长出来**（内联那一半一个字都不加：对话保持原样，见设计
   * 「对话保持内联不变」）。故这几行由本函数自己接在所属那条交代的后面，
   * **不经过 `rowLines`**——那条路是内联与这一屏共用的。
   */
  readonly materials: readonly MaterialSpot[]
  /** 内容区几行——屏高减掉底下那一条状态行。 */
  readonly height: number
  /** 能滚到的最远位置（`lines.length - height`，不小于 0）。 */
  readonly maxTop: number
}

/**
 * 视图 → 一屏——**走一遍**（分段那笔账只有走一遍才算得准：`spacerWalk` 那一支）。
 *
 * ⚠️ **行取自 `settled` ＋ `rows` 两段**（整条对话：已定局的 ＋ 本轮还在变的）——
 * 这一屏看的是**整条记录**，不是「本轮那一小块」。分段（块与块之间那一整行）按
 * `spacerWalk` 走一遍的结果给（**别每条各走一次账**——分段看的是上一条，那样会当场分家）。
 */
export function screenLayout(
  rows: readonly LogRow[],
  options: { readonly columns: number; readonly screenRows: number },
): ScreenLayout {
  const columns = Math.max(4, options.columns)
  const screenRows = options.screenRows
  const { flags } = spacerWalk(rows, true)
  const lines: LogLine[] = []
  const turns: number[] = []
  const materials: MaterialSpot[] = []

  rows.forEach((row, index) => {
    const spaced = flags[index] === true
    // ⚠️ **锚落在交代自己的头一行上，不是它前面那一行留白**（`spaced` 时 `rowLines` 会先吐
    //    一个空行）——跳过去之后屏顶该是「› 你那句话」，不是一条空白。
    if (row.kind === 'user' && rowDrawn(row, true)) turns.push(lines.length + (spaced ? 1 : 0))
    // ⚠️ 直接问 `rowLines`（带上**整列**那趟走出来的 `spaced`）——`logLines([row])` 会**自己
    //    再走一遍单条的分段账**（单条恒为「不留」），那样块与块之间那一整行就全没了。
    lines.push(...rowLines(row, { columns, expanded: true, spaced }))

    // **材料行**（U110）——紧跟在它那条交代后面（「材料按它在交代里的原位置出现」：
    // 每一处在正文里的位置由那句原话自己写着，这一行是**对那一处的认领**）。
    if (row.kind !== 'user' || row.images === undefined) return
    for (const image of row.images) {
      materials.push({ line: lines.length, image })
      lines.push({
        key: `r:m:${row.key}:${image.marker}`,
        segments: [{ text: `${INDENT}▣ ${image.marker} · ${image.name}`, color: PALETTE.faint }],
      })
    }
  })

  const height = Math.max(1, Math.floor(screenRows) - 1)
  const maxTop = Math.max(0, lines.length - height)

  return { lines, turns, materials, height, maxTop }
}

/**
 * 这一屏此刻的样子——**只这一份**（钥匙在 `./screen.ts` 那个死循环里）。
 *
 * `asking` 与 `term` 是**两格**（不是一个字符串加一个标志位）：
 * 「正在打的那个词」与「已经搜的那个词」在用户那儿本来就是两件事——打一半改主意按 `Esc`
 * **不该把上一次搜的结果也抹掉**（抹了就成「按了没反应」：高亮没了、`n` 也没得跳）。
 */
export type ScreenState = {
  /** 滚到第几行起（显示坐标系）。 */
  readonly top: number
  /** **正在打的那一段搜索词**（`null` ＝ 不在打字那一档）。 */
  readonly asking: string | null
  /** **已确认的搜索词**（`''` ＝ 没搜过）。 */
  readonly term: string
  /** 停在第几处命中（`term` 为空时无意义）。 */
  readonly at: number
  /**
   * **选中的那一处材料**（U110）——它在显示行里的下标；`null` ＝ 一处都没选。
   *
   * 反正在**反向判据**上：**没选**的时候那两个动作（加入本次输入 / 导出原图）
   * **一个字都不出现**（底下那行照旧只报位置与翻页键）；选了才出来，且只作用于这一处。
   */
  readonly picked: number | null
  /** 说一句就走的一行（`v` 没有编辑器时那一类）——**不静默吞键**。 */
  readonly note: string | null
}

/** 开屏时的初值——**阅读位置记着**（设计：「退出保留原来的阅读位置」）。 */
export function screenOpened(top = 0): ScreenState {
  return { top: Math.max(0, Math.trunc(top) || 0), asking: null, term: '', at: 0, picked: null, note: null }
}

/** 这一屏认的键（终端那半边把字节翻成这些，见 `./screen.ts` 的 `parseScreenKeys`）。 */
export type ScreenKey =
  | { readonly kind: 'tab' }
  | { readonly kind: 'lineUp' }
  | { readonly kind: 'lineDown' }
  | { readonly kind: 'halfUp' }
  | { readonly kind: 'halfDown' }
  | { readonly kind: 'pageUp' }
  | { readonly kind: 'pageDown' }
  | { readonly kind: 'top' }
  | { readonly kind: 'bottom' }
  | { readonly kind: 'turnUp' }
  | { readonly kind: 'turnDown' }
  | { readonly kind: 'materialPrev' }
  | { readonly kind: 'materialNext' }
  | { readonly kind: 'materialExport' }
  | { readonly kind: 'search' }
  | { readonly kind: 'matchNext' }
  | { readonly kind: 'matchPrev' }
  | { readonly kind: 'edit' }
  | { readonly kind: 'close' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'accept' }
  | { readonly kind: 'cancel' }

/** 一个键对这一屏做了什么。 */
export type ScreenStep =
  | { readonly kind: 'state'; readonly state: ScreenState }
  | { readonly kind: 'close' }
  | { readonly kind: 'edit' }
  /**
   * **加入本次输入**（U110）——把选中的那一处材料放回输入行（**插回原位置**）。
   *
   * ⚠️ 这一支**回对话**（那一屏就此退出）：用户要的就是「接着打字」——留在那一屏上
   * 看不见自己那句话。归谁做的分寸：放回输入行是**稿子**的事（`shell.ts` 的
   * `attachMaterial`），这一层只把「哪一处」带出去。
   */
  | { readonly kind: 'attach'; readonly material: UserImage }
  /**
   * **导出原图**（U110）——把那一张的字节落到一个本地文件上、把路径交回。
   *
   * ⚠️ 这一支**不回对话**：出路是一条回执（`image.exported` → 记录区那一行），
   * 而这一屏画的正是那条记录——**它就落在这儿**，用户接着看不用走。
   */
  | { readonly kind: 'export'; readonly material: UserImage }
  /** 认下了、但什么都不用做（如不在搜字时按 `n`）。 */
  | { readonly kind: 'none' }

/** 一处命中在第几行。 */
export function matchesOf(lines: readonly LogLine[], term: string): readonly number[] {
  if (term === '') return []

  const needle = term.toLowerCase()
  const hits: number[] = []

  lines.forEach((line, index) => {
    if (textOfLine(line).toLowerCase().includes(needle)) hits.push(index)
  })

  return hits
}

/** 一行的可见文字（色段拼起来——判据与 `$EDITOR` 那份都用它）。 */
export function textOfLine(line: LogLine): string {
  return line.segments.map((piece) => piece.text).join('')
}

/** 整屏的纯文本（`v` 交给 `$EDITOR` 的那一份）。 */
export function textOfLines(lines: readonly LogLine[]): string {
  return lines.map(textOfLine).join('\n')
}

/**
 * 一个键走一步——**这一屏的全部语义都在这一支里**（纯函数，可单测）。
 *
 * 三段分工：
 * - **在打搜索词**（`asking !== null`）时，这一屏归搜索：可见字符进词、退格删一个字、
 *   回车确认、`Esc` 取消。⚠️ **其余键一个都不认**（`j` / `q` 那一批此刻是搜索词里的字吗？
 *   不——它们不是可见的搜索字符，落进来只会让「打字」与「翻页」两件事抢同一个键）。
 * - **不在打**时：滚 / 跳 / 搜 / 退出。
 * - `q` / `Esc` / `ctrl+o` 都走 `close`（设计：「`q` / `esc` 也退出」）。
 */
export function screenKey(state: ScreenState, key: ScreenKey, layout: ScreenLayout): ScreenStep {
  const moved = (top: number): ScreenStep => movedTo(state, top, layout)

  if (state.asking !== null) {
    switch (key.kind) {
      case 'text':
        return { kind: 'state', state: { ...state, asking: state.asking + key.text } }
      case 'backspace':
        return { kind: 'state', state: { ...state, asking: state.asking.slice(0, -1) } }
      case 'cancel':
        return { kind: 'state', state: { ...state, asking: null } }
      case 'accept':
        return { kind: 'state', state: accepted(state, layout) }
      case 'lineUp':
        return moved(state.top - 1)
      case 'lineDown':
        return moved(state.top + 1)
      default:
        // ⚠️ **`Esc` 那一档走 `cancel`**（上面那一支）——打字期间其余键一律不认：
        // 这一屏此刻是**在打一个词**，翻页与退出得等打完（`Esc` 取消、回车确认）。
        return { kind: 'none' }
    }
  }

  switch (key.kind) {
    case 'lineUp':
      return moved(state.top - 1)
    case 'lineDown':
      return moved(state.top + 1)
    case 'halfUp':
      return moved(state.top - Math.max(1, Math.floor(layout.height / 2)))
    case 'halfDown':
      return moved(state.top + Math.max(1, Math.floor(layout.height / 2)))
    case 'pageUp':
      return moved(state.top - layout.height)
    case 'pageDown':
      return moved(state.top + layout.height)
    case 'top':
      return moved(0)
    case 'bottom':
      return moved(layout.maxTop)
    case 'turnUp':
      return moved(turnBefore(layout.turns, state.top))
    case 'turnDown':
      return moved(turnAfter(layout.turns, state.top))
    // —— 材料（U110）：`[` / `]` 上一条 / 下一条；回车＝加入本次输入；`e` ＝导出原图 ——
    case 'materialPrev':
      return pickNear(state, layout, -1)
    case 'materialNext':
      return pickNear(state, layout, 1)
    case 'accept':
      return actionOn(state, layout, 'attach')
    case 'materialExport':
      return actionOn(state, layout, 'export')
    case 'close':
      return { kind: 'close' }
    /**
     * **`Esc` 不在打字那一档时也是退出**（设计：「`q` / `esc` 也退出」）。
     *
     * ⚠️ **这一支漏不得**：`Esc` 在两档里的意思不同（打字时＝取消那个词、否则＝退出这一屏），
     * 而「不在打字」那一档若不给它去处，它落到 `default` 就成了**按了没反应**——真帧上量到过
     * （按 `Esc` 屏上纹丝不动）。
     */
    case 'cancel':
      return { kind: 'close' }
    case 'edit':
      return { kind: 'edit' }
    case 'search':
      return { kind: 'state', state: { ...state, asking: '', note: null } }
    // `n` / `N` 是「跳命中」——**没搜过时按下去什么也不发生**（不假装跳到第 0 处）
    case 'matchNext':
      return jump(state, layout, 1)
    case 'matchPrev':
      return jump(state, layout, -1)
    /**
     * **一个字一把的那些键在这里认**（`j` `k` `g` `G` `n` `N` `q` `v` `b` 空格 `/` `{` `}`）
     * ——**不在读字节那一层认**，理由有一条，而且是硬理由：
     *
     * 那一层**不知道此刻在不在打搜索词**。若它在字节那一层就把 `b` 认成「整页」，那么
     * **搜索词里永远打不出一个 `b`**（`j` `k` `n` `v` `q` 同理——搜个 `json` 都搜不了）。
     * 认得字的那一层必须**看得到状态**，而状态在这张表里。
     *
     * 不在这张表里的可见字符：**不在搜字时什么都不做**（这一屏不产生内容——设计
     * 「只用来显示」）。
     */
    case 'text':
      return singleKey(state, key.text, layout)
    default:
      return { kind: 'none' }
  }
}

/** 滚到第 `top` 行（夹在能滚的范围里）——**这一支只有一处**（`screenKey` 与 `singleKey` 都走它）。 */
function movedTo(state: ScreenState, top: number, layout: ScreenLayout): ScreenStep {
  return { kind: 'state', state: { ...state, top: clampTop(top, layout), note: null } }
}

/**
 * **一个字一把的那几个键**（设计 · 查看那一节的键位表里，除方向键与控制码之外的全在这儿）。
 *
 * 译成 `ScreenKey` 之后**回到同一个 `screenKey`**——各档的走法只有一处实现
 * （这一层只负责「哪个字是哪把键」）。
 */
const SINGLE_KEYS: Record<string, ScreenKey> = {
  j: { kind: 'lineDown' },
  k: { kind: 'lineUp' },
  g: { kind: 'top' },
  G: { kind: 'bottom' },
  b: { kind: 'pageUp' },
  ' ': { kind: 'pageDown' },
  '{': { kind: 'turnUp' },
  '}': { kind: 'turnDown' },
  // 材料那一对：与 `{` / `}` 同一族（一个对交代、一个对材料），故挨着放
  '[': { kind: 'materialPrev' },
  ']': { kind: 'materialNext' },
  e: { kind: 'materialExport' },
  '/': { kind: 'search' },
  n: { kind: 'matchNext' },
  N: { kind: 'matchPrev' },
  q: { kind: 'close' },
  v: { kind: 'edit' },
}

/**
 * 一个（或一段）字的键——不在表里的字什么都不做（这一屏不产生内容）。
 *
 * ⚠️ **一段也要逐个走**：两次按键可能**攒在同一笔读里**（终端把两下合成一次写是常事）。
 * 整段拿去查表只会落个「不在表里」，于是「按了 `G` 再按 `j`」里那一下 `G` 就没了。
 * 逐字走一遍，行为就与「一下一下按」完全一样。
 */
function singleKey(state: ScreenState, text: string, layout: ScreenLayout): ScreenStep {
  let current = state

  for (const char of text) {
    const key = SINGLE_KEYS[char]
    if (key === undefined) continue

    const step = screenKey(current, key, layout)
    if (step.kind !== 'state') return step
    current = step.state
  }

  return current === state ? { kind: 'none' } : { kind: 'state', state: current }
}

/**
 * 选中一处材料（U110）——`[` / `]` 走的那一支。
 *
 * 两条：
 * - **还没选过**（`picked === null`）——按**屏顶就近**取一条（往后＝屏顶及之下第一条，
 *   往前＝屏顶之上最后一条）。⚠️ 这一条不是随手定的：这两个键在「没选」那一档也得
 *   **真选出个东西来**，否则用户按下去屏上纹丝不动（那正是「按了没反应」）。
 * - **选着**——严格往前后挪一格，**到头就停**（不绕圈：这一屏上没有「一圈」这回事，
 *   绕回去会让「按了三下回到原处」变成一件说不清的事）。
 *
 * 选中的那一条**滚进视野**（同搜索命中的处置）。
 */
function pickNear(state: ScreenState, layout: ScreenLayout, step: number): ScreenStep {
  const list = layout.materials
  if (list.length === 0) return { kind: 'none' }

  const at = state.picked === null ? -1 : list.findIndex((one) => one.line === state.picked)
  let next: number

  if (at >= 0) {
    next = Math.min(list.length - 1, Math.max(0, at + step))
  } else {
    const forward = list.findIndex((one) => one.line >= state.top)
    next = step > 0
      ? (forward === -1 ? list.length - 1 : forward)
      : (forward === -1 ? list.length - 1 : (forward === 0 ? 0 : forward - 1))
  }

  const spot = list[next] as MaterialSpot

  return {
    kind: 'state',
    state: { ...state, picked: spot.line, top: reveal(spot.line, state.top, layout), note: null },
  }
}

/**
 * 那两条动作（U110）——**只有选中了才给**（反向判据：没选的时候这两个动作不出现）。
 *
 * 动作作用于**选中的那一处**，不是「离屏顶最近的那一处」——用户选的是哪一条，
 * 动的就是哪一条。
 */
function actionOn(state: ScreenState, layout: ScreenLayout, what: 'attach' | 'export'): ScreenStep {
  const spot = state.picked === null ? undefined : layout.materials.find((one) => one.line === state.picked)
  if (spot === undefined) return { kind: 'none' }

  return what === 'attach' ? { kind: 'attach', material: spot.image } : { kind: 'export', material: spot.image }
}

/** 上一条交代（严格在本屏顶行之上）——没有就停在原处。 */
function turnBefore(turns: readonly number[], top: number): number {
  const before = turns.filter((at) => at < top)
  return before.length === 0 ? top : (before[before.length - 1] as number)
}

/** 下一条交代（严格在本屏顶行之下）。 */
function turnAfter(turns: readonly number[], top: number): number {
  const after = turns.find((at) => at > top)
  return after ?? top
}

/**
 * 回车确认搜索——**落点**：从当前屏顶往下找第一处命中，没有就绕到第一处（Claude Code 的走法）。
 *
 * ⚠️ **词要在这里读**（`state.asking`），**不能先把它清掉再交进来**——这一支早先写成
 * 「调用处 `accepted({ ...state, asking: null })`」，于是 `term` 恒为空串：屏上既不高亮、
 * 底下也不报「第几处」（真帧上量到过：按了回车像什么都没发生）。**先读出词，再收那一档**。
 */
function accepted(state: ScreenState, layout: ScreenLayout): ScreenState {
  const term = state.asking ?? ''
  const hits = matchesOf(layout.lines, term)
  const base: ScreenState = { ...state, asking: null, term }
  if (hits.length === 0) return { ...base, at: 0 }

  const found = hits.findIndex((row) => row >= state.top)
  const at = found === -1 ? 0 : found

  return { ...base, at, top: reveal(hits[at] as number, state.top, layout) }
}

/** `n` / `N`——绕圈走（首尾相接），并把那一处**滚进视野**。 */
function jump(state: ScreenState, layout: ScreenLayout, step: number): ScreenStep {
  const hits = matchesOf(layout.lines, state.term)
  if (hits.length === 0) return { kind: 'state', state: { ...state, note: null } }

  const at = (state.at + step + hits.length) % hits.length

  return { kind: 'state', state: { ...state, at, top: reveal(hits[at] as number, state.top, layout), note: null } }
}

/** 把第 `row` 行滚进视野（已经看得见就不动）。 */
function reveal(row: number, top: number, layout: ScreenLayout): number {
  if (row < top) return row
  if (row >= top + layout.height) return row - layout.height + 1

  return top
}

function clampTop(top: number, layout: ScreenLayout): number {
  return Math.min(layout.maxTop, Math.max(0, Math.trunc(top) || 0))
}
