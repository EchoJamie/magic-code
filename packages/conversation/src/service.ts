/**
 * **一条会话的实例**（`ConversationSession`）——`ConversationService` 的**单会话那一半**。
 *
 * 「`ConversationService`」这个名字在 U16 之后指**会话主面**（`./sessions.ts`）——
 * 设计原话（技术方案 · 领域划分 · 端口签名）：「多会话（阶段 2）的新建 / 切换 / 列表在此
 * 扩展」，故端口由主面实现（单活跃：它持一个活跃会话，`submit` / `interrupt` 转发过去）。
 * 本文件产出的就是**被它持有的那一条**——名字取 `Session` 以免与端口撞脸
 * （U04 时两者是一件事，U16 起不是了）。
 *
 * **本类只做五件**（其余在 `./agent-loop.ts` / `./recovery.ts`）：排队 · 中断 · 状态转场 ·
 * **恢复**（`recover()`——阶段 2 · U15，在放开输入前调一次）· **忙碌位**（`busy()`——
 * 主面据以拒绝「忙时切会话」）。
 *
 * - **排队**——一次只干一件；干活时又来交代，排着（收束后接着跑）。端口是 `void`：
 *   工作异步跑，调用方不等。
 * - **中断**——在途打断（`signal` 落到模型流与工具）＋ **清掉排队中的交代**：
 *   「停下」就是停下，否则会立刻接着跑下一件，与「回到等待输入」相抵。
 *   **空闲时打断＝无事**——「空闲时 Ctrl+C ＝ 退出」由外壳发起（首站不设确认），本域不猜。
 * - **状态转场**——`agent.start`（**首次开工前**发，构造期不发：外壳那时还没订上——装配
 *   纪律「先接订阅、后放开输入」）· `agent.state{resumed}`（干活）· `agent.state{waiting}`
 *   （回到等待输入）。`paused` 是阶段 2 的留位（恢复流程 / 人在环的长暂停），首站不产。
 *
 * 域内件（不上公开面）：提示词部件的读取面 · 装配（`assembleContext`）· 循环（`agentLoop`）·
 * 条目落账——域外本不该看见（深链由守护拦）。
 */

import type {
  EventSink,
  EventStamper,
  ModelGateway,
  RecordsService,
  SessionId,
  Timestamp,
  ToolRuntime,
  TurnId,
  UserInput,
} from '@magic/contracts'
import type { LoopRuntime } from './agent-loop.ts'
import { agentLoop } from './agent-loop.ts'
import { DEFAULT_CONTEXT_POLICY } from './policy.ts'
import type { ContextPolicy } from './policy.ts'
import { buildSystemPrompt } from './prompt/index.ts'
import type { PromptVars } from './prompt/index.ts'
import type { RecoveryDeps, RecoveryReport } from './recovery.ts'
import { recoverSession } from './recovery.ts'

/**
 * 装配期构造入参——一切「谁来实现」的选择由装配根给出（本域不知道背后是谁：
 * 模型域 / 工具域 / 记录域皆经契约端口）。
 */
export type ConversationDeps = {
  /** 会话——条目按会话读；信封的 `session` 由铸造器持（装配按会话实例构造，两处同源）。 */
  readonly session: SessionId
  /** 模型名——随每次调用送模型域。 */
  readonly model: string
  /** 提示词运行时注入值（`cwd` / `platform` / `date`）——**缺项在构造期就报错**。 */
  readonly prompt: PromptVars
  readonly gateway: ModelGateway
  readonly tools: ToolRuntime
  readonly records: RecordsService
  readonly sink: EventSink
  /** 信封铸造器——**产出方铸**（装配按会话实例构造；`turn` 由本域在轮起止时调）。 */
  readonly stamper: EventStamper
  /**
   * 时钟——条目时间戳（记录域不取时钟，U02 备案）；缺省 `Date.now`。
   * 显式注入便于测试（域不各自读时钟，取用经此一处——与权限域的 `now` 同法）。
   */
  readonly now?: (() => Timestamp) | undefined
  /** 上下文策略——缺省 `DEFAULT_CONTEXT_POLICY`；阶段 3 压缩在此长出真正的策略。 */
  readonly context?: Partial<ContextPolicy> | undefined
  /**
   * **恢复面**（阶段 2 · U15）——在途查询（记录域）＋ 幂等判定（工具定义）。
   *
   * 可选：**不接线＝没有恢复**（`recover()` 当场报错，**不静默降级**——静默降级会让人
   * 以为「恢复过了」，而真相是「压根没扫」）。新会话不必接。
   */
  readonly recovery?: RecoveryDeps | undefined
}

/**
 * 一条会话的实例（域内形态）——主面持它、转发控制面的 `submit` / `interrupt`。
 *
 * **`recover()` 的触发点**（U15 的「结构超集」在 U16 转正）：恢复要发事件，故调用方
 * 须在**接好订阅之后、放开输入之前**调（装配纪律「先接订阅、后放开输入」）。
 * 契约上的词已由 U16 补进 `ConversationService.recover()`——此处这一段与它同名同义，
 * 只是返回值更具体（报告是域内形态，不进契约）。
 *
 * **`busy()`** 是主面的判据（U16）：忙时不许切会话——半途切＝一轮的事记到两条会话上。
 * 它只是**读**一个内部位，不改变任何行为（域内件，不外承诺）。
 */
