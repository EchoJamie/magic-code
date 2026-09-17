/**
 * 事件扇出桩 —— `EventSink` 的内存实现（**测试替身**）。
 *
 * 用处：各域测试要断言「这个域在什么时候发了什么事件」。真装配里 `EventSink` 是扇出点
 * （落库 ＋ 推送），测试里它就是一本流水账。
 *
 * `byKind` 是消费侧惯用姿势的便捷版——返回**收窄到该 kind** 的事件数组
 * （契约的判别联合视图 `KernelEvent` 直接可用）。
 */

import type { EventEnvelope, EventKind, EventSink, KernelEvent } from '@magic/contracts'

/** 事件扇出桩的观察面。 */
export type FauxSink = EventSink & {
  /** 已发事件（按发出序）。 */
  readonly events: readonly KernelEvent[]
  /** 取某 kind 的全部事件——**收窄**（不必再逐个 `if`）。 */
  byKind<K extends EventKind>(kind: K): readonly EventEnvelope<K>[]
}

/** 造一个事件扇出桩。 */
export function makeFauxSink(): FauxSink {
  const events: KernelEvent[] = []

  return {
    get events(): readonly KernelEvent[] {
      return events
    },

    emit(event: KernelEvent): void {
      events.push(event)
    },

    // 断言在此**安全**：筛的就是 `kind === k`，筛出来的自然收窄到该 kind 的信封。
    // 双断言不是偷懒——`KernelEvent` 是判别联合，而**未定泛型 `K`** 下 TS 展不开
    // 那个分布式形态（`EventEnvelope<K>` 与 `KernelEvent` 互不可比）。
    // 与 `makeTestStamper` 的 `stamp` 同源：泛型在函数体内自证不了自己，只能在出口收口。
    byKind: <K extends EventKind>(kind: K): readonly EventEnvelope<K>[] =>
      events.filter((event) => event.kind === kind) as unknown as readonly EventEnvelope<K>[],
  }
}
