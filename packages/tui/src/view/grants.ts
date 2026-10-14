import type { EventDataOf } from '@magic/contracts'
import type { PickerRow } from '../view.ts'
import { dayLabel } from './time.ts'

/**
 * **`/grants` 的行** —— 名录 ＋ 陈旧的节（`B13` 的呈现形态：**与 `/resume` · `/model`
 * 同位置同开合**的左下抽屉）。
 *
 * 两组：
 * - **本工作区的授权**——一行一条，`describe` 是内核给的措辞（工具 × 路径 × 操作，
 *   一处产出，外壳不重拼）；`meta` 是**用过的证据**（用了几次、最近什么时候）
 *   与**久未命中**那个标记；
 * - **陈旧的节**（`B11`）——**路径已不在**的那些工作区，一行一节，选定＝**整节撤掉**。
 *   ⚠️ **只是列出来**：内核**不自动删**（删用户数据不归内核），撤销的扳机在人手上。
 *
 * 行序即撤销要报的 `index`（本工作区那组在前，序号从 0 起）——故这里**不许重排**。
 */
export function grantsRows(catalog: GrantsCatalog): readonly PickerRow[] {
  const rows: PickerRow[] = catalog.grants.map((grant, index) => ({
    label: grant.describe,
    meta: grantMetaOf(grant),
    current: false,
    value: String(index),
    group: catalog.workspace,
    revoke: { index },
  }))
  for (const section of catalog.stale) {
    rows.push({
      label: section,
      meta: '路径已不在——整节撤销',
      current: false,
      value: section,
      group: STALE_HEAD,
      faint: true, // 压暗＝「这个多半是过去的事了」，但**照样选得中**（同 `/resume` 那一屏的姿势）
      revoke: { workspace: section },
    })
  }
  return rows
}

/** 陈旧节那一组的头（本工作区那组用路径本身作头——两组的头分得开）。 */
const STALE_HEAD = '（已不在了的工作区）'

/** 一条授权的 meta 栏——**用过的证据**，不是评价（没记过账就说没记过）。 */
function grantMetaOf(grant: GrantsCatalog['grants'][number]): string {
  if (grant.lastHitAt === undefined) return grant.stale ? '还没用过 · 久未命中' : '还没用过'
  const when = `最近 ${dayLabel(grant.lastHitAt)}`
  // `hits` 与 `lastHitAt` 同来处（`grants.ts` 的记账）——有其一即有其二，此处仍是各判各的
  const times = grant.hits === undefined ? '' : `${grant.hits} 次 · `
  return grant.stale ? `${times}${when} · 久未命中` : `${times}${when}`
}

export function grantsHint(catalog: GrantsCatalog): string {
  const head =
    catalog.grants.length === 0 && catalog.stale.length === 0
      ? `本工作区（${catalog.workspace}）还没有授权——批准时按 a 就是记一条`
      : '↑↓ 选择 · Enter 查看详情 · Esc 返回'
  return [catalog.decisions ? `${head} · ${frictionLabel(catalog.decisions)}` : head, historyLabel(catalog.history)]
    .filter((line) => line !== undefined)
    .join('\n')
}

export type GrantsCatalog = EventDataOf['grants.catalog']

/**
 * 放行区的账 · **本会话**（`B10`）——**两个占比**，各自说各自的话（见契约 `grants.catalog`）：
 *
 * - **未配规则**：一条规则都没命中的那些 / 全部裁决；
 * - **还得你点**：前者 ＋「规则命中了却被必闸禁区否决」的那些 / 全部裁决。
 *
 * 两个数只差否决那一格——对用户是同一个体验，对规则作者不是一件事。**分母是 0 就不报**
 * （「0 次裁决」不是一个占比，报它等于编一个 0%）。
 */
function frictionLabel(decisions: NonNullable<GrantsCatalog['decisions']>): string {
  const { total, uncovered, vetoed } = decisions
  if (total === 0) return '本会话还没走过裁决'
  const asked = uncovered + vetoed
  return (
    `本会话 ${total} 次裁决：未配规则 ${uncovered} 次（${percentOf(uncovered, total)}）` +
    ` · 还得你点 ${asked} 次（${percentOf(asked, total)}）`
  )
}

function historyLabel(history: GrantsCatalog['history']): string | undefined {
  if (history === undefined) return undefined
  const { total, auto, kernel } = history
  if (total === 0) return undefined
  const asked = total - auto - kernel
  const parts = [`自动放行 ${auto} 次（${percentOf(auto, total)}）`]
  if (kernel > 0) parts.push(`内核直接拒 ${kernel} 次（${percentOf(kernel, total)}）`)
  parts.push(`还得你点 ${asked} 次（${percentOf(asked, total)}）`)
  return `历史累计 ${total} 次裁决：${parts.join(' · ')}`
}

function percentOf(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`
}
