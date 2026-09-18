/**
 * 输入行（缺陷轮 II 重画）——左下交互区的**默认形态**。
 *
 * 三种面孔（原型 · 场景 1/3/13/4）：
 * - **常态**：`› ` 青 ＋ 占位或草稿 ＋ 光标；
 * - **工作中 / 退避中**：提示词转暗 ＋ 占位换成一句「现在打也发不出去」的实话；
 * - **接管中**（`taken`）：提示词转黄 ＋ 占位「等你的答复」——**看得见**（接管三兜底之一）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import { PALETTE } from './lines.ts'

/** 输入行的面孔——由外壳按状态算好（显示层不判断）。 */
export type ComposerTone = 'idle' | 'working' | 'retrying' | 'taken'

export type ComposerProps = {
  readonly draft: string
  readonly tone: ComposerTone
}

/** 占位文字（每个面孔一句实话）。 */
export function placeholderOf(tone: ComposerTone): string {
  switch (tone) {
    case 'idle':
      return '交代一件事，回车发送'
    case 'working':
      return '（工作中——想插话可以打，发不出去就排队）'
    case 'retrying':
      return '（等模型回来——不用管，退避重试会自动重发）'
    case 'taken':
      return '等你的答复'
  }
}

export function Composer({ draft, tone }: ComposerProps) {
  const taken = tone === 'taken'
  const promptColor = taken ? PALETTE.warn : tone === 'idle' ? PALETTE.user : PALETTE.dim

  return h(
    Box,
    { paddingX: 1 },
    h(Text, { color: promptColor }, '› '),
    draft === ''
      ? h(Text, { color: taken ? PALETTE.warn : PALETTE.faint, dimColor: tone !== 'idle' && !taken }, placeholderOf(tone))
      : h(Text, { color: PALETTE.fg }, draft),
    // 光标（取景用：真终端里由 Ink 的 cursor 管，这里给个可见的落点）
    h(Text, { inverse: true }, ' '),
  )
}
