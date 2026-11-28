/** 轮边界（外循环端口）——从 agent-loop.ts 拆出的「轮前 / 批前 / 收尾」判定与账务。
 *
 * 拆它的由头（边界方案 §七 · M1）：这些是**横切在轮循环体里的特性逻辑**——协作准入、
 * 压缩、提示词材料、回执账务、知识记账。循环核心只调这里的端口，不再知道有哪几层材料、
 * 哪些策略；每个关注点一个归属文件，改 A 碰不到 B。
 *
 * 与 Claude Code 的对应：`prepareModelContext` ≈ 调模型前的预处理管道（压缩/材料/准入）；
 * `gateToolBatch` ≈ 工具批前的 use-hook 位；`afterModelError` ≈ 终止原因→处置的映射。
 * 判据全部来自运行时端口（runtime.*），本文件不含任何「替会话决定」的状态。
 */
import type { ModelErrorTier, RecordId, ToolCall } from '@magic/contracts'
import { pendingViews } from '@magic/contracts'
import { assembleContext, rawTextOf } from './context.ts'
import { collaborationPrompt } from './collaboration.ts'
import { KNOWLEDGE_MATERIAL_TOOLS, knowledgeOutputReferences } from './knowledge-material.ts'
import { appendToolCallEntry, appendToolResultEntry } from './entries.ts'
import { withBackgroundRuns } from './prompt/background.ts'
import { readPlanOf } from './plan.ts'
import { needsReviewText, overflowText } from './rules.ts'
import { RESPONSE_EVENTS } from './receipt-accounts.ts'
import { entryLogOf, type Announcer, type LoopRuntime } from './loop-runtime.ts'
import type { ToolOutcome } from './entries.ts'

// ══ 提示词材料链（边界方案 §七 B3）═══════════════════════════════════

async function withRules(runtime: LoopRuntime, signal: AbortSignal): Promise<string> {
  return (await runtime.rules?.promptFor(runtime.systemPrompt, signal)) ?? runtime.systemPrompt
}

async function withSkills(runtime: LoopRuntime, base: string, signal: AbortSignal): Promise<string> {
  return (await runtime.skills?.promptFor(base, signal)) ?? base
}

/**
 * 后台命令那一块（U89）——**每请求现取**（`runtime.background()` 是一次现读，不是快照）。
 *
 * ⚠️ 它在**每一趟请求**上都算一次，包括超限重发那一趟——那正是要的：重发时的实况
 * 可能已经变了（命令在这一轮里跑完了）。
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

// ══ 轮账务（边界方案 §七 B4 + B5）═════════════════════════════════════

/**
 * 一轮的边界账务——回执（哪些输入真进了请求）与知识记账（哪些材料被提供/产出）。
 *
 * **每轮造一份**：`owed` 每趟请求重置（超限重发那一趟照旧只报一次回执）、
 * 知识引用每趟重聚合（原文 `providedKnowledge` 的口径：按 `id\0revision` 去重、
 * 保留首次出现的次序）。
 */
/** 一轮的边界账务（显式接口——避免 ReturnType 自引用）。 */
export type TurnAccounting = {
  /** 每趟模型调用开头重置——超限重发那一趟的知识聚合与回执都从头记账（原口径）。 */
  newPass(): void
  /** 装配/协作提示提供的知识引用——按 `id\0revision` 去重、保留首次出现次序。 */
  provide(references: readonly import('@magic/contracts').KnowledgeReference[]): void
  /** 本趟已聚合的知识引用——落 assistant 条目与工具批都带它。 */
  readonly references: readonly import('@magic/contracts').KnowledgeReference[]
  /** 装配结果登记——回执 flush 时按它核销「已送达」的输入。 */
  registerResponseScope(included: readonly number[], userEntries: readonly RecordId[]): void
  /** 流式事件过账——返回 true ＝「这一次请求真回来了」（回执在这一刻还上）。 */
  onStreamEvent(event: { readonly kind: string }): boolean
  /** 工具结果的知识引用——知识材料工具的产出由本模块归属。 */
  resultKnowledge(
    call: ToolCall,
    outcome: Pick<ToolOutcome, 'knowledge' | 'content'>,
  ): Promise<readonly import('@magic/contracts').KnowledgeReference[]>
}

