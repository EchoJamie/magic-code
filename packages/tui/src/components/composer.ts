/**
 * 输入行（U09）——一屏的入口：交代就写在这里。
 *
 * 编辑能力取**骨架级**（字符 / 退格 / 回车）；历史 · 补全 · 多行归后阶段。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'

export type ComposerProps = {
  /** 当前草稿（编辑器状态在 `TuiApp` 里）。 */
  readonly draft: string
}

export function Composer({ draft }: ComposerProps) {
  return h(
    Box,
    { paddingX: 1 },
    h(Text, { color: 'cyan' }, '› '),
    draft === ''
      ? h(Text, { dimColor: true }, '交代一件事，回车发送')
      : h(Text, null, draft),
    h(Text, { inverse: true }, ' '),
  )
}
