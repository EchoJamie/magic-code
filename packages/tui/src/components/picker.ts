/**
 * 选择器（缺陷轮 II 重画）——`/session` · `/model` 的展开形态。
 *
 * 规矩（原型 · 场景 9 / 10）：**只在左下开，记录区什么都不进**；上下选＝常规逻辑；
 * 选定后**留一行回执**；`esc` 取消＝**不留痕迹**。
 *
 * 与输入区**同一位置、同一开合**——故它只是 `Dock` 的另一种形态，不另起一块。
 *
 * ## 高度有界（U41 · 2026-09-23）
 *
 * 设计 · 终端交互：「选择器 `↑↓` 选择、`Enter` 确定、`Esc` 收起；**高度有界**、焦点可见」。
 * 这一条原先只有**草稿**那一片落了（`maxDraftLines` 半屏），候选这一头是**照单全画**的——
 * 实测：30 条候选在 24 行终端上把记录区整个顶出去（帧 40 行，记录区一行不剩）。
 * `/skills` 那种目录本来就长，供应商的模型列表更是几十条都可能，故补上：
 *
 * - 窗口取**半屏**（与草稿同一条规矩，一个常量）；
 * - **焦点必须在窗口里**（`↑↓` 挪到哪儿，窗口跟到哪儿——同草稿那一片「插入点必须看得见」）；
 * - 折起来的那一头**如实报条数**（`… 上面还有 N 条`），不装作画全了。
 *
 * ⚠️ **账与屏同取 `pickerLayout` 一处**（`app.ts` 的 `dockHeightOf` 数的是它交出来的
 * `items.length`）——分头算一次就会重演「账 N 行、屏 N+1 行 ⇒ 矮终端上真光标高一行」
 * （U31 那一族的老账）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { Picker, PickerRow } from '../view.ts'
import { groupHeads } from '../view.ts'
import { clip, inkWidth } from './composer.ts'
import { wrap } from './lines.ts'
import { PALETTE } from './lines.ts'

/**
 * 一屏要画的一项——**候选行 · 分组头 · 折起来那条提示**（三者同列，故同一个类型）。
 *
 * 高度账与渲染都数它：这样「折起来几条」这件事**只在一处决定**，两处不会各说一套。
 */
export type PickerItem =
  | { readonly kind: 'head'; readonly key: string; readonly head: string; readonly faint: boolean }
  | { readonly kind: 'row'; readonly key: string; readonly row: PickerRow; readonly index: number }
  | { readonly kind: 'notice'; readonly key: string; readonly text: string }

export type PickerLayout = {
  /** 这一屏从头到尾要画的项（顺序即屏上的顺序）。 */
  readonly items: readonly PickerItem[]
  /** 折起来了几条候选（上 / 下两头；`0` ＝ 这一头没折）。 */
  readonly above: number
  readonly below: number
}

export type PickerProps = {
  readonly picker: Picker
  /**
   * 一屏多少列——**只有「担保一行」的那些行用得上**（`PickerRow.oneLine`：超宽要截，
   * 截到哪儿得知道屏有多宽）。别的行不看它（照旧由 Ink 折行，那是既有行为）。
   */
  readonly columns: number
  /**
   * 这一屏多少行——**候选那一头的半屏预算**按它算（见 `maxPickerLines`）。
   *
   * 不给 ＝ 不封顶（纯看一屏长什么样的用例与快照留的口子——与 `maxLines` 对
   * `composerLayout` 是同一个姿势）。
   */
  readonly rows?: number
}

/** 序号那一格的宽（`01 `）——截断要把这几位扣掉，不然算出来的宽度多三列。 */
const NUMBER_WIDTH = 3
/** 标签与 meta 之间那个**全角**空格（`　`）占两列。 */
const GAP_WIDTH = 2

/**
 * 候选那一头最多占几行——**半屏**（与草稿那一片同一条规矩：原型 · 键盘「高度随内容长，
 * 上限半屏」）。
 *
 * 取半屏的由头与草稿一致：内联渲染下屏是共享的——候选吃满了，记录区就没了。
 * 半屏保证「下面那半屏仍是这一趟的上下文」，那正是选模型时要看的东西（刚问了什么、
 * 上一条答复是什么）。
 */
export function maxPickerLines(rows: number): number {
  return Math.max(1, Math.floor(rows / 2))
}