export function createTurnAccounting(runtime: LoopRuntime, announce: Announcer): TurnAccounting {
  const refs = new Map<string, import('@magic/contracts').KnowledgeReference>()
  let owed = true
  let included: readonly number[] = []
  let userEntries: readonly RecordId[] = []

  return {
    /** 每趟模型调用开头重置——超限重发那一趟的知识聚合与回执都从头记账（原口径）。 */
    newPass() {
      refs.clear()
      owed = true
    },
    provide(references: readonly import('@magic/contracts').KnowledgeReference[]) {
      for (const reference of references) refs.set(`${reference.id}\0${reference.revision}`, reference)
    },
    get references() {
      return [...refs.values()]
    },
    /** 装配结果登记——回执 flush 时按它核销「已送达」的输入。 */
    registerResponseScope(includedIds: readonly number[], userEntriesIds: readonly RecordId[]): void {
      included = includedIds
      userEntries = userEntriesIds
    },
    /**
     * 流式事件过账。**返回 true ＝「这一次请求真回来了」**——回执欠账在这一刻还上
     * （判据与原实现一字不差：只有**供应商产出的**事件才算数，`call.start` 这类本地帧
     * 不算——首轮假阳性事故的教训见 agent-loop.ts 的注）。
     */
    onStreamEvent(event: { readonly kind: import('@magic/contracts').EventKind; readonly data?: unknown }): boolean {
      // 用量读数是压缩的触发凭据（分子/分母一次到齐——D10 口径），先过账再判回执。
      if (event.kind === 'model.usage') runtime.compact?.observe((event as { readonly data: { readonly inputTokens?: number | undefined; readonly contextWindow?: number | undefined } }).data)
      if (!owed || !RESPONSE_EVENTS.has(event.kind)) return false
      owed = false
      const acceptedInputs = runtime.records.inputs.included(userEntries)
      for (const input of acceptedInputs) {
        runtime.sink.emit(runtime.stamper.stamp('input.settled', { ref: input.ref, ok: true, stage: 'included' }))
      }
      if (acceptedInputs.length > 0) {
        runtime.sink.emit(runtime.stamper.stamp('input.pending', { inputs: pendingViews(runtime.records.inputs.list()) }))
      }
      runtime.collaboration?.requested(included)
      announce.flush()
      return true
    },
    /** 工具结果的知识引用——知识材料工具的产出由本模块归属（边界方案 §七 B5）。 */
    async resultKnowledge(call: ToolCall, outcome: Pick<ToolOutcome, 'knowledge' | 'content'>) {
      return outcome.knowledge ?? (KNOWLEDGE_MATERIAL_TOOLS.has(call.name)
        ? knowledgeOutputReferences(call.name, await rawTextOf(outcome.content, runtime.records))
        : [])
    },
  }
}

// ══ 轮前闸（边界方案 §七 B1 轮前 + B2 阈值）══════════════════════════

/** 轮起的一次性前置：用量达阈值 → 压了再跑（「撞上超限要白搭一次调用」，B5）。 */
export async function beforeTurn(runtime: LoopRuntime, signal: AbortSignal): Promise<void> {
  const compact = runtime.compact
  if (compact !== undefined && compact.needed()) {
    await compact.run({ trigger: 'threshold', signal })
  }
}

/**
 * 调用前预处理管道（每趟模型调用一次，超限重发也走它）：协作消费 → 准入 →
 * 材料链 → 上下文装配。**返回三种走法**：
 * - `ready`：请求可发（messages 就绪；回执范围已登记）；
 * - `aborted`：被中止，或协作准入拒了这一轮（收束方式由调用方定：`close('aborted')`）；
 * - `error`：装配兜底拒绝发送（说清原因，本轮照常收束——不把超预算请求交给供应商）。
 */
export async function prepareModelContext(
  runtime: LoopRuntime,
  signal: AbortSignal,
  accounting: TurnAccounting,
  inputFrom: RecordId,
  initialInput: string | undefined,
): Promise<
  { kind: 'ready'; readonly messages: Awaited<ReturnType<typeof assembleContext>>; included: readonly number[] }
  | { kind: 'aborted' }
  | { kind: 'error'; readonly reason: string }
> {
  accounting.newPass()
  // **协作消费与准入**——这一轮让不让进，由账面事实答（消费可能带回新交代/约束）。
  await runtime.collaboration?.consume()
  // **打断插入式的并入点**（一期 · 唯一）：工具结果之后、下一请求装配之前。
  await runtime.consumeInserts?.()
  if (runtime.collaboration?.admit() !== undefined) return { kind: 'aborted' }

  let included: readonly number[] = []
  let userEntries: readonly RecordId[] = []
  const assembly = await assembleContext({
    knowledge: runtime.knowledge,
    onKnowledge: refs => accounting.provide(refs),
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
    // → 后台命令块；规约那一趟还顺带记账「这一趟送出去哪几版」（预查据它判「拦不拦」）。
    systemPrompt: withPlan(runtime, await collaborationPrompt(withBackground(runtime, (await withSkills(runtime, (await withRules(runtime, signal)), signal))), runtime.collaboration, refs => accounting.provide(refs))),
  }).then(messages => ({ ok: true as const, messages }), (error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))

  if (!assembly.ok) return { kind: 'error', reason: assembly.reason }
  if (signal.aborted || runtime.collaboration?.admit() !== undefined) return { kind: 'aborted' }
  accounting.registerResponseScope(included, userEntries)
  return { kind: 'ready', messages: assembly.messages, included }
}

