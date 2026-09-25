/**
 * 模型域事件 —— 接缝的**输出形态**（工作分解 · 迁移轨道 M02）。
 *
 * 归一终点＝共享语言 · 事件的 model 系列 kind（技术方案 · 模型策略 · 接缝自留）：
 * 取件层（AI SDK）已归一供应商差异；这里**再归一到内核事件模型**——内核只见自家事件。
 *
 * **构造面**——一律经注入的 `EventStamper`（技术方案 · 领域划分 · 信封的归属 v0 锚定）：
 * **信封由产出方铸**，故 `id` / `session` / `turn` / `at` 四件由铸造器盖——
 * **模型域不自造计数、不自取时钟**；铸造器由装配按会话实例构造并注入。
 *
 * `stamp` 的返回是 `KernelEvent`（判别联合视图）——消费侧按 `kind` 自动收窄。
 */

import type {
  DeltaChannel,
  EventStamper,
  KernelEvent,
  ModelErrorTier,
  ModelUsage,
} from '@magic/contracts'

/**
 * 调用起——报模型名；端点 / key / 参数等供应商细节不出此域。
 *
 * `provider` ＝这条**条目**的名字（`providers` 的键）——**不是**供应商细节，是「走的哪一格」：
 * 外壳状态行要显示当前供应商（技术方案 · 领域划分：「运行时切换」锚定），而外壳够不着注册表。
 * 取「真跑过的这一次」而不是用户命令的自我报告——切不动就不动，拿意图当状态会显示假条目。
 */
export function modelCallStart(
  stamper: EventStamper,
  model: string,
  provider?: string,
  /** **这次调用的有效输入预算**（U41 返修）——与 `model.usage.contextWindow` 同一个数，
   *  只是更早给（见契约 `model.call.start` 的那一位）。缺省＝不知道，不给这一位。 */
  inputBudget?: number,
): KernelEvent {
  return stamper.stamp('model.call.start', {
    model,
    ...(provider === undefined ? {} : { provider }),
    ...(inputBudget === undefined ? {} : { inputBudget }),
  })
}

/**
 * 退避重试中——**实时信号、不落库**（技术方案 · 记录 · kind 族「model · 实时」）。
 *
 * 退避期间事件流原先**静默**（用户只看见界面不动）；它是「正在等」的过程信号，
 * 不是重放事实——重放只看终局（这次调用成了没有、内容是什么），重试次数另落
 * `ModelCallResult.attempts`，故不落库不丢信息。
 *
 * `attempt` **从 2 起**：第 1 次是首发，谈不上「重试」。
 *
 * `maxAttempts` ＝**策略的上限**（总尝试次数，含首次）——状态行 `2/3` 的**分母**（缺陷 D10 ·
 * 第 2 样）。**它必填**：这条事件的产出方是退避层自己，手上就有那个策略（`policy.maxAttempts`），
 * 没有「不知道」的情形——给不出来才该另想办法，而不是让外壳去猜一个常量。
 */
export function modelRetry(
  stamper: EventStamper,
  attempt: number,
  delayMs: number,
  maxAttempts: number,
): KernelEvent {
  return stamper.stamp('model.retry', { attempt, delayMs, maxAttempts, tier: 'transient' })
}

/** 调用止——收束。失败走 `modelErrorEvent`，**不另发** `model.call.end`。 */
export function modelCallEnd(stamper: EventStamper): KernelEvent {
  return stamper.stamp('model.call.end', {})
}

/**
 * 用量——随事件流入记录（技术方案 · 模型策略 · 用量：成本可见的数据基础）。
 * 供应商未回用量时**不发**此事件（不发比发 `{0, 0}` 诚实）。
 *
 * `contextWindow` ＝**上下文窗口总量**——状态行 `12.4k/200k` 的**分母**（缺陷 D10 · 第 1 样）。
 * **分母跟着分子走**：两者同刻同源（都在收束那一刻落定），外壳不会拿滞后的分母配新分子。
 * 来处＝条目配置的 `contextWindow`（`ProviderConfig` 那个键）——**没声明就不给这个位**：
 * 拿不到就不显示，不拿假数占位。
 */
export function modelUsage(
  stamper: EventStamper,
  usage: ModelUsage,
  contextWindow?: number,
): KernelEvent {
  // ⚠️ **不在这里补零**（U41）：用量各字段分别允许未知——没回来就不带那一位，
  // 与「服务端明说 0」是两件事。细分位原样带走（消费者**不得**把它们与总数相加）。
  return stamper.stamp('model.usage', {
    ...usage,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  })
}

/**
 * 实时增量——**不落库**（共享语言 · 规则 ①：`model.delta` 属 `TRANSIENT_EVENT_KINDS`），
 * 供渲染订阅。
 *
 * `channel` 三选一：正文（`text`）/ 思考（`thinking`）/ 工具调用参数片段（`toolcall`）。
 *
 * toolcall 通道另带两件（`model.delta` 载荷 v0 锚定）：
 * - `name`＝工具名——流中**先于**参数片段出现，故 `tool-input-start` 时即发一条空文本增量
 *   （否则零参工具在流里将无名可示）；
 * - `id`＝**供应商侧调用 id**——渲染侧据以按调用分组（同轮可多次调用）。
 */
export function modelDelta(
  stamper: EventStamper,
  channel: DeltaChannel,
  text: string,
  name?: string,
  id?: string,
): KernelEvent {
  return stamper.stamp('model.delta', {
    channel,
    text,
    ...(name === undefined ? {} : { name }),
    ...(id === undefined ? {} : { id }),
  })
}

/**
 * 模型域错误——已分档（瞬时 / 超限 / 终态——技术方案 · 模型策略 · 错误分档）。
 *
 * `provider` / `model` 可选带上（U84 · 缺陷 D44）——**这一条要能单独读**：拿到一条
 * `model.error` 就知道是哪条连接、哪个模型出的错，不必回翻同轮前一条 `model.call.start`
 * 去拼。两位都与 `model.call.start` 同源同口径（缺省＝未给）。
 */
export function modelErrorEvent(
  stamper: EventStamper,
  tier: ModelErrorTier,
  message: string,
  /** 出错时手上有的那两件——拿不到就不给对应那一位（不编）。 */
  where?: { readonly provider?: string | undefined; readonly model?: string | undefined },
): KernelEvent {
  return stamper.stamp('model.error', {
    tier,
    message,
    ...(where?.provider === undefined ? {} : { provider: where.provider }),
    ...(where?.model === undefined ? {} : { model: where.model }),
  })
}
