/**
 * `ConversationService` —— 对话域的**端口实现**（技术方案 · 领域划分：控制域 → 对话域）。
 *
 * **公开面**（技术方案 · 代码治理 · 边界纪律：「域包的 exports 只出**端口实现 ＋ 装配期
 * 构造入参形态**；域内读取面 / 内部视图 / 测试辅助不上公开面」——M04 回报待决 2 由本单元定形）：
 *
 * | 出 | 件 |
 * | --- | --- |
 * | **端口实现** | `createConversationService` |
 * | **构造入参形态** | `ConversationDeps`（＋它用到的 `PromptVars` · `ContextPolicy`） |
 *
 * 不出去的：提示词部件的读取面（`splitSystemPrompt` / `renderSection` …）· 装配（`assembleContext`）·
 * 循环（`agentLoop`）· 条目落账——那都是**域内件**，域外本不该看见（深链由守护拦）。
 *
 * **本类只做四件**（其余在 `./agent-loop.ts` / `./recovery.ts`）：排队 · 中断 · 状态转场 ·
 * **恢复**（`recover()`——阶段 2 · U15，在放开输入前调一次）。
 *
 * - **排队**——一次只干一件；干活时又来交代，排着（收束后接着跑）。端口是 `void`：
 *   工作异步跑，调用方不等。
 * - **中断**——在途打断（`signal` 落到模型流与工具）＋ **清掉排队中的交代**：
 *   「停下」就是停下，否则会立刻接着跑下一件，与「回到等待输入」相抵。
 *   **空闲时打断＝无事**——「空闲时 Ctrl+C ＝ 退出」由外壳发起（首站不设确认），本域不猜。
 * - **状态转场**——`agent.start`（**首次开工前**发，构造期不发：外壳那时还没订上——装配
 *   纪律「先接订阅、后放开输入」）· `agent.state{resumed}`（干活）· `agent.state{waiting}`
 *   （回到等待输入）。`paused` 是阶段 2 的留位（恢复流程 / 人在环的长暂停），首站不产。
 */

import type {
  ConversationService,
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
 * 端口实现 ＋ **恢复面**（**结构超集** · 契约零改动——U14 的先例）。
 *
 * 恢复要一个触发点，而契约的 `ConversationService` 只有 `submit` / `interrupt`：
 * 塞进 `submit`（凭会话有没有在途自己决定跑不跑）＝替外壳拿主意，且与「放开输入」的
 * 时机纠缠；故本域**加一个方法**，由调用方在**接好订阅之后、放开输入之前**调
 * （恢复要发事件，外壳得先订上——装配纪律「先接订阅、后放开输入」）。
 * 契约该处的词归阶段 2 的会话面（U16）一并定，见回报「待决」。
 */
export type RecoverableConversationService = ConversationService & {
  /** 恢复一次会话——干净会话「什么都不做」（报告里看得出来）。 */
  recover(): Promise<RecoveryReport>
}

/**
 * 造一个对话域实例——契约端口 `ConversationService` 的落地。
 *
 * **构造期即装配提示词**：注入值缺项（未给 / 空串 / 纯空白）当场抛 `PromptVarsError`
 * ——不静默降级，也不拖到第一轮才炸（「缺值报错不降级」，提示词部件的既定口径）。
 */
export function createConversationService(deps: ConversationDeps): RecoverableConversationService {
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
