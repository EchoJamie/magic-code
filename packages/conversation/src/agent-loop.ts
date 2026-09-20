/**
 * 主循环 —— `agentLoop`：模型调用（流式）→ 工具调用 → 结果回填 → 往复，直到收束。
 *
 * 出处：技术方案 · 主循环（轮 ＝ 一次模型调用 ＋ 它请求的工具执行〔可为 0 个〕·
 * 中断 · 同轮多工具按序逐个）。
 *
 * ```
 *   一个用户输入 ─→ 落账（message.user）─┐
 *                                        ↓
 *      ┌───────────── 轮 ──────────────┐ │   轮 = 一次模型调用 + 它请求的工具
 *      │  turn.start                   │ │
 *      │  模型流（事件原样转发）        │ │
 *      │  message.assistant（落账）     │ │
 *      │  tool.call → tool.result ×n    │ │   闸门在执行路径内（工具域的事）
 *      │  turn.end                     │ │
 *      └───────────────────────────────┘ │
 *                                        ↓
 *              无工具调用 → 收束（回到等待输入）／被中止／出错
 * ```
 *
 * **本域发的事件**（技术方案 · 领域划分 · 事件产出）——`message.user` · `message.assistant`
 * · `turn.start` · `turn.end` · 兜底 `error`。模型域的事件（`model.*`）**原样转发**；
 * 工具域 / 权限域的事件（`tool.*`）由它们各自直发 `EventSink`——**本域不越俎**。
 *
 * **轮起止由本域调**（`stamper.beginTurn`）——信封的归属 v0 锚定：「对话域在轮起止时调」。
 * 模型域被测试钉死「不调 `beginTurn`」（M02 备案），接上时必须自己调：轮外的事件
 * （`message.user`）信封 `turn` 为 `null`，轮内的都带本轮号。
 *
 * **上下文每轮由条目重建**（`./context.ts`）——记录即真源：中途被中止 / 崩掉，
 * 下一轮装配出来的仍是记录里那个现场（恢复〔阶段 2〕走同一条路）。
 *
 * **中断**（`signal`）——模型流停止（`signal` 交给接缝）· 执行中命令终止（交给工具域）
 * · 本轮以 `turn.end{reason:'aborted'}` 收束 · 回到等待输入。中断**不是**错误：
 * 半截流式消息丢弃（技术方案 · 恢复：「未完成流式消息丢弃、记中止」）。
 *
 * **错误分档的处置**——瞬时档（退避重试）在**模型域的接缝之下**（见 `@magic/model` 的
 * `retry.ts`：本域看不见重试，只看得到 `model.retry` 这条实时信号）；`context-limit`
 * （上下文超限）**归本域**：压一次再重发（见下）；终态档一律停下报告用户
 * （`turn.end{reason:'error'}` ＋ 模型域的 `model.error` 已在事件流里）。
 *
 * ## 压缩的两条触发路径（阶段 3 · U19）
 *
 * - **用量达阈值**——开一轮之前问一次（`shouldCompact()`）：上一次调用报回的用量到了
 *   阈值就先压后跑。**先压后跑**而不是「撞了再压」，是因为撞上超限要白搭一次调用。
 * - **上下文超限错误**——`model.error{tier:'context-limit'}`：压一次、**本轮重发**
 *   （不换模型）。只给一次机会（压完还超限＝这条会话确实塞不下了，如实停下报告）。
 *
 * 两条路都**不降级**：压不成，本轮照常走原来的上下文（B5——原文本就在，读不完也得接着读）。
 */

import type {
  EventSink,
  EventStamper,
  ModelErrorTier,
  ModelGateway,
  ModelResult,
  RecordsService,
  SessionId,
  Timestamp,
  ToolCall,
  ToolRuntime,
  TurnEndReason,
  TurnId,
  UserInput,
} from '@magic/contracts'
import type { Compactor } from './compact.ts'
import { DEFAULT_NEAR_ENTRIES, assembleContext } from './context.ts'
import type { EntryLog, ToolOutcome } from './entries.ts'
import {
  appendTextEntry,
  appendToolCallEntry,
  appendToolResultEntry,
  toolOutcomeOf,
} from './entries.ts'
import type { RulesDelivery } from './rules.ts'
import { needsReviewText, overflowText } from './rules.ts'

