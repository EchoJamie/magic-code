/**
 * 本地小输入（U41）——改名 / 密钥那一类**一次设置**的输入行。
 *
 * 与输入行（`composer.ts`）同一副面孔、同一套光标：**借它画**（`Composer`），不另造一条
 * 折行 / 量宽 / 摆真光标的路径——那三件在 U31 上栽过好几轮，各写一遍迟早分家。
 *
 * 它多出来的是**上面那行标签**（问的是什么）与**下面那行说明**（可省）：
 *
 * ```
 * 　密钥（输入不回显）        ← 标签：这一屏在问什么
 *  › ••••••••                ← 输入行（真光标在这行上）
 * 　留空＝不动已存的那把       ← 说明（可省，问的人给）
 * ```
 *
 * ⚠️ **密钥那一路画的是圆点**：真值不在这份视图里（只有外壳手上那一份），
 * 这一层拿到什么就画什么——它压根不知道有「真值」这回事（见 `PromptState` 的注）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { PromptState } from '../view.ts'
import { Composer } from './composer.ts'
import { PALETTE, wrap } from './lines.ts'

export type PromptProps = {
  readonly prompt: PromptState
  readonly columns: number
  /** 输入行最多占几行（半屏）——与草稿那一片同一份预算（见 `maxDraftLines`）。 */
  readonly maxLines: number
}

export function PromptLine({ prompt, columns, maxLines }: PromptProps): ReactElement {
  // 说明那行**按实际占几行算**（同选择器那一处的分寸）：超宽由 Ink 折行，
  // 照一行算的话交互区账与屏当场分家（矮终端上真光标高一行——U31 那条老病）
  const note =
    prompt.note === undefined
      ? []
      : wrap(prompt.note, Math.max(8, columns - 4)).map((line, at) =>
          h(Text, { key: `pnote:${at}`, color: PALETTE.faint }, `　${line}`),
        )

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { color: PALETTE.dim }, `　${prompt.label}`),
    h(Composer, {
      draft: prompt.display,
      caret: prompt.caret,
      tone: 'idle',
      maxLines,
      columns,
      placeholder: prompt.placeholder,
    }),
    ...note,
  )
}
