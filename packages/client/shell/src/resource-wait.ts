/**
 * 资源等待与等待成本的**用户文案与动作映射**——《边界方案》§3.3 动作表与 §3.1 等待成本
 * 的唯一实现处。
 *
 * `quotaClass` / `waitClass` 由 engine 计算并随投影下发，**前端禁止自判**：这里只做
 * 「字段 → 文案/动作」的纯映射，不重算等待成本（P29），不发明引擎内部状态词（N25——
 * 用户文案只说交代的命运）。
 *
 * 权威枚举在 `@magic/contracts`（T0.1 已落地：`QuotaClass` / `WaitClass`）。本模块按宽容
 * `string` 收值：引擎新增资源类型而前端映射未跟上时，**不崩溃、不编动作**，显示通用
 * 「资源不足」（P30 兜底，《边界方案》§3.3 扩展规则的契约测试锁点）。
 *
 * 未知类型为什么不给动作：P31 要求「文案里的动作名在当前状态下真有那条迁移」——
 * 映射表没有的类型，动作无从谈起；等映射表加行（契约加值 → 表加行 → 前端跟动作），
 * 不在这里发明迁移。
 */

import type { BlockedState, QuotaClass, WaitClass } from '@magic/contracts'
import { elapsedLabel } from './boards/settings/time.ts'

/** 动作的稳定 token——渲染层按它接真实命令（T3.1 接线），不按中文文案判。 */
export type ResourceActionKind = 'wait' | 'preempt' | 'switch-model' | 'await-quota' | 'resubmit'

export type ResourceAction = {
  readonly kind: ResourceActionKind
  /** 用户可见的动作名。 */
  readonly label: string
}

export type ResourceWait = {
  /** 用户可见的那句原因——「等执行资源」「等模型配额」「待办已满」「资源不足」。 */
  readonly label: string
  /** 当前状态下真的能生效的动作；未知类型为空。 */
  readonly actions: readonly ResourceAction[]
  /** `executor` 类独有：占用执行资源的会话列表（engine 的 `occupantSessions`，原样呈现）。 */
  readonly occupantSessions?: readonly string[]
}

/** 映射的上下文——全部来自 engine 字段，前端不自判。 */
export type QuotaWaitContext = {
  readonly preemptible?: boolean
  readonly occupantSessions?: readonly string[]
}

export function resourceWaitOf(quotaClass: QuotaClass | string, context: QuotaWaitContext = {}): ResourceWait {
  switch (quotaClass) {
    case 'executor': {
      const actions: ResourceAction[] = [{ kind: 'wait', label: '等' }]
      if (context.preemptible === true) actions.push({ kind: 'preempt', label: '抢占' })
      return {
        label: '等执行资源',
        actions,
        ...(context.occupantSessions === undefined || context.occupantSessions.length === 0
          ? {}
          : { occupantSessions: context.occupantSessions }),
      }
    }
    case 'model':
      return {
        label: '等模型配额',
        actions: [{ kind: 'switch-model', label: '换模型' }, { kind: 'await-quota', label: '等配额恢复' }],
      }
    case 'input-capacity':
      return { label: '待办已满', actions: [{ kind: 'resubmit', label: '一键重发' }] }
    default:
      // 未知 quotaClass：通用文案、无专属动作——《边界方案》§3.3 契约测试锁的就是这一行。
      return { label: '资源不足', actions: [] }
  }
}

/**
 * 资源等待那一行的**纯文本读法**（状态行/列表用，`undefined` 入参＝没有这回事）。
 * 渲染层从这里取整句，不再各处自拼——「同一字段、同一文案」。
 */
export function resourceWaitLine(wait: ResourceWait | undefined): string | undefined {
  if (wait === undefined) return undefined
  const actions = wait.actions.map(action => action.label).join('／')
  const occupants = wait.occupantSessions === undefined ? undefined : `（占用：${wait.occupantSessions.join('、')}）`
  return [wait.label, occupants, actions === '' ? undefined : `可做：${actions}`].filter(Boolean).join(' ')
}

/**
 * **等待成本那一行**（P29）——委派在等结局／咨询只读／告知不必等，**文案来自字段**：
 * `blocking` → 「请稍候，等它结局」；`advisory` → 「只读，可以不等」；`none` → **不给
 * 等待暗示**（缺席即呈现，不写「无需等待」那类反向句）；字段缺席（旧投影/还没算）＝
 * 不呈现。`awaitedByEntry` 由 engine 与 `waitClass` 配套下发（blocking 即「入口在等」），
 * 文案已含其意，不单独造句——两个客户端对同一字段的文案必须同源（P29 验收）。
 */
export function waitLineOf(wait: { readonly waitClass?: WaitClass; readonly awaitedByEntry?: boolean } | undefined): string | undefined {
  switch (wait?.waitClass) {
    case 'blocking': return '请稍候，等它结局'
    case 'advisory': return '只读，可以不等'
    case 'none': return undefined
    default: return undefined // 字段缺席或未知值（枚举扩展未跟上）：没有这笔账，不编
  }
}

/**
 * **阻塞态呈现**（P33 · 《架构师职责裁定草案》§3.6 阻塞态表）——谁在等谁、等了多久、
 * 退出动作、收敛规则，**全部来自 `blocked` 字段**（engine 落账本，重启计时保留）。
 * 返回若干段（详情行按 `·` 拼）；未知类别只报「阻塞中」与时长，**不编退出动作**（P31：
 * 文案里的动作名必须有真迁移）。
 *
 * `awaiting-resource` 返回空——它由 `quotaClass` 那条资源动作行呈现（§3.6 的资源两行
 * 与 §3.3 映射表同源，不重复出两遍）。
 */
export function blockedLinesOf(blocked: BlockedState | undefined, now: number): readonly string[] {
  if (blocked === undefined) return []
  const waited = `已等 ${elapsedLabel(now - blocked.since)}`
  const who = blocked.by === undefined ? '' : `（${blocked.by}）`
  switch (blocked.kind) {
    case 'awaiting-approval':
      return [`等批准${who}`, `可做：批准／拒绝 · ${waited}`]
    case 'awaiting-resource':
      return [] // 资源等待由 quotaClass 动作行呈现（同一张表，不重复）
    case 'awaiting-receipt':
      return ['已交付，待主会话认收', `可做：认收／放弃（放弃记未完成） · 入口结束自动认收 · ${waited}`]
    case 'awaiting-settlement':
      return [`停止待核实：等它核销（执行器可能仍在收尾） · ${waited}`]
    case 'awaiting-reattach':
      return [`执行器失联，等心跳 · 15 秒内转「未确认完成」 · ${waited}`]
    default:
      return [`阻塞中 · ${waited}`] // 未知类别：如实说阻塞与时长，不编动作
  }
}