/**
 * 循环的构造入参（**域内形态**）——端口实现（`./service.ts`）按它装配。
 * 每个字段都是一件「不知道自己是谁的」依赖：模型 / 工具 / 记录皆经端口，实现在别处。
 */
export type LoopRuntime = {
  /** 会话——条目按会话读（信封的 `session` 由铸造器持，两处同源）。 */
  readonly session: SessionId
  /** 模型名——随每次调用送模型域（`ModelRequest.model`）。 */
  readonly model: string
  /** 系统提示词全文——已由提示词部件装配好（本文件不认知段结构）。 */
  readonly systemPrompt: string
  readonly gateway: ModelGateway
  readonly tools: ToolRuntime
  readonly records: RecordsService
  readonly sink: EventSink
  readonly stamper: EventStamper
  /**
   * 轮号发号器——阶段 1 单调自增（端口实现持计数器）。
   * **留缝**：阶段 2 恢复改由记录派生（同一会话续跑要接着那串轮号）。
   */
  readonly nextTurnId: () => TurnId
  /** 时钟——条目时间戳（见 `./entries.ts`）。 */
  readonly now: () => Timestamp
  readonly blobThreshold: number
  readonly blobTextLimit: number
  /**
   * 压缩器（阶段 3 · U19）——**不接线＝不压缩**（首站无压缩那几轮的行为一字不动；
   * 用例只想验循环时也不必拖一个压缩器进来）。真装配一律给（见 `./service.ts`）。
   *
   * 「近段」条数**不从别处另给**——装配照它的 `nearEntries` 认（见 `Compactor` 的注）。
   */
  readonly compact?: Compactor | undefined
  /**
   * 项目规约的送达账（U32）——**不接线＝不加载规约**（没有规约的那些工作区行为一字不动；
   * 用例只想验循环时也不必拖一份规约进来）。真装配一律给（见 `./service.ts`）。
   *
   * 它是**有状态**的（作用域 ＋ 已送达版本），故按会话实例各造一份——见其注。
   */
  readonly rules?: RulesDelivery | undefined
}

/**
 * 一轮的收场。
 * `reason` 进 `turn.end`；`continues` ＝本轮请求了工具且都处置完——**须再开一轮**。
 */
export type TurnOutcome = {
  readonly reason: TurnEndReason
  readonly continues: boolean
}

/**
 * 跑一个用户输入——从落账到收束（可含多轮）。
 *
 * 返回**最后一轮的结束方式**：`settled`（收束 · 回到等待输入）· `aborted`（被中止）·
 * `error`（出错 / 内核自身异常）。
 */
export async function agentLoop(
  runtime: LoopRuntime,
  input: UserInput,
  signal: AbortSignal,
): Promise<TurnEndReason> {
  const log = entryLogOf(runtime)

  try {
    // 用户输入落账——**轮外**（信封 `turn` 为 `null`：输入先于轮）
    const entryId = await appendTextEntry(log, 'user', input.text)
    runtime.sink.emit(runtime.stamper.stamp('message.user', { entry: entryId }))
  } catch (error) {
    return reportError(runtime, error)
  }

  for (;;) {
    // 轮间中止——不再开新轮（「回到等待输入」）
    if (signal.aborted) return 'aborted'

    const turn = await runTurn(runtime, signal)
    if (turn.reason !== 'settled' || !turn.continues) return turn.reason
  }
}

// ══ 一轮 ══════════════════════════════════════════════════════════════

