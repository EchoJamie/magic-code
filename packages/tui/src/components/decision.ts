import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { PendingDecision } from '../view.ts'
import { PALETTE, wrap } from './lines.ts'

export function decisionActions(pending: PendingDecision) {
  return [
    { label: '批准这一次', decision: 'approve' as const, remember: false },
    ...(pending.external !== true && (pending.weight !== 'heavy' || pending.host !== undefined)
      ? [{ label: pending.host === undefined ? '本工作区总是允许此类操作' : `总是允许这个域名：${pending.host}`, decision: 'approve' as const, remember: true }] : []),
    { label: '拒绝这一次', decision: 'reject' as const, remember: false },
  ]
}

/** 材料与操作共享实际窗口预算，长材料在卡内翻页。 */
export function decisionLayout(pending: PendingDecision, columns: number, rows: number, active = true) {
  const width = Math.max(1, columns - 4)
  const title = `${pending.member === undefined ? '' : `${pending.member} · `}${pending.name} · 待决策${pending.position === null ? '' : ` · ${pending.position.index}/${pending.position.total}`}`
  const heading = wrap(title, width)
  const reason = wrap(pending.external ? '需要授权外部操作，效果由服务器决定。' : pending.weight === 'heavy' ? '此操作需要你明确授权。' : '此操作尚未获得授权。', width)
  const actions = active ? decisionActions(pending).flatMap((one, index) => wrap(`${pending.selected === index ? '›' : '○'} ${one.label}`, width)) : []
  const hint = wrap(pending.submitted ? '答复已提交，等待确认；Esc 返回' : active ? '↑↓ 选择 · Enter 确认 · PgUp/PgDn 查看材料 · Esc 返回' : '待决策保留 · Tab 进入决策；补充输入等待裁决完成', width)
  const material = pending.material.split('\n').flatMap(line => wrap(line, width))
  const size = Math.max(1, Math.floor(rows / 2) - heading.length - reason.length - actions.length - hint.length - 1)
  const top = Math.max(0, Math.min(pending.top ?? 0, material.length - size))
  const more = material.length > size ? [`材料 ${top + 1}–${Math.min(material.length, top + size)}/${material.length}`] : []
  const lines = [...heading, ...reason, ...material.slice(top, top + size), ...more, ...actions, ...hint]
  return { lines, top, size, maxTop: Math.max(0, material.length - size) }
}

export function DecisionCard({ pending, columns, rows, active = true }: { readonly pending: PendingDecision; readonly columns: number; readonly rows: number; readonly active?: boolean }) {
  const layout = decisionLayout(pending, columns, rows, active)
  return h(Box, { flexDirection: 'column', paddingX: 1 }, ...layout.lines.map((line, index) => h(Text, { key: index, color: index === 0 ? (pending.weight === 'heavy' ? PALETTE.danger : PALETTE.warn) : undefined }, h(Text, { color: pending.weight === 'heavy' ? PALETTE.danger : PALETTE.warn }, '│ '), line)))
}
