/**
 * 测试台 —— 恢复用例要的那一束（**测试面** · `@magic/faux` 只许出现在 `test/**`）。
 *
 * ⚠️ 与 `@magic/conversation` 测试台的 `makeToolDomain` 是同形的**第二份**：
 * 域与域之间不得互 import（技术方案 · 代码治理），测试面同理——本包只认
 * `@magic/contracts` ＋ `@magic/faux`。两份都对「分发：请求 → 闸门 → 执行 → 回填」
 * 那一条接线负责；集成面的那一次由装配层的用例与真跑覆盖。
 */

import type {
  Entry,
  EventStamper,
  KernelEvent,
  OutputDelta,
  PermissionContext,
  PermissionGate,
  RecoveryScan,
  SessionId,
  ToolCall,
  ToolResult,
  ToolRuntime,
  ToolSpec,
} from '@magic/contracts'
import type {
  FauxPermissionGate,
  FauxRecords,
  FauxSink,
  FauxToolHandler,
  FauxToolRuntime,
  TestStamper,
} from '@magic/faux'
import {
  makeFauxPermissionGate,
  makeFauxRecords,
  makeFauxSink,
  makeFauxToolRuntime,
  makeTestStamper,
} from '@magic/faux'

/** 会话——恢复的入口（用例自定 id 时用 `makeStage({session})`）。 */
export const SESSION = 's-recovery'
export const T0 = 1_700_000_000_000

/** 工作区根——权限与沙箱共用同一份（契约：越界判据两处同源）。 */
export const ROOTS: PermissionContext = { roots: ['/w'], defaultRoot: '/w' }

/** 缺省工具规格——与 `@magic/faux` 骨架同形。 */
export const EXEC_SPEC: ToolSpec = {
  name: 'exec',
  summary: '命令执行（经沙箱 · 工作目录约束）',
  parameters: {},
  danger: { level: 'by-call', note: '按命令解析' },
}

/** 一笔在途调用——除注明外都是「已批准、两侧齐全」的样子。 */
export function callOf(overrides: Partial<RecoveryScan['calls'][number]> = {}): RecoveryScan['calls'][number] {
  return {
    call: 42,
    entry: 2,
    name: 'exec',
    args: { cmd: 'ls' },
    turn: 1,
    requested: true,
    decision: 'approve',
    decider: 'user',
    ...overrides,
  }
}

/** 一次扫描的答案。 */
export function scanOf(
  calls: RecoveryScan['calls'],
  openTurn: number | null = 1,
  session: SessionId = SESSION,
): RecoveryScan {
  return { session, openTurn, lastTurn: openTurn, calls }
}

export type StageOptions = {
  /** `scanInFlight` 的答案——缺省「干净会话」。 */
  readonly scan?: RecoveryScan
  /** 工具处理器——缺省 `exec` 回一句「跑了什么」。 */
  readonly handlers?: Readonly<Record<string, FauxToolHandler>>
  /** 闸门姿势——缺省 `'approve'`（自动）。 */
  readonly auto?: 'approve' | 'reject'
  /** 记录桩起始 id——缺省 1。 */
  readonly fromId?: number
}

export type Stage = {
  readonly stamper: TestStamper
  readonly sink: FauxSink
  readonly records: FauxRecords
  readonly tools: FauxToolRuntime
  readonly gate: FauxPermissionGate
  readonly toolDomain: ToolRuntime
}

/** 造一束替身——铸造器**一束一份**（信封四件同源）。 */
export function makeStage(options: StageOptions = {}): Stage {
  const stamper = makeTestStamper()
  const sink = makeFauxSink()
  const records = makeFauxRecords({
    ...(options.fromId === undefined ? {} : { from: options.fromId }),
    ...(options.scan === undefined ? {} : { scan: options.scan }),
  })
  const gate = makeFauxPermissionGate({ auto: options.auto ?? 'approve' })
  const tools = makeFauxToolRuntime({
    definitions: [EXEC_SPEC],
    handlers: options.handlers ?? { exec: (call) => ({ ok: true, output: `跑了 ${String(call.args.cmd)}` }) },
  })

  return {
    stamper,
    sink,
    records,
    tools,
    gate,
    toolDomain: makeToolDomain({ stamper, sink, gate, ctx: ROOTS, tools }),
  }
}

/** 恢复用例的现场束——从这一束替身拼出来（记录 / 工具 / 扇出 / 铸造器同源）。 */
export function runtimeOf(stage: Stage, idempotent?: (call: { readonly name: string }) => boolean) {
  return {
    session: SESSION,
    records: stage.records,
    tools: stage.toolDomain,
    sink: stage.sink,
    stamper: stage.stamper,
    now: () => T0,
    ...(idempotent === undefined ? {} : { idempotent: (call: { readonly name: string }) => idempotent(call) }),
  }
}

/** 结果条目——`tool-result` 的那些（恢复补的就是它）。 */
export function resultsOf(entries: readonly Entry[]): readonly Entry[] {
  return entries.filter((entry) => entry.kind === 'tool-result')
}

/** 某条目载荷里的记录侧输出文本（内联支）。 */
export function payloadTextOf(entry: Entry): string {
  const payload: unknown = entry.payload
  if (typeof payload !== 'object' || payload === null) return ''
  const output = (payload as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) return ''
  const text = (output as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

/** 事件的 JSON 文本（断措辞用——事件与条目两处都该说同一件事）。 */
export const jsonOf = (event: KernelEvent): string => JSON.stringify(event)

// ═══════════════════════════════════════════════════════════════════════
// 工具域替身（见文件头注：与对话域测试台那份同形）
// ═══════════════════════════════════════════════════════════════════════

type ToolDomainOptions = {
  readonly stamper: EventStamper
  readonly sink: { emit(event: KernelEvent): void }
  readonly gate: PermissionGate
  readonly ctx: PermissionContext
  readonly tools: FauxToolRuntime
}

/**
 * 工具域替身——按「请求 → 闸门 → 执行 → 回填」接线：
 * 铸 `tool.call` → 问闸门（`callRef` ＝**该事件 id**）→ 批准则执行 → 铸 `tool.result`。
 *
 * `@magic/faux` 的工具桩「只回结果、不发事件」（桩的底线是满足端口签名、不发明行为），
 * 而重放那一支要验的正是**闸门在路径内**——故这里另起一个与真接线同形的。
 */
function makeToolDomain(options: ToolDomainOptions): ToolRuntime {
  const { stamper, sink, gate, ctx, tools } = options

  return {
    definitions: (): readonly ToolSpec[] => tools.definitions(),

    async invoke(
      call: ToolCall,
      opts: { signal?: AbortSignal; onOutput?: (d: OutputDelta) => void },
    ): Promise<ToolResult> {
      // ① 铸 `tool.call`——**链引用的来处**（`callRef` 就是它的 id）
      const callEvent = stamper.stamp('tool.call', { name: call.name, args: call.args })
      sink.emit(callEvent)

      // ② 闸门在 `invoke` 路径内（不可绕过）
      const decision = await gate.decide(call, ctx, callEvent.id)

      // ③ 拒绝＝**只影响该调用**——以「拒绝」回填，不执行
      const raw =
        decision === 'approve'
          ? await tools.invoke(call, opts)
          : { ok: false, output: `已拒绝：${call.name}`, content: { text: `已拒绝：${call.name}` } }

      const result: ToolResult = { ...raw, callRef: callEvent.id }

      // ④ 铸 `tool.result`——`call` 取结果的链引用
      sink.emit(
        stamper.stamp('tool.result', { call: result.callRef, ok: result.ok, output: result.content }),
      )

      return result
    },
  }
}

