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
  ToolCall,
  TurnEndReason,
  UserInput,
} from '@magic/contracts'
import { pendingViews } from '@magic/contracts'
import { assembleContext, rawTextOf } from './context.ts'
import { collaborationPrompt } from './collaboration.ts'
import { KNOWLEDGE_MATERIAL_TOOLS, knowledgeOutputReferences } from './knowledge-material.ts'
import type { ToolOutcome } from './entries.ts'
import {
  appendTextEntry,
  appendToolCallEntry,
  appendToolResultEntry,
  toolOutcomeOf,
} from './entries.ts'
import { withBackgroundRuns } from './prompt/background.ts'
import { needsReviewText, overflowText } from './rules.ts'
import { readPlanOf } from './plan.ts'
import { describeError, prepareInput } from './input-intake.ts'
import { createAnnouncer, createMaterialWatch, RESPONSE_EVENTS } from './receipt-accounts.ts'
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


/**
 * 系统提示词的三处追加——规约 → 技能目录 → 后台命令（次序的由头见 `prompt/skills.ts`
 * 与 `prompt/background.ts`：越往后越当下）。
 *
 * 拆成几个小函数只是为了让下面那行读得出来「谁先谁后」；三处都**不接线就原样交回**。
 */
async function withRules(runtime: LoopRuntime, signal: AbortSignal): Promise<string> {
  return (await runtime.rules?.promptFor(runtime.systemPrompt, signal)) ?? runtime.systemPrompt
}

async function withSkills(runtime: LoopRuntime, base: string, signal: AbortSignal): Promise<string> {
  return (await runtime.skills?.promptFor(base, signal)) ?? base
}

/**
 * 后台命令那一块（U89）——**每请求现取**（`runtime.background()` 是一次现读，不是快照）。
 *
 * ⚠️ 它在**每一趟请求**上都算一次，包括超限重发那一趟（`assembleContext` 就在那个循环里）
 * ——那正是要的：重发时的实况可能已经变了（命令在这一轮里跑完了）。
 */
function withBackground(runtime: LoopRuntime, base: string): string {
  return runtime.background === undefined ? base : withBackgroundRuns(base, runtime.background())
}

/** 计划属于常驻材料：旧段被压缩后，目标、步骤与下一步仍每请求在场。 */
function withPlan(runtime: LoopRuntime, base: string): string {
  const { plan } = readPlanOf(runtime.records, runtime.session)
  if (plan === null) return base
  const goal = plan.goal === undefined || plan.goal.trim() === '' ? '' : `目标：${plan.goal}\n`
  const steps = plan.steps.length === 0 ? '步骤：无\n' : `步骤：\n${plan.steps.map(step => `- [${step.status}] ${step.text}`).join('\n')}\n`
  const notes = plan.notes.trim() === '' ? '' : `备注：${plan.notes}\n`
  return `${base}\n\n【当前计划】\n${goal}${steps}${notes}`.trimEnd()
}