/**
 * **候选那一头这一屏能占几行**——半屏**扣掉下面那行说明**（`picker.hint`）要占的行数。
 *
 * 由头（真跑量出来的）：说明那行与候选是**同一片交互区**里的两截——早先只封了候选
 * （半屏），说明是另加的，于是「半屏候选 ＋ 三行说明」比半屏还高，矮终端上记录区被挤没。
 * 与草稿那一片同一条规矩：**正文与提示共用同一份预算**（`composerLayout` 的折叠那一段
 * 写的就是这条，U31 二轮退回栽过）。
 *
 * ⚠️ **账与屏同取这一处**：渲染（`PickerList`）与高度账（`app.ts` 的 `dockHeightOf`）
 * 都调它——分头算一次就重演「账 N 行、屏 N+1 行 ⇒ 真光标高一行」。
 */
export function pickerBudget(picker: Picker, columns: number, rows: number): number {
  const hint =
    picker.hint === undefined ? 0 : wrap(picker.hint, Math.max(8, columns - 4)).length

  return Math.max(1, maxPickerLines(rows) - hint)
}

/**
 * 一行要画的字——**担保一行的行**在这儿截（`oneLine`），其余原样。
 *
 * 宽度从整屏列数倒推：盒子的 `paddingX: 1` 两边各占一列，行里先是序号，
 * 再是标签，中间一个全角空格，最后是 meta。扣完剩下的才是这两段共用的额度
 * ——标签先占，meta 吃剩下的（**窄窗先保住名称/来源、再截断简述**：技能那些行把
 * 来源摆在 meta 的前半截，正是为了先丢的是简述）。
 *
 * ⚠️ 截断用的是 **Ink 那把尺**（`clip`／`inkWidth`，见 `composer.ts`）——两把尺混用
 * 会让「裁到刚好」与「Ink 又折了一行」各说各的，交互区的高度账当场分家。
 */
function partsOf(row: PickerRow, columns: number): { label: string; meta: string } {
  if (row.oneLine !== true) return { label: row.label, meta: row.meta }

  const room = Math.max(0, columns - 2 - NUMBER_WIDTH - GAP_WIDTH)
  const nameWidth = inkWidth(row.label)
  const metaWidth = inkWidth(row.meta)

  // **放得下就一个字都不截**（宽窗的常态）——名称按需拿到它要的，简述也在
  if (nameWidth + metaWidth <= room) return { label: row.label, meta: row.meta }

  // 放不下时要截谁：设计 · 终端交互「**窄窗先保住名称/来源、再截断简述**」——
  // 名称与来源在前、简述在后，故**截断落在简述身上**。
  //
  // 于是**先给「必留的那一段」（来源）扣出额度**（连它被截时要用的那个省略号），
  // 剩下的才是名称能拿的：够就一点不截，不够才截它。两头的线各是各的——
  // - 名称按需吃满而不管来源：60 列 · 56 字符名时连「项目 / 用户」都不见了（真 PTY 反例①）；
  // - 名称**无条件**限一半：宽窗下先把名称截了、还给简述留着余量，把优先级倒过来（二轮退回）。
  // - 来源自己太长时（目录名可以很长）保底让它占一半——总不能把名称饿死。
  const keep = Math.min(inkWidth(row.keep ?? '') + 1, Math.max(2, Math.floor(room / 2)))
  const label = clip(row.label, Math.max(1, room - keep))

  return { label, meta: clip(row.meta, Math.max(0, room - inkWidth(label))) }
}

/** 折起来那一头那条提示（与草稿那两行同形：**如实报条数**）。 */
function noticeOf(count: number, where: 'above' | 'below'): string {
  return `… ${where === 'above' ? '上面' : '下面'}还有 ${count} 条`
}

/** 一堆项里**候选**有几条（分组头与提示不算——报给用户的是「还有多少条可挑」）。 */
function rowsIn(items: readonly PickerItem[]): number {
  return items.reduce((sum, item) => sum + (item.kind === 'row' ? 1 : 0), 0)
}

/**
 * 候选 → 这一屏要画的那几项（**纯函数**：渲染、高度预算、用例都拿它）。
 *
 * 窗口**从宽到窄试**（照 `composerLayout` 折叠那一段的同一条路子）：第一个
 * 「窗口 ＋ 它实际要画的提示行 ≤ 预算」的就是要的那一扇。⚠️ 提示行只在**真折了**
 * 的那一头才占格子——窗口贴住某一头时那一头不画提示，故现算，不一律按「两头各留一行」扣。
 */