async function runTurn(runtime: LoopRuntime, signal: AbortSignal): Promise<TurnOutcome> {
  const { gateway, tools, sink, stamper } = runtime

  // 轮起——铸造器的 `turn` 自此生效（轮内所有事件共用它）
  stamper.beginTurn(runtime.nextTurnId())

  try {
    sink.emit(stamper.stamp('turn.start', {}))

    // **触发之一：用量达阈值**——压了再跑（见文件头注：撞上超限要白搭一次调用）。
    // 压不成也照常往下走：这是「尽力收敛上下文」，不是本轮的前置条件（B5）
    const compact = runtime.compact
    if (compact !== undefined && compact.needed()) {
      await compact.run({ trigger: 'threshold', signal })
    }

    let text = ''
    /** 思考通道的正文——**只为 D6 的判据攒着**（不落条目，条目只载正文）。 */
    let thinking = ''
    /** 本轮的聚合结果——超限重发时会被下一次调用覆盖（上一次的结论已作废）。 */
    let result: ModelResult
    /** 超限重发**只给一次机会**（见文件头注）——压完还超限就是真塞不下了。 */
    let retried = false

    // 一次调用 ＋ 消费（超限时整体重来：重装配 → 重发——这才是「压缩后重发」）
    for (;;) {
      const messages = await assembleContext({
        records: runtime.records,
        session: runtime.session,
        // **项目规约**在装配这一步接上（U32）——每次都现取现接：改过的规约下一趟就是新的，
        // 而「这一趟送出去哪几版」也在此记账（预查据它判「拦不拦」）
        systemPrompt: runtime.rules?.promptFor(runtime.systemPrompt) ?? runtime.systemPrompt,
        blobTextLimit: runtime.blobTextLimit,
        // 近段条数取压缩器那个数（没接压缩器＝按缺省认，与策略缺省同源）
        nearEntries: runtime.compact?.nearEntries ?? DEFAULT_NEAR_ENTRIES,
      })

      const stream = gateway.stream(
        { model: runtime.model, messages, tools: tools.definitions() },
        { signal },
      )

      text = ''
      thinking = ''
      let errored = false
      let tier: ModelErrorTier | undefined

      for await (const event of stream.events) {
        // 模型域的事件**原样转发**（`model.call.start` / `model.delta` / `model.usage` /
        // `model.call.end` / `model.error`）——过程流的消费方（渲染 / 记录）按 kind 收窄
        sink.emit(event)

        if (event.kind === 'model.delta' && event.data.channel === 'text') text += event.data.text
        if (event.kind === 'model.delta' && event.data.channel === 'thinking') thinking += event.data.text
        // 用量是**压缩的触发读数**（分子 / 分母一次到齐——D10 的口径）
        if (event.kind === 'model.usage') compact?.observe(event.data)
        // `model.error` 是本轮定论的信号（不变式 ④：其后无事件）；聚合结果里没有错误位
        if (event.kind === 'model.error') {
          errored = true
          tier = event.data.tier
        }
      }

      result = await stream.result

      // 被中止——半截流式消息**丢弃**，本轮就此收束
      if (signal.aborted) return close(runtime, 'aborted', false)
      if (!errored) break

      // **触发之二：上下文超限**——压一次再重发（不换模型）。
      // 压成了才重发：压不动（或本就没接压缩）就没什么可重发的，照旧停下报告用户
      if (tier === 'context-limit' && !retried && compact !== undefined) {
        retried = true
        const outcome = await compact.run({ trigger: 'context-limit', signal })
        if (outcome.ok) continue
      }

      return close(runtime, 'error', false)
    }

    const calls = result.toolCalls ?? []

    // 正文落账 ＋ `message.assistant`（事件只记「发生 + 引用」）
    //
    // ⚠️ **D6：整轮什么都没产出（正文空 · 思考空 · 没有工具调用）⇒ 不落条目、不发事件**
    // ——那种轮次毫无内容，落了就是条目流里的一行噪声、上下文里的一条空消息，
    // 屏上还会多一个孤零零的标记（外壳侧另有一道「空内容不渲染」的兜底）。
    //
    // ⚠️ **但有工具调用时这条条目必须落**——它是上下文装配**配对的锚**：
    // 装配自 `assistant` 条目往后扫「`tool-call` ＋ 紧随的 `tool-result`」对
    // （见 `context.ts`）；锚没了，这一轮的工具往返**整段进不了上下文**
    // （实测：第 2 次模型调用的 messages 里连 `role:'tool'` 都没有）。
    const blank = text.trim() === '' && thinking.trim() === '' && calls.length === 0
    const assistantId = blank ? undefined : await appendTextEntry(entryLogOf(runtime), 'assistant', text)
    if (assistantId !== undefined) {
      sink.emit(stamper.stamp('message.assistant', { entry: assistantId }))
    }

    if (calls.length === 0) return close(runtime, 'settled', false) // 收束——回到等待输入

    // **目标预查（U32）**——动手**之前**看这一批的目标上有没有**还没送达**的规约。
    // 有：这一批**一份都不执行**（全都还没执行，故全都回填「需重审」），让模型照新规约
    // 复核后重提。整批一起拦而不是逐条拦：同一批里前几条已经动过、后几条才拦住的话，
    // 「照新规约重新提」这句话就只对一半的调用成立——那比整批重提更费解。
    //
    // 三选一（`PreflightResult`）：放行 / 需重审 / **材料超限、这批停在这儿**。
    // 后两种都**不执行**，但**回填的话不同**——超限那种要让模型去告诉用户，不是重提。
    const check = runtime.rules?.preflight(calls) ?? { kind: 'pass' as const }
    const heldText =
      check.kind === 'review'
        ? needsReviewText(check.blocking)
        : check.kind === 'overflow'
          ? overflowText()
          : undefined

    // 同轮多工具——**按序逐个**（并行执行留后评估）；一个被拒只影响该调用
    for (const call of calls) {
      if (signal.aborted) return close(runtime, 'aborted', false)
      if (heldText !== undefined) withholds(runtime, call, heldText)
      else await runToolCall(runtime, call, signal)
    }

    return close(runtime, signal.aborted ? 'aborted' : 'settled', !signal.aborted)
  } catch (error) {
    // 兜底——内核自身异常（非模型 / 工具域）：产生方就近发 `error`，本轮以「错误」收束
    return close(runtime, 'error', false, error)
  } finally {
    // 轮止——`undefined` ＝轮外（信封的 `turn` 落 `null`）
    stamper.beginTurn(undefined)
  }
}

