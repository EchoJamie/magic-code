/**
 * 测试台 —— 一束替身 ＋ **工具域替身** ＋ 装好的循环依赖（U04 用例的接线活文档）。
 *
 * 本文件两份东西：
 * ① **工具域替身**（`makeToolDomain`）——见其头注（为何不用 `@magic/faux` 的工具桩）；
 * ② **一束现成替身**（`makeStage` / `makeLoopRuntime` / `makeServiceDeps`）——
 *    多数用例照此拼装，不各写一份。
 *
 * ⚠️ 本目录是**测试面**：`@magic/faux` 只许出现在 `test/**`（技术方案 · 代码治理 ·
 * 测试面分面）——生产面（`src/**`）只许 `@magic/contracts`，守护拦。
 */

import type {
  Content,
  EventStamper,
  KernelEvent,
  OutputDelta,
  PermissionContext,
  PermissionGate,
  RecordId,
  ToolCall,
  ToolResult,
  ToolRuntime,
  ToolSpec,
} from '@magic/contracts'
import type {
  FauxDecider,
  FauxGateway,
  FauxPermissionGate,
  FauxRecords,
  FauxSink,
  FauxToolHandler,
  FauxToolRuntime,
  FauxTurn,
  TestStamper,
} from '@magic/faux'
import {
  DEFAULT_TEST_SESSION,
  FAUX_MODEL,
  FIXED_AT,
  createFauxGateway,
  makeFauxPermissionGate,
  makeFauxRecords,
  makeFauxSink,
  makeFauxToolRuntime,
  makeTestStamper,
} from '@magic/faux'
import { DEFAULT_CONTEXT_POLICY } from '../../src/policy.ts'
import type { ContextPolicy } from '../../src/policy.ts'
import { createCompactor } from '../../src/compact.ts'
import type { Compactor } from '../../src/compact.ts'
import type { LoopRuntime } from '../../src/agent-loop.ts'
import { buildSystemPrompt } from '../../src/prompt/index.ts'
import type { PromptVars } from '../../src/prompt/index.ts'

/** 工作区根——权限与沙箱共用同一份（契约：越界判据两处同源）。 */
export const ROOTS: PermissionContext = { roots: ['/w'], declaredRoots: ['/w'], defaultRoot: '/w' }

/** 缺省提示词注入值——三项齐（`cwd` / `platform` / `date`）。 */
export const PROMPT_VARS: PromptVars = {
  cwd: '/w',
  platform: 'darwin',
  date: '2026-09-18',
}

/** 缺省工具规格——与 `@magic/faux` 骨架同形（阶段 1 唯一工具 `exec`）。 */
export const EXEC_SPEC: ToolSpec = {
  name: 'exec',
  summary: '命令执行（经沙箱 · 工作目录约束）',
  parameters: {},
  danger: { level: 'by-call', note: '按命令解析' },
}

/** 缺省工具处理器——回一句「跑了什么」，便于断言回填内容。 */
export const echoExec: FauxToolHandler = (call) => ({ ok: true, output: `跑了 ${String(call.args.cmd)}` })

// ═══════════════════════════════════════════════════════════════════════
// 工具域替身
// ═══════════════════════════════════════════════════════════════════════

export type ToolDomainOptions = {
  readonly stamper: EventStamper
  readonly sink: { emit(event: KernelEvent): void }
  readonly gate: PermissionGate
  readonly ctx: PermissionContext
  /** 工具体——复用 `@magic/faux` 的工具桩（处理器分发 ＋ `calls` 留痕）。 */
  readonly tools: FauxToolRuntime
  /**
   * **记录侧形态**的产法——真工具域在此把输出转成记录形态（小则内联、大则落 blob）。
   * 缺省一律内联（够多数用例）；要给「大输出落 blob」做端到端用例时，传一个会转存的实现。
   */
  readonly record?: (text: string) => Content | Promise<Content>
}

/**
 * 拒绝的结果——工具域把「拒绝」也做成一条记录形态的结果（契约：以「拒绝」回填，不执行）。
 * `content`（记录侧）与 `output`（面向模型的文本）在此同源：拒绝没有大输出可言，一律内联。
 */
function rejected(call: ToolCall, callRef: RecordId): ToolResult {
  const output = `已拒绝：${call.name}`
  return { ok: false, output, content: { text: output }, callRef }
}