export function pickerLayout(picker: Picker, budget: number = Number.POSITIVE_INFINITY): PickerLayout {
  const heads = groupHeads(picker.rows)
  const full: PickerItem[] = []
  /** **常驻行**（`PickerRow.pinned`）——不折叠、画在末尾，额度单算（见 `pinned` 那条注）。 */
  const pinned: PickerItem[] = []

  picker.rows.forEach((row, index) => {
    if (row.pinned === true) {
      pinned.push({ kind: 'row', key: `r:${index}`, row, index })
      return
    }
    if (heads[index] === true) {
      full.push({ kind: 'head', key: `h:${index}`, head: row.group ?? '', faint: row.faint === true })
    }
    full.push({ kind: 'row', key: `r:${index}`, row, index })
  })

  const cap = Math.max(1, Math.floor(budget))
  // 折得动的那一段拿到的额度 ＝ 总额度 − 常驻行（常驻的**先占**，它们本来就该一直看得见）。
  // 兜底至少 1 格：额度窄到装不下常驻行时，宁可让折得动的那一段只留一行（下面还有护栏）。
  const room = Math.max(1, cap - pinned.length)

  if (full.length <= room) return { items: [...full, ...pinned], above: 0, below: 0 }

  // 焦点那一项在**整张表**里的位置——窗口必须含住它（`↑↓` 挪到哪儿，窗口跟到哪儿）
  const at = full.findIndex((item) => item.kind === 'row' && item.index === picker.selected)
  const anchor = at === -1 ? 0 : at

  for (let size = Math.min(full.length, room); size >= 1; size -= 1) {
    // 窗口贴住下沿（焦点在末尾那一格上）——与草稿那一片同一取法：挪到哪儿跟到哪儿，
    // 只在够不着的时候才整窗平移（最小滚动）。
    const from = Math.min(Math.max(anchor - size + 1, 0), full.length - size)
    const window = full.slice(from, from + size)
    const above = rowsIn(full.slice(0, from))
    const below = rowsIn(full.slice(from + size))
    const used = window.length + (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0)

    if (used <= room) {
      return {
        items: [
          ...(above > 0 ? [{ kind: 'notice', key: 'n:above', text: noticeOf(above, 'above') } as const] : []),
          ...window,
          ...(below > 0 ? [{ kind: 'notice', key: 'n:below', text: noticeOf(below, 'below') } as const] : []),
          ...pinned,
        ],
        above,
        below,
      }
    }
  }

  // 兜底（护栏——半屏预算实际到不了这一档）：预算窄到「一项 ＋ 一条提示」都放不下时，
  // **焦点那一项优先**（它得让人看得见），两头提示如实让位——宁可少报，也不把帧撑过账。
  // 常驻行**照旧给**（它们正是入口，折没了就等于没有）。
  return { items: [full[anchor] as PickerItem, ...pinned], above: 0, below: 0 }
}

export function PickerList({ picker, columns, rows = Number.POSITIVE_INFINITY }: PickerProps) {
  const { items } = pickerLayout(picker, pickerBudget(picker, columns, rows))

  const lines = items.map((item) => {
    if (item.kind === 'head') {
      return h(
        Text,
        { key: item.key, color: item.faint ? PALETTE.faint : PALETTE.dim },
        `　${item.head}`,
      )
    }

    if (item.kind === 'notice') {
      // **折起来几条第说几条**——与草稿那两行同一个面孔（暗色、缩进一格）
      return h(Text, { key: item.key, color: PALETTE.faint }, `　${item.text}`)
    }

    const { row, index } = item
    const { label, meta } = partsOf(row, columns)

    return h(
      Text,
      { key: item.key },
      h(Text, { color: row.current ? PALETTE.user : PALETTE.faint }, `${String(index + 1).padStart(2)} `),
      h(
        Text,
        {
          // 压暗最弱，但**当前那条与选中项照旧亮**——「正在用」比「属于哪组」更该被看见，
          // 而压暗只是视觉次序，不是可用性（压暗的行照样选得中、切得过去）
          color:
            index === picker.selected
              ? PALETTE.fg
              : row.current
                ? PALETTE.user
                : row.faint === true
                  ? PALETTE.faint
                  : PALETTE.dim,
          bold: index === picker.selected || row.current,
        },
        label,
      ),
      h(Text, { color: PALETTE.faint }, `　${meta}`),
    )
  })

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    ...lines,
    // 列表下方那行说明（可选）
    picker.hint === undefined ? null : h(Text, { color: PALETTE.faint }, `　${picker.hint}`),
  )
}