// ══ 一轮 ══════════════════════════════════════════════════════════════

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

    // **触发之一：用量达阈值**——压了再跑（见文件头注：撞上超限要白搭一次调用）。
    // 压不成也照常往下走：这是「尽力收敛上下文」，不是本轮的前置条件（B5）
    const compact = runtime.compact
    if (compact !== undefined && compact.needed()) {
      await compact.run({ trigger: 'threshold', signal })
    }

    let providedKnowledge: readonly import('@magic/contracts').KnowledgeReference[] = []
    let text = ''
    /** 思考通道的正文——随助手载荷保存，供同源模型回传。 */
    let thinking = ''
    /** 本轮的聚合结果——超限重发时会被下一次调用覆盖（上一次的结论已作废）。 */
    let result: ModelResult
    /** 超限重发**只给一次机会**（见文件头注）——压完还超限就是真塞不下了。 */
    let retried = false

    // 一次调用 ＋ 消费（超限时整体重来：重装配 → 重发——这才是「压缩后重发」）
    for (;;) {
      providedKnowledge = []
      const provided = (references: readonly import('@magic/contracts').KnowledgeReference[]) => {
        providedKnowledge = [...new Map([...providedKnowledge, ...references].map(reference => [`${reference.id}\0${reference.revision}`, reference])).values()]
      }
      await runtime.collaboration?.consume()
      if (runtime.collaboration?.admit() !== undefined) return close(runtime, 'aborted', false)
      let included: readonly number[] = []
      let userEntries: readonly RecordId[] = []
      const assembly = await assembleContext({
        knowledge: runtime.knowledge,
        onKnowledge: provided,
        // 装配兜底：压缩没做成时，请求也不能以超限的形式发出去（D74）。
        budget: runtime.capacity?.().inputBudget,
        latestInput: runtime.records.inputs.list().filter(row => row.entry !== undefined && row.entry >= inputFrom
          && !row.input.notice && (row.state === 'consumed' || row.state === 'included')).at(-1)?.input.text ?? initialInput,
        records: runtime.records,
        onIncluded: ids => { included = ids },
        onUserEntries: ids => { userEntries = ids },
        session: runtime.session,
        // **项目规约 ＋ 技能目录 ＋ 后台命令**在装配这一步接上（U32 · U33 · U89）——
        // 都现取现接：改过的、跑完的，下一趟就是新的。次序＝环境块 → 规约块 → 技能目录块
        // → 后台命令块（见 `prompt/skills.ts` / `prompt/background.ts`）；
        // 规约那一趟还顺带记账「这一趟送出去哪几版」（预查据它判「拦不拦」）
        systemPrompt: withPlan(runtime, await collaborationPrompt(withBackground(runtime, (await withSkills(runtime, (await withRules(runtime, signal)), signal))), runtime.collaboration, provided)),
      }).then(messages => ({ ok: true as const, messages }), (error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
      // 装配兜底拒绝发送：说清原因，本轮照常收束——不把超预算请求交给供应商，也不让异常冒成 crash。
      if (!assembly.ok) {
        sink.emit(stamper.stamp('error', { message: `本轮不能发送：${assembly.reason}。原始记录已保留。` }))
        return close(runtime, 'error', false)
      }
      const messages = assembly.messages

      if (signal.aborted || runtime.collaboration?.admit() !== undefined) return close(runtime, 'aborted', false)
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
      /**
       * 这一趟请求的**回执欠账还没还**——还的时机是**它真回来了**（见下）。
       */
      let owed = true

      for await (const event of stream.events) {
        // 模型域的事件**原样转发**（`model.call.start` / `model.delta` / `model.usage` /
        // `model.call.end` / `model.error`）——过程流的消费者（渲染 / 记录）按 kind 收窄
        sink.emit(event)

        // **回执在这儿发**（U33）——**这一次请求真回来了**之后，不是「有事件」就发。
        //
        // ⚠️ **首轮在这儿栽过**，记下来免得再犯：当时的判据是「第一条事件到手」，
        // 而真实模型域的第一条**恒为 `model.call.start`**——它是**本地**产的
        // （`normalize.ts`：先 yield 它，之后才去迭代供应商流；`retry.ts`：迭代才调
        // SDK 的 streamer，参数校验与 fetch 都在其后）。于是三条全是假阳性：
        // SDK 参数校验失败（`fetchCalls=0`，请求压根没发）、`call.start` 之后被中止、
        // 本地抛错——它们都**已经发过了 `call.start`**，回执照报成功。
        //
        // 判据因此收紧成「**这一次请求真回来了**」：只有**供应商那边产出的**事件才算数
        // （见 `RESPONSE_EVENTS`）。材料确实在这一次的消息里（`messages` 就是刚装出来、
        // 交给 `gateway.stream` 的那一份），而「回来了」是另一端给的证据——
        // 两边都成立，「这份材料进了实际请求」才是一句有据的话。
        //
        // 报什么由账自己判（报过的身份不再报、`input.settled` 只报一次）——
        // 故逐条调都行，重发那一趟（超限重试）也照旧只报一次。
        if (owed && RESPONSE_EVENTS.has(event.kind)) {
          owed = false
          const acceptedInputs = runtime.records.inputs.included(userEntries)
          for (const input of acceptedInputs) runtime.sink.emit(runtime.stamper.stamp('input.settled', {ref:input.ref,ok:true,stage:'included'}))
          if(acceptedInputs.length>0)runtime.sink.emit(runtime.stamper.stamp('input.pending',{inputs:pendingViews(runtime.records.inputs.list())}))
          runtime.collaboration?.requested(included)
          announce.flush()
        }

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
        if (signal.aborted) return close(runtime, 'aborted', false)
        sink.emit(stamper.stamp('error', { message: `原上下文已超限，压缩未完成（${outcome.reason}），本轮暂不能继续；原始记录已保留，可再试一次，或换用更大的模型` }))
      }

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
          providedKnowledge,
        )
    if (assistantId !== undefined) {
      sink.emit(stamper.stamp('message.assistant', { entry: assistantId }))
    }

    if (calls.length === 0) {
      const changed = await runtime.collaboration?.consume()
      return close(runtime, 'settled', changed === true && runtime.collaboration?.admit() === undefined)
    } // 收束——回到等待输入

    // **目标预查（U32）**——动手**之前**看这一批的目标上有没有**还没送达**的规约。
    // 有：这一批**一份都不执行**（全都还没执行，故全都回填「需重审」），让模型照新规约
    // 复核后重提。整批一起拦而不是逐条拦：同一批里前几条已经动过、后几条才拦住的话，
    // 「照新规约重新提」这句话就只对一半的调用成立——那比整批重提更费解。
    //
    // 三选一（`PreflightResult`）：放行 / 需重审 / **材料超限、这批停在这儿**。
    // 后两种都**不执行**，但**回填的话不同**——超限那种要让模型去告诉用户，不是重提。
    const check = (await runtime.rules?.preflight(calls, signal)) ?? { kind: 'pass' as const }
    const heldText =
      check.kind === 'review'
        ? needsReviewText(check.blocking)
        : check.kind === 'overflow'
          ? overflowText()
          : undefined

    // 同轮多工具——**并发执行、按发起序落账**。
    //
    // 为什么不是「按序逐个」：一个 `bun test` 跑十秒、后面还有三条独立命令，串行等于让用户
    // 干等四遍。并发的**边界**只在执行这一跳：**条目仍按调用序成对落账**
    // （`context.ts` 的配对与回放都靠这条次序），被拒/被扣下的调用照旧在批量发起前判掉。
    //
    // ⚠️ **`halt` 只决定还开不开下一轮**——批里已经发起的命令撤不回来（并发之后「尚未执行
    // 的暂停」这句话就不成立了）。
    let stopped = false
    let rejudging = false
    const begun: StartedCall[] = []

    for (const call of calls) {
      if (signal.aborted) return close(runtime, 'aborted', false)

      rejudging = (await runtime.collaboration?.consume()) === true || rejudging
      const refusal = runtime.collaboration?.admit(call)
      if (refusal !== undefined || rejudging) {
        withholds(runtime, call, refusal ?? '收到新的协作交代，本次尚未执行的调用已暂停；先重新判断。', providedKnowledge)
        continue
      }

      if (heldText !== undefined) {
        withholds(runtime, call, heldText, providedKnowledge)
        continue
      }

      // 调用条目**按发起序**先落（与结果条目成对，回放/在途识别都靠它）
      begun.push(beginToolCall(runtime, call, providedKnowledge))
    }

    // 执行互不影响；落账按发起序串起来（结果条目、计划通报都在这之后）
    //
    // **只对整批都是 `exec` 的并发**：命令互不影响，等四遍才是浪费；而业务工具
    // （写文件、改知识、计划）之间**有先后语义**（读后写、按序改），并发会把它们的意思改掉。
    const parallel = begun.length > 1 && begun.every(one => one.call.name === 'exec')
    if (parallel) {
      const outcomes = await Promise.all(begun.map(one => executeToolCall(runtime, one, signal, announce, watch)))
      for (const [index, one] of begun.entries()) {
        const outcome = outcomes[index]!
        await settleToolCall(runtime, one, outcome)
        if (outcome.halt === true) stopped = true
      }
    } else {
      for (const one of begun) {
        const outcome = await executeToolCall(runtime, one, signal, announce, watch)
        await settleToolCall(runtime, one, outcome)
        if (outcome.halt === true) stopped = true
      }
    }

    // `continues` 为假 ⇒ 回到等待输入（工单第 5 条：这一轮就地收束）
    return close(runtime, signal.aborted ? 'aborted' : 'settled', !signal.aborted && !stopped && runtime.collaboration?.admit() === undefined)
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
 * 一次调用在发起阶段落的账——调用条目 id（结果条目按它成对）。
 *
 * 三阶段分开是**并发**与**按序落账**能同时成立的原因：条目对必须按调用序进记录
 * （`context.ts` 的配对、回放、在途识别都靠这条次序），而执行本身可以同时跑。
 */
type StartedCall = {
  readonly call: ToolCall
  readonly entry: RecordId
}

/** 发起阶段（按序）：调用条目先落账——「有调用无结果」＝在途（恢复按它找）。 */
function beginToolCall(
  runtime: LoopRuntime,
  call: ToolCall,
  knowledge: readonly import('@magic/contracts').KnowledgeReference[],
): StartedCall {
  return { call, entry: appendToolCallEntry(entryLogOf(runtime), call, knowledge) }
}

/**
 * 执行阶段（并发）：只跑工具并回填，**不落结果条目**。
 *
 * `opts.onOutput` 留空：`tool.output.delta` 是**工具域**的产出（事件产出表）——本域不越俎。
 * 工具域违约（抛）时以失败结果回填，不炸整轮。
 */
async function executeToolCall(
  runtime: LoopRuntime,
  started: StartedCall,
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
async function settleToolCall(runtime: LoopRuntime, started: StartedCall, outcome: ToolOutcome): Promise<void> {
  const resultKnowledge = outcome.knowledge ?? (KNOWLEDGE_MATERIAL_TOOLS.has(started.call.name)
    ? knowledgeOutputReferences(started.call.name, await rawTextOf(outcome.content, runtime.records)) : [])
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
function withholds(runtime: LoopRuntime, call: ToolCall, text: string, knowledge: readonly import('@magic/contracts').KnowledgeReference[]): void {
  const log = entryLogOf(runtime)

  appendToolCallEntry(log, call, knowledge)
  // **不成形时那段原文随行**（U84）——与工具域那一条同一形（见 `@magic/tools` 的
  // `toolCallEvent`）：本域不 import 工具域（域间只经契约），故这一位在两处各自成形，
  // 但字段名与判据只有契约那一份。扣下的这一批**同样**可能是坏参数——
  // 「没执行」与「参数不成形」是两件事，后者照样要有据可查。
  const opened = runtime.stamper.stamp('tool.call', {
    name: call.name,
    args: call.args,
    ...(call.rawArgs === undefined ? {} : { rawArgs: call.rawArgs }),
  })
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

  runtime.sink.emit(runtime.stamper.stamp('turn.end', { reason, ...(continues ? { continues: true as const } : {}) }))
  return { reason, continues }
}


