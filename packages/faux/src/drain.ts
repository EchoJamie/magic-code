/**
 * 消费助手 —— 把一条 `ModelStream` 拉到尽，两个出口一次到手。
 *
 * 双出口的流（事件流 ＋ 聚合结果）在测试里几乎总要一起看：
 * 「事件序列对不对」＋「聚合结论对不对」。手写 `for await` 再 `await result` 一次两行，
 * 但每处都写就容易漏掉一处（尤其是先 `await result` 再消费 events —— 那会**挂住**：
 * `result` 随 `events` 被消费完而落定，见 `gateway.ts` 文件头注）。
 *
 * 泛型留着聚合结果的**具体类型**——拿真实现的流来 drain 也照旧精确。
 */

import type { KernelEvent, ModelResult } from '@magic/contracts'

/** 可 drain 的流——契约 `ModelStream` 的结构（接受任何实现，含真实现）。 */
export type DrainableStream<R extends ModelResult> = {
  readonly events: AsyncIterable<KernelEvent>
  readonly result: Promise<R>
}

/** 拉到尽——返回**全部事件**与**聚合结果**。 */
export async function drainStream<R extends ModelResult>(
  stream: DrainableStream<R>,
): Promise<{ readonly events: readonly KernelEvent[]; readonly result: R }> {
  const events: KernelEvent[] = []
  for await (const event of stream.events) events.push(event)

  return { events, result: await stream.result }
}