/**
 * 工具域替身（**测试台 · 不是生产代码**——真实现归 U06）。
 *
 * 按技术方案 · 工具「分发：模型请求 → 闸门 → 沙箱执行 → 结果回填」接线：
 *
 *   铸 `tool.call` → 问闸门（`callRef` ＝**该事件 id**）→ 批准则执行 → 铸 `tool.result`
 *
 * **为何另起一个**——`@magic/faux` 的工具桩「只回结果、不发事件」（桩的底线是满足端口签名、
 * 不发明行为），而真工具域**要发** `tool.call` / `tool.result`（技术方案 · 领域划分 ·
 * 事件产出）。U04 的判据（拒绝只影响该调用 · 同轮按序）要在这条**与真装配同形**的接线下面验。
 *
 * **两处照契约补锚（第 2 轮）**——`ToolResult` 载两样输出：`content`（记录侧形态）进
 * `tool.result` 事件的 `output`；`callRef`（链引用）进事件的 `call` 与条目侧。替身扮演工具域，
 * 故 `callRef` 取**本次** `tool.call` 事件的 id（桩的 `callRef` 是构造期占位，不作数）。
 *
 * 已知不替的两件（与真工具域的差距，集成时对不上要看这里）：
 * - 不转 `tool.output.delta`（执行输出增量归 `onOutput`，本替身不透传）；
 * - 不产 `tool.decision.request` / `tool.decision`（那是**权限域**的产出，桩不发事件）。
 * - 不按大小转 blob——`content` 一律内联（桩的 `content` 本就内联；阈值归真工具域）。
 */
