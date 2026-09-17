/**
 * 事件工厂（测试面）——按 `EventEnvelope<K>` 造事件，**不用强转**。
 *
 * 构造面走契约的泛型信封（`EventEnvelope<K>` 收窄到单 kind）；`id` 递增，
 * 便于断言「配对键＝请求事件 id」。
 */

import type { EventDataOf, EventEnvelope, EventKind, SessionId, TurnId } from '@magic/contracts'

export const TEST_SESSION: SessionId = 'session-test'
export const TEST_AT = 1_700_000_000_000

let sequence = 0

/** 下一个记录 id——测试内递增，跨用例不重置（只用于区分，不用于断言绝对值的场合）。 */
export function nextId(): number {
  sequence += 1
  return sequence
}

/** 造一个事件；`turn` 缺省＝1（轮内事件），传 `null` 造轮外事件。 */
export function event<K extends EventKind>(
  kind: K,
  data: EventDataOf[K],
  options: { readonly id?: number; readonly turn?: TurnId | null } = {},
): EventEnvelope<K> {
  const id = options.id ?? nextId()

  return {
    id,
    session: TEST_SESSION,
    turn: options.turn === undefined ? 1 : options.turn,
    at: TEST_AT + id,
    kind,
    data,
  }
}
