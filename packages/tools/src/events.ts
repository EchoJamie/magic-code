/**
 * 三个 kind 的构造子 —— 工具域的事件产出。
 *
 * 出处：技术方案 · 领域划分「事件产出」——工具域负责 `tool.call` · `tool.output.delta`
 * （瞬时）· `tool.result`。
 *
 * **信封由本域铸**（产出方铸——技术方案 · 领域划分 · 信封的归属）：
 * `tool.call` 的 `id` 就是**链引用**——请求 / 询问 / 裁决 / 结果四事件靠它串起来。
 * 铸造器（`EventStamper`）由装配按会话实例构造并注入，本域不自造计数、不自取时钟。
 *
 * 构造子单列的好处是**形状钉在一处**：三个载荷的字段名与契约的 `EventDataOf` 逐条对应，
 * 分发里只剩「何时发」。
 */

import type {
  Content,
  EventStamper,
  KernelEvent,
  OutputDelta,
  RecordId,
  ToolCall,
} from '@magic/contracts'

/**
 * 请求 —— 「模型请求了这次调用」。
 * 名称与参数**原样**入事件（不做解释——解释是给模型的回填，判定是权限域的活）。
 */
export function toolCallEvent(stamper: EventStamper, call: ToolCall): KernelEvent {
  return stamper.stamp('tool.call', { name: call.name, args: call.args })
}

/**
 * 执行输出增量（**不落库**——契约 `TRANSIENT_EVENT_KINDS`）。
 * 实时推送专用：落库体量太碎，收束成 `tool.result` 即可。
 */
export function toolOutputDeltaEvent(
  stamper: EventStamper,
  call: RecordId,
  delta: OutputDelta,
): KernelEvent {
  return stamper.stamp('tool.output.delta', { call, channel: delta.channel, text: delta.text })
}

/** 结果 —— 终值（内联或 blob 引用）。与 `tool.call` 靠 `call` 串成一条链。 */
export function toolResultEvent(
  stamper: EventStamper,
  call: RecordId,
  ok: boolean,
  output: Content,
): KernelEvent {
  return stamper.stamp('tool.result', { call, ok, output })
}