/** 超限处置（B2 的第二条触发路径）——`context-limit` 压一次、本轮重发（只给一次机会）。 */
export async function afterModelError(
  runtime: LoopRuntime,
  tier: ModelErrorTier | undefined,
  signal: AbortSignal,
  alreadyRetried: boolean,
): Promise<'retry' | 'aborted' | 'stop'> {
  if (tier !== 'context-limit' || alreadyRetried || runtime.compact === undefined) return 'stop'
  const outcome = await runtime.compact.run({ trigger: 'context-limit', signal })
  if (outcome.ok) return 'retry'
  if (signal.aborted) return 'aborted'
  runtime.sink.emit(runtime.stamper.stamp('error', { message: `原上下文已超限，压缩未完成（${outcome.reason}），本轮暂不能继续；原始记录已保留，可再试一次，或换用更大的模型` }))
  return 'stop'
}

// ══ 收束判定（外循环端口——轮尾的「续不续」由账面回答）════════════════

/** 无工具调用的轮收束：协作消费可能带回新交代，续不续由账面回答（原判据原样）。 */
export async function settleContinuation(runtime: LoopRuntime): Promise<boolean> {
  const changed = await runtime.collaboration?.consume()
  // 收束前还有插入的话——并入并续跑（插入式的最后一个并入点）。
  const inserted = await runtime.consumeInserts?.()
  return (changed === true || inserted === true) && runtime.collaboration?.admit() === undefined
}

/** 轮尾继续条件的一翼：协作准入当前是否放行（未拒 ＝ true）。 */
export function admitted(runtime: LoopRuntime): boolean {
  return runtime.collaboration?.admit() === undefined
}

// ══ 工具批前闸（边界方案 §七 B1 批前 + B6 规约预查）══════════════════

/**
 * 一批工具调用的**批前裁决**——哪些执行、哪些扣下（含扣下的账目书写）。
 *
 * 三类扣下（都不碰工具域，账目与事件**成对闭合**，见 `withhold`）：
 * - 协作准入拒绝（`admit(call)`）；
 * - 批内出现了新的协作交代（`consume()` 返回真——同一批里前几条已动、后几条被拦的
 *   话比整批重提更费解，故**整批一起拦**的口径沿旧）；
 * - 目标预查（U32）：这一批的目标上有还没送达的规约——一份不执行。
 *
 * 批内每条发起前自查中止（与原实现同拍：consume/预查的间隙里也可能来中止）。
 */
export async function gateToolBatch(
  runtime: LoopRuntime,
  calls: readonly ToolCall[],
  signal: AbortSignal,
  knowledge: readonly import('@magic/contracts').KnowledgeReference[],
): Promise<{ readonly begun: readonly ToolBatchCall[]; readonly aborted: boolean }> {
  const check = (await runtime.rules?.preflight(calls, signal)) ?? { kind: 'pass' as const }
  const heldText =
    check.kind === 'review'
      ? needsReviewText(check.blocking)
      : check.kind === 'overflow'
        ? overflowText()
        : undefined

  let rejudging = false
  const begun: ToolBatchCall[] = []
  for (const call of calls) {
    if (signal.aborted) {
      // **中止收口**（P0 修复）：此前迭代已放进 begun 的调用，条目已经落在台账上
      // （beginToolCall）——就此返回会让它们永远「有调用无结果」（在途语义被中止批量制造）。
      // 补一条「没跑」的结果条目配平；不发 `tool.result` 事件——`tool.call` 事件从未
      // 发出，屏上本就没有这几件在飞的东西可清。
      for (const started of begun) {
        appendToolResultEntry(entryLogOf(runtime), {
          ok: false, text: `已停止：${started.call.name} 没有开始执行`, content: { text: `已停止：${started.call.name} 没有开始执行` }, notExecuted: true,
        })
      }
      return { begun, aborted: true }
    }
    rejudging = (await runtime.collaboration?.consume()) === true || rejudging
    const refusal = runtime.collaboration?.admit(call)
    if (refusal !== undefined || rejudging) {
      withhold(runtime, call, refusal ?? '收到新的协作交代，本次尚未执行的调用已暂停；先重新判断。', knowledge)
      continue
    }
    if (heldText !== undefined) {
      withhold(runtime, call, heldText, knowledge)
      continue
    }
    // 调用条目**按发起序**先落（与结果条目成对，回放/在途识别都靠它）
    begun.push(beginToolCall(runtime, call, knowledge))
  }
  return { begun, aborted: false }
}

/** 批内一条已放行的调用——发起阶段的落账形态（结果条目按它成对）。 */
export type ToolBatchCall = {
  readonly call: ToolCall
  readonly entry: RecordId
}

function beginToolCall(
  runtime: LoopRuntime,
  call: ToolCall,
  knowledge: readonly import('@magic/contracts').KnowledgeReference[],
): ToolBatchCall {
  return { call, entry: appendToolCallEntry(entryLogOf(runtime), call, knowledge) }
}

/** 扣下一次调用——落账一对条目 ＋ 发一对事件，**不碰工具域**（连闸门都没问）。 */
function withhold(
  runtime: LoopRuntime,
  call: ToolCall,
  text: string,
  knowledge: readonly import('@magic/contracts').KnowledgeReference[],
): void {
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