export type ConversationSession = {
  submit(input: UserInput): void
  interrupt(): void
  /** 恢复一次会话——干净会话「什么都不做」（报告里看得出来）。 */
  recover(): Promise<RecoveryReport>
  /** 正在干活（一轮在跑 / 排队中的交代还在）——主面据以「忙时切不动」。 */
  busy(): boolean
}

/**
 * 造**一条会话**的实例——装配的 `open` 工厂按会话各造一份（主面经它持有活跃那条）。
 *
 * **构造期即装配提示词**：注入值缺项（未给 / 空串 / 纯空白）当场抛 `PromptVarsError`
 * ——不静默降级，也不拖到第一轮才炸（「缺值报错不降级」，提示词部件的既定口径）。
 */
export function createConversationSession(deps: ConversationDeps): ConversationSession {
  const { sink, stamper } = deps
  const policy: ContextPolicy = { ...DEFAULT_CONTEXT_POLICY, ...deps.context }

  let turnSeq = 0
  let started = false
  let running = false
  /** 在途工作的中止手柄——`interrupt` 的唯一着力点（空闲时为 `undefined`）。 */
  let current: AbortController | undefined
  const pending: string[] = []

  const runtime: LoopRuntime = {
    session: deps.session,
    model: deps.model,
    systemPrompt: buildSystemPrompt(deps.prompt),
    gateway: deps.gateway,
    tools: deps.tools,
    records: deps.records,
    sink,
    stamper,
    // 单调自增；**续跑接着记录里那串轮号**——`recover()` 按扫描到的水位抬到这里
    // （U04 留的那道缝，U15 填上：同一会话重启后不从 1 重来）
    nextTurnId: (): TurnId => (turnSeq += 1),
    now: deps.now ?? Date.now,
    blobThreshold: policy.blobThreshold,
    blobTextLimit: policy.blobTextLimit,
  }

  async function drain(): Promise<void> {
    const controller = new AbortController()
    current = controller
    running = true

    // 起 · 干活——转场**当场**发生（首个 `await` 之前），外壳不必等模型
    if (!started) {
      started = true
      sink.emit(stamper.stamp('agent.start', {}))
    }
    sink.emit(stamper.stamp('agent.state', { state: 'resumed' }))

    try {
      for (;;) {
        const text = pending.shift()
        if (text === undefined) break

        const outcome = await agentLoop(runtime, { text }, controller.signal)
        // 中止 / 出错＝停下：排队中的交代**不再续跑**（「回到等待输入」是当场的）
        if (outcome !== 'settled') {
          pending.length = 0
          break
        }
      }
    } catch (error) {
      // 兜底（保险 · 正常不可达：循环各处已各自兜底）——走到这里＝扇出 / 铸造器本身炸了。
      // 端口是 `void`，不兜则调用方那头永远看不见这次拒绝
      sink.emit(stamper.stamp('error', { message: `对话域异常：${messageOf(error)}` }))
    } finally {
      running = false
      current = undefined
      // 回到等待输入——收束 / 中止 / 出错**都**回到这里（首站只有这一个稳定态）
      sink.emit(stamper.stamp('agent.state', { state: 'waiting' }))
    }
  }

  return {
    submit(input: UserInput): void {
      pending.push(input.text)
      if (!running) void drain()
    },

    interrupt(): void {
      current?.abort()
      // 「停下」就是停下——排队的交代一并清掉（见文件头注）
      pending.length = 0
    },

    busy: () => running,

    async recover(): Promise<RecoveryReport> {
      const recovery = deps.recovery
      if (recovery === undefined) {
        // 缺值报错不降级（与提示词注入项同法）——静默返回「没事」会让人以为恢复过了
        throw new Error(
          '对话域未接线恢复面——`ConversationDeps.recovery`（在途查询 ＋ 幂等判定）必填；' +
            '恢复没有第二条识途，缺了就不扫（不是「扫了没事」）。',
        )
      }
      if (running) {
        throw new Error('恢复要在**放开输入之前**调（装配纪律：先接订阅、后放开输入）——在干活时恢复会与循环抢同一条记录流')
      }

      const report = await recoverSession({
        session: deps.session,
        records: deps.records,
        tools: deps.tools,
        sink,
        stamper,
        now: runtime.now,
        blobThreshold: policy.blobThreshold,
        inFlight: recovery.inFlight,
        ...(recovery.idempotent === undefined ? {} : { idempotent: recovery.idempotent }),
      })

      // 轮号续跑——记录里的水位抬到这里（下一轮接着那串号走，不从 1 重来）
      if (report.lastTurn !== null) turnSeq = Math.max(turnSeq, report.lastTurn)
      // 恢复发过 `agent.start` ⇒ 本实例的「首次开工」已发生，首次 submit 别再发一次
      if (report.turn !== null || report.dispositions.length > 0) started = true

      return report
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
