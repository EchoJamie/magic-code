/**
 * 裁决卡（缺陷轮 II 重画）——**不套框**：左竖线着色 ＋ 材料内联 ＋ 键位只出现一次。
 *
 * 规格（原型 · 场景 4–8）：
 * - **轻＝黄线 · 重＝红线**（摩擦对准高危）；
 * - **材料内联**——diff / 命令分解直接贴上来，不另套容器；
 * - **键位只出现一次**（在卡上）——接管态不画输入行（D29），卡是那一刻唯一的落点；
 * - **必闸类不给 `a`**——**划掉**（`strikethrough`）而不是藏起来：让你看见「这里本该有它，但这件不给」；
 *   **例外：外发那一件按域名给**（U72，见 `DecisionCard` 里 `byHost` 那一段）；
 * - **多件逐件问**——件数报在卡的标题（`2 / 3`）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import { MCP_EXTERNAL_CAVEAT } from '@magic/contracts'
import type { ReactElement } from 'react'
import type { PendingDecision } from '../view.ts'
import { PALETTE } from './lines.ts'

export type DecisionCardProps = {
  readonly pending: PendingDecision
}

export function DecisionCard({ pending }: DecisionCardProps) {
  const heavy = pending.weight === 'heavy'
  // **外部操作**（U38）：副题不说可逆 / 不可逆（本机判不出效果，只报「效果由服务器决定」），
  // 且**不给「总是允许」**——它是必闸类（那条授权记不下「外部效果」这个判断）
  const external = pending.external === true
  /**
   * **这一笔按域名记**（U72）——卡上带了域名（`tool.decision.request.host`）。
   *
   * 必闸类照旧不给 `a`（那是「本该有、这件不给」），**外发是唯一的例外**：它的必闸
   * 恰恰要**按域名**点头才算数（设计 · 网页与搜索：「按域名给，不按工具给」）——
   * 记下来的那一条只覆盖这一个域名，别的域名照问。故这一格在它身上是**活的**，
   * 措辞也照实改成「这个域名」：`a` 记的是「往哪一家发」，不是「这一类都不问」。
   */
  const byHost = pending.host !== undefined
  const accent = heavy ? PALETTE.danger : PALETTE.warn
  const bar = (line: string, color: string = PALETTE.fg, bold = false): ReactElement =>
    h(Text, { key: `l:${line}` }, h(Text, { color: accent }, '│ '), h(Text, { color, bold }, line))

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1, marginTop: 1 },
    // 标题：`名字 · 口径`（· 第几件）——外部操作的名字由权限域给成 `服务器 / 工具`
    h(
      Text,
      null,
      h(Text, { color: accent }, '│ '),
      h(Text, { color: accent, bold: true }, pending.name),
      h(
        Text,
        { color: PALETTE.dim },
        ` · ${external ? MCP_EXTERNAL_CAVEAT : heavy ? '不可逆' : '可逆'}`,
      ),
      pending.position === null
        ? null
        : h(Text, { color: PALETTE.dim }, ` · ${pending.position.index} / ${pending.position.total}`),
    ),
    // 材料内联（原样贴，不另套容器）
    ...pending.material.split('\n').map((line) => bar(line, PALETTE.dim)),
    // 键位——**只此一处**
    h(
      Text,
      { key: 'keys' },
      h(Text, { color: accent }, '│ '),
      // 「这一次」在外部件上**写出来**：它答的正是「批不批这一回」，而不是本机的一条长期授权
      keyHint('y', external ? '批准这一次' : '批准'),
      // **外部件不给「总是允许」那一格**（返工 B）：不是划掉，是**不画**——
      // 划掉在外部件上仍然占着一句话（「本工作区总是允许」），而它对这台服务器根本不适用
      // （外部效果不由本机裁定）。必闸类照旧划掉（那是「本该有、这件不给」）。
      ...(external ? [] : [keyHint('a', byHost ? '总是允许这个域名' : '本工作区总是允许', heavy && !byHost)]),
      keyHint('n', '拒绝'),
    ),
  )
}

function keyHint(key: string, label: string, struck = false): ReactElement {
  return h(
    Text,
    { key: `k:${key}` },
    h(Text, { color: struck ? PALETTE.ghost : PALETTE.fg, bold: !struck, strikethrough: struck }, key),
    h(Text, { color: struck ? PALETTE.ghost : PALETTE.dim, strikethrough: struck }, ` ${label}　`),
  )
}