/**
 * 一次工具调用——调用条目落账 → `invoke`（闸门在路径内）→ 结果条目落账。
 *
 * 对话域**不经手闸门、不经手沙箱**：`ToolRuntime.invoke` 内部才是「请求 → 闸门 →
 * 执行 → 回填」（技术方案 · 工具域）——本域只把结果回填给模型。
 *
 * 结果的两样输出（第 2 轮 · 契约补锚）由 `toolOutcomeOf` 各归其位：面向模型的文本进条目
 * 正文、记录侧形态进载荷（见 `./entries.ts`）。
 */
async function runToolCall(
  runtime: LoopRuntime,
  call: ToolCall,
  signal: AbortSignal,
): Promise<void> {
  const log = entryLogOf(runtime)

  // 调用条目先落账——它与结果条目成对，「有调用无结果」＝在途（阶段 2 恢复按它找）
  appendToolCallEntry(log, call)

  let outcome: ToolOutcome
  try {
    // `opts.onOutput` 留空：`tool.output.delta` 是**工具域**的产出（事件产出表）——
    // 本域不越俎；该位留给将来的消费方（如外壳侧的实时视图）。
    outcome = toolOutcomeOf(await runtime.tools.invoke(call, { signal }))
  } catch (error) {
    // 端口承诺「结果，不是异常」（与沙箱同法）；抛了＝工具域违约。
    // 不炸掉整轮：以失败回填——模型与用户都看得到「这次没成」。
    // 违约路径**编不出** `ToolResult`（链引用无从取得），故就地造落账形态：两样都内联
    const text = `工具调用异常：${describeError(error)}`
    outcome = { ok: false, text, content: { text } }
  }

  appendToolResultEntry(log, outcome)
}