export function makeToolDomain(options: ToolDomainOptions): ToolRuntime {
  const { stamper, sink, gate, ctx, tools } = options
  const record = options.record ?? ((text: string): Content => ({ text }))

  return {
    definitions: (): readonly ToolSpec[] => tools.definitions(),

    async invoke(call: ToolCall, opts: { signal?: AbortSignal; onOutput?: (d: OutputDelta) => void }): Promise<ToolResult> {
      // ① 铸 `tool.call`——**链引用的来处**（`callRef` 就是它的 id）
      const callEvent = stamper.stamp('tool.call', { name: call.name, args: call.args })
      sink.emit(callEvent)

      // ② 闸门在 `invoke` 路径内（不可绕过）——阶段 1 一律人工门
      const decision = await gate.decide(call, ctx, callEvent.id)

      // ③ 拒绝＝**只影响该调用**——以「拒绝」回填，不执行
      const raw = decision === 'approve' ? await tools.invoke(call, opts) : rejected(call, callEvent.id)

      // 替身在此扮演**工具域**：记录侧形态由它转（桩一律内联，故经 `record` 钩子按需转存）；
      // 链引用取**本次**调用的事件 id（桩的 `callRef` 是构造期占位，不作数）
      const result: ToolResult = {
        ...raw,
        content: await record(raw.output),
        callRef: callEvent.id,
      }

      // ④ 铸 `tool.result`——`call` 取结果的链引用；`output` 取**记录侧形态**（与条目载荷同物）
      sink.emit(
        stamper.stamp('tool.result', {
          call: result.callRef,
          ok: result.ok,
          output: result.content,
        }),
      )

      return result
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 一束现成的替身
// ═══════════════════════════════════════════════════════════════════════

export type StageOptions = {
  /** Faux 脚本——**一段一轮**（第 n 次 `stream()` 取第 n 段）。 */
  readonly turns?: readonly FauxTurn[]
  /** 每步之间的等待（毫秒）——测中断时给消费方留窗口。 */
  readonly stepDelayMs?: number
  /** 工具处理器——缺省 `{ exec: echoExec }`。 */
  readonly handlers?: Readonly<Record<string, FauxToolHandler>>
  /** 工具规格——缺省 `[EXEC_SPEC]`。 */
  readonly definitions?: readonly ToolSpec[]
  /** 闸门姿势——缺省 `'approve'`（自动）；不给则人工（`gate.pending` ＋ `resolve`）。 */
  readonly auto?: FauxDecider | undefined
  /** 提示词注入值——缺省 `PROMPT_VARS`。 */
  readonly promptVars?: PromptVars
  /** 记录桩起始 id——缺省 1。 */
  readonly fromId?: number
  /** 工具域替身的**记录侧形态**产法——缺省一律内联（见 `ToolDomainOptions.record`）。 */
  readonly record?: (text: string) => Content | Promise<Content>
}

export type Stage = {
  readonly stamper: TestStamper
  readonly sink: FauxSink
  readonly records: FauxRecords
  readonly gateway: FauxGateway
  readonly tools: FauxToolRuntime
  readonly gate: FauxPermissionGate
  readonly toolDomain: ToolRuntime
  readonly promptVars: PromptVars
}

/** 造一束替身——铸造器**一束一份**（信封四件同源）。 */
export function makeStage(options: StageOptions = {}): Stage {
  const stamper = makeTestStamper()
  const sink = makeFauxSink()
  const records = makeFauxRecords(options.fromId === undefined ? {} : { from: options.fromId })
  const gate = makeFauxPermissionGate(options.auto === undefined ? { auto: 'approve' } : { auto: options.auto })
  const tools = makeFauxToolRuntime({
    definitions: options.definitions ?? [EXEC_SPEC],
    handlers: options.handlers ?? { exec: echoExec },
  })

  return {
    stamper,
    sink,
    records,
    gateway: createFauxGateway({
      stamper,
      turns: options.turns ?? [],
      ...(options.stepDelayMs === undefined ? {} : { stepDelayMs: options.stepDelayMs }),
    }),
    tools,
    gate,
    toolDomain: makeToolDomain({
      stamper,
      sink,
      gate,
      ctx: ROOTS,
      tools,
      ...(options.record === undefined ? {} : { record: options.record }),
    }),
    promptVars: options.promptVars ?? PROMPT_VARS,
  }
}

/** 循环依赖（域内构造入参）——多数用例只需覆盖一两处。 */
export function makeLoopRuntime(stage: Stage, overrides: Partial<LoopRuntime> = {}): LoopRuntime {
  let turn = 0

  return {
    session: DEFAULT_TEST_SESSION,
    model: FAUX_MODEL,
    systemPrompt: buildSystemPrompt(stage.promptVars),
    gateway: stage.gateway,
    tools: stage.toolDomain,
    records: stage.records,
    sink: stage.sink,
    stamper: stage.stamper,
    nextTurnId: () => (turn += 1),
    now: () => FIXED_AT,
    blobThreshold: DEFAULT_CONTEXT_POLICY.blobThreshold,
    blobTextLimit: DEFAULT_CONTEXT_POLICY.blobTextLimit,
    ...overrides,
  }
}

/**
 * 造一个**接到这一束替身上的**压缩器（U19）——摘要走同一段 Faux 脚本。
 *
 * 缺省策略＝生产那一套（阈值高得在测试里自然不触发）；要验触发就传 `policy`
 * 把阈值压到脚本体量（如 `{ compactAtTokens: 10 }`）。
 */
export function makeCompactor(
  stage: Stage,
  options: { readonly model?: string; readonly policy?: Partial<ContextPolicy> } = {},
): Compactor {
  const policy: ContextPolicy = { ...DEFAULT_CONTEXT_POLICY, ...options.policy }

  return createCompactor({
    records: stage.records,
    session: DEFAULT_TEST_SESSION,
    gateway: stage.gateway,
    model: options.model ?? FAUX_MODEL,
    sink: stage.sink,
    stamper: stage.stamper,
    now: () => FIXED_AT,
    blobThreshold: policy.blobThreshold,
    blobTextLimit: policy.blobTextLimit,
    nearEntries: policy.nearEntries,
    compactAtFraction: policy.compactAtFraction,
    compactAtTokens: policy.compactAtTokens,
    compactFailureLimit: policy.compactFailureLimit,
  })
}

// ═══════════════════════════════════════════════════════════════════════
// 等待助手
// ═══════════════════════════════════════════════════════════════════════

/**
 * 等一个条件成立——**让出几次**（不是「睡够时间」）：异步流水线（消费流 → 问闸门）
 * 要跑过几处 `await` 才轮到测试关心的那一步（与 `@magic/faux` 骨架的 `waitFor` 同法）。
 */
export async function waitFor<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const found = probe()
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`等不到：${what}`)
}

/**
 * 等回到等待输入（`agent.state{waiting}`）——端口是 `void`，用例据此收口。
 *
 * 判据取**最后一次状态转场**（不是「出现过」）：同一束替身连跑几段工作时，
 * 「曾经 waiting 过」当场就成立，那样会等不到第二段真的跑完。
 */
export async function waitUntilIdle(sink: FauxSink): Promise<void> {
  await waitFor(
    () => (sink.byKind('agent.state').at(-1)?.data.state === 'waiting' ? true : undefined),
    '回到等待输入（agent.state{waiting}）',
  )
}
