/**
 * 事件——行 ↔ 形态（判据 1 · 落取回环 ＋ 判据 3 · 不落库清单）。
 *
 * 出处：技术方案 · 记录（记录 schema v0 · 事件）· `@magic/contracts` · `events`。
 *
 * 两件事：
 * 1. **信封逐字段落列**（`id` / `session` / `turn` / `at` / `kind` / `data`）——
 *    `id` 排序权威、`session` 分束、`turn` 可空；
 * 2. **不落库清单**——`TRANSIENT_EVENT_KINDS`（`model.delta` · `tool.output.delta`）
 *    在**本处**即拦下：装配扇出只管「要不要推给外壳」，落库侧的清单由记录域自持，
 *    免得每个装配姿势都要记得过滤一遍（能靠结构保障的，别靠判断）。
 */

import { TRANSIENT_EVENT_KINDS } from '@magic/contracts'
import type { EventKind, KernelEvent } from '@magic/contracts'
import type { NamedParams } from './schema.ts'

/** `events` 表的行形态（列名即落盘形态）。 */
export type EventRow = {
  readonly id: number
  readonly session: string
  readonly turn: number | null
  readonly at: number
  readonly kind: string
  readonly data: string
}

/** 规则 ① 的判定——流式增量**不逐条落库**（实时走订阅）。 */
export function isTransientEvent(kind: EventKind): boolean {
  return TRANSIENT_EVENT_KINDS.includes(kind)
}

export function eventParamsOf(event: KernelEvent): NamedParams {
  return {
    $id: event.id,
    $session: event.session,
    $turn: event.turn,
    $at: event.at,
    $kind: event.kind,
    $data: JSON.stringify(event.data),
  }
}

export function eventOfRow(row: EventRow): KernelEvent {
  // 反序列化边界——`kind` 与 `data` 的对应由**写入侧**保证（`events` 表只由本包写入，
  // 且 `appendEvent` 处只收 `KernelEvent`）。TS 判别联合无法从两个独立列复原该对应，
  // 故此处是必要的断言；消费侧仍按 `kind` 自动收窄（契约的判别联合视图）。
  return {
    id: row.id,
    session: row.session,
    turn: row.turn,
    at: row.at,
    kind: row.kind as EventKind,
    data: JSON.parse(row.data),
  } as KernelEvent
}
