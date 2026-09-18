/**
 * 输入行（缺陷轮 II 重画 · U20 补多行）——左下交互区的**默认形态**。
 *
 * 面孔（原型 · 场景 1/3/4/14）：
 * - **常态**：`› ` 青 ＋ 占位或草稿 ＋ 光标；
 * - **工作中 / 退避中**：提示词转暗 ＋ 占位换成一句「现在打也发不出去」的实话；
 * - **接管中**（`taken`）：提示词转黄 ＋ 占位「等你的答复」——**看得见**（接管三兜底之一）。
 *
 * **多行草稿**（U20 · 差距 4「输入框骨架级：无历史 / 多行 / 补全」）：
 * `shift+回车` 换行，草稿因此可以多行——**高度随内容长，上限半屏**（原型 · 键盘表）。
 * 三条形态上的定夺：
 * - **续行缩进 2 列**（与 `› ` 同宽）：悬挂缩进那条规格的老姿势（正文从标记之后起）；
 * - **越上限就收起头部**（不是尾部）：光标永远在末尾，正在打的那一行必须看得见；
 *   收起来的**如实报行数**（`… 上面还有 N 行`）——不装作画全了；
 * - **一行一个 `<Text>`**（不在一段文本里写 `\n`）：Ink 的竖排 Box 本来就一个子节点一行，
 *   在 `Text` 里塞换行会让**行数账目**对不上（D11 的根因，见 `log.ts` 文件头注）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import { PALETTE } from './lines.ts'

/** 输入行的面孔——由外壳按状态算好（显示层不判断）。 */
export type ComposerTone = 'idle' | 'working' | 'waiting' | 'retrying' | 'taken'

export type ComposerProps = {
  readonly draft: string
  readonly tone: ComposerTone
  /**
   * 草稿最多占几行（**半屏**）——超了就收起头部并如实报行数。
   * 缺省不限（只给「草稿 → 一屏里的几行」的用例与快照留的口子）。
   */
  readonly maxLines?: number
}

/** 占位文字（每个面孔一句实话）。 */
export function placeholderOf(tone: ComposerTone): string {
  switch (tone) {
    case 'idle':
      return '交代一件事，回车发送'
    case 'working':
      // 工具在跑——「想插话可以打」是原型场景 3 的原话
      return '（工作中——想插话可以打，发不出去就排队）'
    case 'waiting':
      // **等模型回来**（U20 · 差距 3「进度感」）——与「工具在跑」分开：那一刻屏上
      // 没有转圈的行，只有这句话说明「球在它那边」。措辞借原型场景 14 的原话「等模型回来」。
      return '（等模型回来——想插话可以打，发不出去就排队）'
    case 'retrying':
      return '（等模型回来——不用管，退避重试会自动重发）'
    case 'taken':
      return '等你的答复'
  }
}

/** 草稿要占几行（含「收起了几行」那一行）——布局预算与渲染同取这一处。 */
export function draftHeight(draft: string, maxLines: number): number {
  if (draft === '') return 1 // 占位那行

  const lines = draft.split('\n').length

  return Math.min(lines, maxLines) + (lines > maxLines ? 1 : 0)
}

export function Composer({ draft, tone, maxLines = Number.POSITIVE_INFINITY }: ComposerProps) {
  const taken = tone === 'taken'
  const promptColor = taken ? PALETTE.warn : tone === 'idle' ? PALETTE.user : PALETTE.dim
  // 光标（取景用：真终端里由 Ink 的 cursor 管，这里给个可见的落点）——永远在**末尾**
  const cursor = h(Text, { key: 'cursor', inverse: true }, ' ')

  if (draft === '') {
    return h(
      Box,
      { paddingX: 1, flexDirection: 'column' },
      h(
        Text,
        { key: 'ph' },
        h(Text, { color: promptColor }, '› '),
        h(
          Text,
          { color: taken ? PALETTE.warn : PALETTE.faint, dimColor: tone !== 'idle' && !taken },
          placeholderOf(tone),
        ),
        cursor,
      ),
    )
  }

  const lines = draft.split('\n')
  const folded = Math.max(0, lines.length - maxLines)
  const shown = folded === 0 ? lines : lines.slice(folded)

  return h(
    Box,
    { paddingX: 1, flexDirection: 'column' },
    // 收起的那几行**如实报**（不装作画全了）
    ...(folded === 0 ? [] : [h(Text, { key: 'fold', color: PALETTE.faint }, `… 上面还有 ${folded} 行`)]),
    ...shown.map((line, at) =>
      h(
        Text,
        { key: `d:${at}` },
        // 首行用 `› ` 起头，续行缩进同宽——**悬挂缩进**那一条的老姿势
        h(Text, { color: promptColor }, at === 0 && folded === 0 ? '› ' : '  '),
        // ⚠️ 空行得给一个「有东西」的孩子——Ink 会把内容为空串的 `<Text>` 整行丢掉，
        //    行数就少一行（D19 同款；见 `log.ts` 里那处同样的处理）
        h(Text, { color: PALETTE.fg }, line === '' ? ' ' : line),
        at === shown.length - 1 ? cursor : null,
      ),
    ),
  )
}