/**
 * **扣下**一次调用（U32 · 目标预查拦下的那一批）——落账一对条目 ＋ **发一对事件**，
 * **不碰工具域**（连闸门都没问）。
 *
 * - **配对要闭合**（设计 · 项目规约第 4 条明写）——条目上照样落 `tool-call` ＋ `tool-result`
 *   一对。少落一个，上下文装配那边会把它当成**在途调用**（`context.ts` 的文件头注 2），
 *   这一批就从模型眼前整段消失，连「为什么没执行」都看不见了。
 * - **事件上同样要闭合**（2026-09-20 裁，改了首轮的口径）：首轮**一个事件都不发**，
 *   理由是「那两个是工具域的产出，而这次没到工具域」。那个理由在**记录**那一面站得住，
 *   在**界面**那一面站不住——真流式增量会先按 toolcall 通道建出一行工具
 *   （`model.delta`），而这一行等的是 `tool.call` 来认领；不发的后果是**屏上留一个
 *   永远转圈的幽灵工具**（`running · call: null`），外头早就空闲了它还在那儿转，
 *   而用户永远不知道那几个文件**压根没写**。
 *
 *   故**复用现有的工具事件与结果**（工单 6 的裁法）：`tool.call` ＋ 紧跟着的 `tool.result`，
 *   一对**齐来齐走**。恢复的「在途识别」找的是「有 `tool.call` 无 `tool.result`」那几笔
 *   （`scanForRecovery`），**成对发**进去的是一笔**已了结**的调用，不是假在途。
 *   也不新立「未执行」这种第二套在途状态——外壳照既有那一套画，只是结果写着没执行。
 * - **不宣称副作用已执行**：结果 `ok: false` ＋ `notExecuted`（见函数体），正文照
 *   `needsReviewText`（或超限那份 `overflowText`）说清**没执行 · 为什么 · 下一步怎么办**。
 */
function withholds(runtime: LoopRuntime, call: ToolCall, text: string): void {
  const log = entryLogOf(runtime)

  appendToolCallEntry(log, call)
  const opened = runtime.stamper.stamp('tool.call', { name: call.name, args: call.args })
  runtime.sink.emit(opened)

  // **「没跑」由产生处写死**（`notExecuted`）：条目与事件**同源同带**——外壳实时看事件、
  // 切会话回来看条目，两路读的是这一位。此前谁都没记，下游只好拿结果正文首行去猜
  // （2026-09-20 三轮裁，改的正是那条正文协议）。
  appendToolResultEntry(log, { ok: false, text, content: { text }, notExecuted: true })
  runtime.sink.emit(
    runtime.stamper.stamp('tool.result', {
      call: opened.id,
      ok: false,
      output: { text },
      notExecuted: true,
    }),
  )
}

// ══ 收场 ══════════════════════════════════════════════════════════════

/** 本轮收束——发 `turn.end` 并交回结束方式。`error` 给了就顺带发兜底的 `error` 事件。 */
function close(
  runtime: LoopRuntime,
  reason: TurnEndReason,
  continues: boolean,
  error?: unknown,
): TurnOutcome {
  if (error !== undefined) {
    runtime.sink.emit(
      runtime.stamper.stamp('error', { message: `对话域异常：${describeError(error)}` }),
    )
  }

  runtime.sink.emit(runtime.stamper.stamp('turn.end', { reason }))
  return { reason, continues }
}

/** 兜底（轮外）——内核自身异常：发 `error` 事件并交回结束方式。 */
function reportError(runtime: LoopRuntime, error: unknown): TurnEndReason {
  runtime.sink.emit(
    runtime.stamper.stamp('error', { message: `对话域异常：${describeError(error)}` }),
  )
  return 'error'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 落账依赖束——由运行时装配（时钟与阈值只此一处传给条目侧）。 */
function entryLogOf(runtime: LoopRuntime): EntryLog {
  return {
    records: runtime.records,
    now: runtime.now,
    blobThreshold: runtime.blobThreshold,
  }
}
