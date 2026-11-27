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
  ModelErrorTier,
  ModelResult,
  RecordId,
  StepId,
  TurnEndReason,
  UserInput,
} from '@magic/contracts'
import { appendTextEntry, appendToolResultEntry, toolOutcomeOf, type ToolOutcome } from './entries.ts'
import { describeError, prepareInput } from './input-intake.ts'
import { createAnnouncer, createMaterialWatch } from './receipt-accounts.ts'
import {
  admitted,
  afterModelError,
  beforeTurn,
  createTurnAccounting,
  gateToolBatch,
  prepareModelContext,
  settleContinuation,
  type ToolBatchCall,
} from './turn-cycle.ts'
import { entryLogOf, type Announcer, type InputOutcome, type LoopRuntime, type MaterialWatch, type TurnOutcome } from './loop-runtime.ts'

// 拆分后的公共面从原入口转出（既有引用方——service.ts / 测试夹具——引用路径不变）：
export type { Announcer, InputOutcome, LoopRuntime, MaterialWatch, TurnOutcome } from './loop-runtime.ts'
export { prepareInput } from './input-intake.ts'
export { entryLogOf } from './loop-runtime.ts'

/**
 * 收场那一句——**「引用了、却没被读过」要说出来**（U63 · 设计 2026-09-25 补的那半条）。
 *
 * 由头：文件 / 目录 / 技能的送达方式改成了「模型按需自读」，于是**「引用了」不等于
 * 「看过了」**。只配「读了要说」（`skill.used` 那一条）不够：模型没读时那一轮结束
 * **屏上什么也没有**，用户照样以为它看了。故收束时把没读到的那几份报出来。
 *
 * 报的是**这一份材料在交代里怎么写的**（`marker`：`@src/a.ts` / `/review`）——用户据它
 * 认得出是哪儿处引用，不必再翻译一次。
 *
 * **收束才报**（不是每轮）：多轮工作里模型可能在后面才读，逐轮报会把同一件事说好几遍。
 * 三种收场（收束 / 中止 / 出错）都报：那三种情形下屏上都会静下来，用户都会以为它读过了。
 */
function finish(runtime: LoopRuntime, watch: MaterialWatch, outcome: InputOutcome): InputOutcome {
  const unread = watch.unread()
  if (unread.length > 0) {
    runtime.sink.emit(runtime.stamper.stamp('input.unread', { markers: unread }))
  }

  return outcome
}

/**
 * 跑一个用户输入——从落账到收束（可含多轮）。
 *
 * 返回**这次交代的收场**：`settled`（收束 · 回到等待输入）· `aborted`（被中止）·
 * `error`（出错 / 内核自身异常）· **`rejected`**（这一条**压根没跑**，见下）。
 *
 * ## `rejected`——选定的材料取不到时，这一条不跑（U33 技能 / U36 文件目录同理）
 *
 * 「不跑」是三层意思，三层都要做到：
 * - **不落 `user` 条目**（没有「用户说了什么」这回事——那句话内核没接住）；
 * - **不发 `message.user`**、**不进模型请求**（正文一个字都不送）；
 * - **不换同名项、不忽略那一处继续**（工单明写）——文件读不了、是二进制、超了上限，
 *   与技能主文取不到走**同一条出口**：整条不跑、原稿还回输入区（`input.settled{ok:false}`）。
 *
 * **排队里别的交代照跑**：错的是一条（它选的技能失效了），不是这一队。
 * 把整队清掉＝用户后面那几条**没做错任何事的话**被静默吞了——比多跑一条坏得多。
 * （与「中断清队」的分野也在这儿：那是用户在说「都停下」，这是内核在说「这条不成」。）
 */
