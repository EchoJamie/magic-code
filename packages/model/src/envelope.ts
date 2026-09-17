/**
 * 信封铸造位 —— 模型域只产 `kind` ＋ `data`，**信封四件**（`id` / `session` / `turn` / `at`）
 * 归调用方（见下「为什么要这一位」）。
 *
 * 信封出处：共享语言 · 事件（`EventEnvelope`——每事件必带）。
 *
 * ⚠️ **待决（已随 M02 回报提请规划侧锚定）**——「谁铸事件 `id`」在契约里未定：
 * - `RecordId` 是**记录域**的单调空间（`id` 单调、排序权威；条目与事件共用）；
 * - `session` / `turn` 只有**对话域**知道（模型域拿不到——端口 `stream(req, opts)` 只给 `signal`）。
 *
 * 故此处**不自铸**，把归属做成可注入位：装配根按届时锚定的结论注入（记录域铸 / 各域铸皆可落），
 * 缺省 `localEnvelopeSource()` 供单域自跑与测试。**模型域不假设任何一种归属**。
 */

import type { EventDataOf, EventEnvelope, EventKind } from '@magic/contracts'
import type { RecordId, SessionId, Timestamp, TurnId } from '@magic/contracts'

/** 信封来源——四件各由谁给，见文件头注。 */
export type EventEnvelopeSource = {
  /** 事件分束预留（技术方案 · 多智能体协作预留）。 */
  readonly session: SessionId
  /** 轮标识——模型调用不总在某轮内（自跑 / 测试），故可空。 */
  readonly turn: TurnId | null
  /** 单调 `id`——**`RecordId` 空间**（与条目共用一个空间）。 */
  nextId(): RecordId
  /** 时间戳——epoch 毫秒（共享语言 · 标识与时间口径）。 */
  now(): Timestamp
}

/** 缺省信封来源——本地单调计数 ＋ 空 session ＋ `Date.now()`（自跑 / 测试用，见文件头注）。 */
export function localEnvelopeSource(session: SessionId = '', turn: TurnId | null = null): EventEnvelopeSource {
  let next = 0
  return {
    session,
    turn,
    nextId: () => (next += 1),
    now: () => Date.now(),
  }
}

/**
 * 铸一条事件——**构造面**（`EventEnvelope<'kind'>`，泛型收窄到单 kind 以取得该 kind 的 `data` 形态）。
 *
 * 事件构造子（`events.ts`）一律经此：信封只在这里生成，换归属只改这一处。
 */
export function stampEvent<K extends EventKind>(
  source: EventEnvelopeSource,
  kind: K,
  data: EventDataOf[K],
): EventEnvelope<K> {
  return {
    id: source.nextId(),
    session: source.session,
    turn: source.turn,
    at: source.now(),
    kind,
    data,
  }
}