export async function agentLoop(
  runtime: LoopRuntime,
  input: UserInput | undefined,
  signal: AbortSignal,
  accepted?: (entry:RecordId)=>void|Promise<void>,
): Promise<InputOutcome> {
  if(signal.aborted)return 'aborted'
  const prepared = await prepareInput(runtime, input, accepted, signal)
  if (prepared === undefined) return 'rejected'
  const announce = createAnnouncer(runtime, prepared.skills)

  // **这一轮引用了、却还没被读过的**（U63）——收束时报一声（见 `finish`）。
  const watch = createMaterialWatch(prepared.refs)
  const inputFrom = prepared.entry ?? ((await runtime.records.readEntriesBack(runtime.session, undefined, 1)).at(-1)?.id ?? 0) + 1

  for (;;) {
    // 轮间中止——不再开新轮（「回到等待输入」）
    if (signal.aborted) return finish(runtime, watch, 'aborted')

    const turn = await runTurn(runtime, signal, announce, watch, inputFrom, prepared.latestInput)
    if (turn.reason !== 'settled' || !turn.continues) return finish(runtime, watch, turn.reason)
  }
}


// ══ 一轮 ══════════════════════════════════════════════════════════════
// 材料链（规约/技能/后台/计划/协作提示）已移 `turn-cycle.ts`——循环只认装配调用。
async function runTurn(
  runtime: LoopRuntime,
  signal: AbortSignal,
  /**
   * 这次交代的回执账——**每趟请求的第一条事件到手时** `flush()` 一次（见 `createAnnouncer`）。
   * 报什么、报几次由账自己判，故逐条调也无妨。
   */
  announce: Announcer,
  /** 「引用了、却没被读过」那份账（U63）——每次工具返回都记一笔，收束时问一次。 */
  watch: MaterialWatch,
  inputFrom: RecordId,
  initialInput: string | undefined,
): Promise<TurnOutcome> {
  const { gateway, tools, sink, stamper } = runtime
  const accounting = createTurnAccounting(runtime, announce)

  // 轮起——记录域分配 `turns.id`；铸造器的 `turn` 自此生效（轮内所有事件共用它）
  const turn = runtime.turn ?? runtime.nextTurnId()
  runtime.turn = turn
  stamper.beginTurn(turn)
  let step: StepId | undefined
  let failed = false

  const endActiveStep = (status: 'completed' | 'aborted' | 'failed'): void => {
    if (step === undefined) return
    runtime.records.endStep(turn, step, status, runtime.now())
    stamper.beginStep?.(undefined)
    step = undefined
  }

  try {
    sink.emit(stamper.stamp('turn.start', {}))

    // 调用前预处理管道（压缩阈值）+ 每趟的协作准入/材料链/装配在 `prepareModelContext`。
    await beforeTurn(runtime, signal)

    let text = ''
    /** 思考通道的正文——随助手载荷保存，供同源模型回传。 */
    let thinking = ''
    /** 本轮的聚合结果——超限重发时会被下一次调用覆盖（上一次的结论已作废）。 */
    let result: ModelResult
    /** 超限重发**只给一次机会**——压完还超限就是真塞不下了。 */
    let retried = false

    // 一次调用 ＋ 消费（超限时整体重来：重装配 → 重发——这才是「压缩后重发」）
    for (;;) {
      const prepared = await prepareModelContext(runtime, signal, accounting, inputFrom, initialInput)
      if (prepared.kind === 'aborted') return close(runtime, 'aborted', false)
      if (prepared.kind === 'error') {
        sink.emit(stamper.stamp('error', { message: `本轮不能发送：${prepared.reason}。原始记录已保留。` }))
        return close(runtime, 'error', false)
      }
      const messages = prepared.messages

      // 一步＝轮内一次模型调用及它带出的工具执行；重发（超限）另起一步。
      endActiveStep('completed')
      step = runtime.records.beginStep(turn, runtime.now(), runtime.stepIdentity?.())
      stamper.beginStep?.(step)
      const stream = gateway.stream(
        { messages, tools: tools.definitions() },
        { signal },
      )

      text = ''
      thinking = ''
      let errored = false
      let tier: ModelErrorTier | undefined

      for await (const event of stream.events) {
        // 模型域的事件**原样转发**——过程流的消费者（渲染 / 记录）按 kind 收窄
        sink.emit(event)

        if (event.kind === 'model.delta' && event.data.channel === 'text') text += event.data.text
        if (event.kind === 'model.delta' && event.data.channel === 'thinking') thinking += event.data.text
        // 用量过账（压缩阈值读数）与回执偿还都在账务模块里（`onStreamEvent`：判「这次请求
        // 真回来了」并报收）；`model.error` 是本轮定论信号（不变式 ④：其后无事件）。
        // ⚠️ 每条事件只过账一次（P0 修复：此前同一段里调了两次）。
        accounting.onStreamEvent(event)
        if (event.kind === 'model.error') {
          errored = true
          tier = event.data.tier
        }
      }

      result = await stream.result

      // 被中止——半截流式消息**丢弃**，本轮就此收束
      if (signal.aborted) return close(runtime, 'aborted', false)
      if (!errored) break

      // **触发：上下文超限**——压一次再重发（不换模型）。压成了才重发。
      const verdict = await afterModelError(runtime, tier, signal, retried)
      if (verdict === 'retry') { retried = true; continue }
      if (verdict === 'aborted') return close(runtime, 'aborted', false)
      failed = true
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
    const blank = text.trim() === '' && thinking.trim() === '' && calls.length === 0 && result.reasoningState === undefined
    // 思考**落进载荷**（U41）：DeepSeek 的思考模式在带 tools 时要求历史轮的
    // `reasoning_content` 原样回传（不回则 400）。它**不进屏**（屏上那份走 `thinking`
    // 通道的展示），只在下一次请求装配时回到 assistant 消息上——带不带由适配决定
    // （设计：「不转发给其它供应商」），对话域只如实留痕。
    const assistantId = blank
      ? undefined
      : await appendTextEntry(
          entryLogOf(runtime),
          'assistant',
          text,
          thinking.length === 0 && result.reasoningState === undefined ? undefined : {
            reasoning: thinking,
            ...(result.reasoningState === undefined ? {} : { reasoningState: result.reasoningState }),
          },
          accounting.references,
        )
    if (assistantId !== undefined) {
      sink.emit(stamper.stamp('message.assistant', { entry: assistantId }))
    }

    if (calls.length === 0) {
      // 收束判定在外循环端口（协作消费可能带回新交代，续不续由账面回答）
      return close(runtime, 'settled', await settleContinuation(runtime))
    } // 收束——回到等待输入

    // 同轮多工具——**并发执行、按发起序落账**。批前裁决（协作准入、规约预查、扣下）
    // 都在 `gateToolBatch`；这里只拿放行的清单执行。
    //
    // ⚠️ **`halt` 只决定还开不开下一轮**——批里已经发起的命令撤不回来（并发之后「尚未执行
    // 的暂停」这句话就不成立了）。
    let stopped = false
    const gated = await gateToolBatch(runtime, calls, signal, accounting.references)
    if (gated.aborted) return close(runtime, 'aborted', false)
    const begun = gated.begun

    // 执行互不影响；落账按发起序串起来（结果条目、计划通报都在这之后）
    //
    // **只对整批都是 `exec` 的并发**：命令互不影响，等四遍才是浪费；而业务工具
    // （写文件、改知识、计划）之间**有先后语义**（读后写、按序改），并发会把它们的意思改掉。
    const parallel = begun.length > 1 && begun.every(one => one.call.name === 'exec')
    if (parallel) {
      const outcomes = await Promise.all(begun.map(one => executeToolCall(runtime, one, signal, announce, watch)))
      for (const [index, one] of begun.entries()) {
        const outcome = outcomes[index]!
        await settleToolCall(runtime, accounting, one, outcome)
        if (outcome.halt === true) stopped = true
      }
    } else {
      for (const one of begun) {
        const outcome = await executeToolCall(runtime, one, signal, announce, watch)
        await settleToolCall(runtime, accounting, one, outcome)
        if (outcome.halt === true) stopped = true
      }
    }

    // `continues` 为假 ⇒ 回到等待输入（工单第 5 条：这一轮就地收束）
    return close(runtime, signal.aborted ? 'aborted' : 'settled', !signal.aborted && !stopped && admitted(runtime))
  } catch (error) {
    // 兜底——内核自身异常（非模型 / 工具域）：产生方就近发 `error`，本轮以「错误」收束
    failed = true
    return close(runtime, 'error', false, error)
  } finally {
    const status = signal.aborted ? 'aborted' : failed ? 'failed' : 'completed'
    endActiveStep(status)
    runtime.records.endTurn(turn, status, runtime.now())
    runtime.turn = undefined
    // 轮止——`undefined` ＝轮外（信封的 `turn` 落 `null`）
    stamper.beginTurn(undefined)
  }
}

/**
 * 执行阶段（并发）：只跑工具并回填，**不落结果条目**。
 *
 * `opts.onOutput` 留空：`tool.output.delta` 是**工具域**的产出（事件产出表）——本域不越俎。
 * 工具域违约（抛）时以失败结果回填，不炸整轮。
 */
async function executeToolCall(
  runtime: LoopRuntime,
  started: ToolBatchCall,
  signal: AbortSignal,
  announce: Announcer,
  watch: MaterialWatch,
): Promise<ToolOutcome> {
  try {
    const outcome = toolOutcomeOf(await runtime.tools.invoke(started.call, { signal, entry: { sessionId: runtime.session, entryId: started.entry } }))
    // **模型自主取到一份技能主文**（U33）——记进回执账，等它进了下一趟请求再报
    if (outcome.skill !== undefined) announce.deliver(outcome.skill)
    // **这一趟读到了哪些材料**（U63）——记进那份账，收束时据此说「哪几份没读」
    watch.see(outcome)
    return outcome
  } catch (error) {
    // 端口承诺「结果，不是异常」（与沙箱同法）；抛了＝工具域违约。
    // 违约路径**编不出** `ToolResult`（链引用无从取得），故就地造落账形态：两样都内联
    const text = `工具调用异常：${describeError(error)}`
    return { ok: false, text, content: { text } }
  }
}

/** 收账阶段（按发起序）：结果条目 ＋ 计划通报（条目成功追加之后才发）。 */
async function settleToolCall(
  runtime: LoopRuntime,
  accounting: ReturnType<typeof createTurnAccounting>,
  started: ToolBatchCall,
  outcome: ToolOutcome,
): Promise<void> {
  const resultKnowledge = await accounting.resultKnowledge(started.call, outcome)
  const resultId = appendToolResultEntry(entryLogOf(runtime), outcome, resultKnowledge)
  announcePlan(runtime, outcome, resultId)
}

/**
 * **计划变更的通报**（U34）——**条目成功追加之后**才发（`appendToolResultEntry` 已经返回
 * 才走到这里；它抛了就轮不到这一行）。
 *
 * 为什么是这个时机（设计 · 技术实现方案 3 的那一条）：
 * - 工具域早先发的 `tool.result` **不能**当「计划已保存」的证明——那只说明调用跑完了，
 *   条目还没影；
 * - 追加失败**不能**对模型或界面报更新成功——落账前失败＝保持旧计划（旧内容还在记录里），
 *   而界面照旧看着上一份清单，两边说的是同一件事。
 *
 * 判据是 `undefined`（不在场）而非真假：`plan: null` 是**清空**，也要报（界面据它移除清单）。
 */
function announcePlan(runtime: LoopRuntime, outcome: ToolOutcome, entry: RecordId): void {
  if (outcome.plan === undefined) return

  runtime.sink.emit(runtime.stamper.stamp('plan.changed', { entry, plan: outcome.plan }))
}

// ══ 收场 ══════════════════════════════════════════════════════════════
// 批前扣下的书写（`withhold`）已随批前闸移 `turn-cycle.ts`——放行与扣下同一次过。

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

  runtime.sink.emit(runtime.stamper.stamp('turn.end', { reason, ...(continues ? { continues: true as const } : {}) }))
  return { reason, continues }
}


