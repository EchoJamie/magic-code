/**
 * `PermissionGate` —— 权限域端口（技术方案 · 领域划分：工具域 → 权限域，闸门在 `invoke` 路径内）。
 *
 * 一次裁决的全流程：
 *
 *   机械分析（工具名 ＋ 参数）→ 危险分级 → **规则命中？** → 自动放行（`decider: 'auto'`）
 *     ／否则发 `tool.decision.request`（带材料与呈现轻重）→ 等答复（`resolve`，配对＝请求事件 id）
 *     → 发 `tool.decision` → 返回裁决
 *
 * **优先级：必闸 ＞ 规则 ＞ 默认问**（技术方案 · 权限「规则化（阶段 2）」）——
 * 阶段 1 的**默认照旧是问**（一律人工门），规则是唯一的例外路径；而必闸类是**禁区**：
 * 规则只在 `analyze` 判**轻**时才有资格放行，判重一律问（清单即禁区，任何规则不可放行）。
 * 判据不在规则作者那一侧——`analyze` 每次当场重判，配错规则也放不出必闸类。
 *
 * 纪律（技术方案 · 领域划分 · 权限域）：**裁决独立**（不自证、不押模型自述）·
 * **只走事件、不入条目**——故本域注入面只有 `EventSink`（`emit` 一件）与 `EventStamper`，
 * **结构上拿不到条目面**（`RecordsService` 才是条目面，本域不注入）。
 *
 * **调用链引用（`callRef`）必填**（第 2 轮契约对齐 · `PermissionGate.decide` 三参）——
 * 它是「请求 → 询问 → 裁决 → 结果」四事件**串链**的依据（审计与阶段 2 恢复的在途识别
 * 都按它找）；而它产生在本域之外（工具域铸 `tool.call` 时才有），故只能由调用方传入。
 * **不设哨兵兜底**：静默的 `-1` 比缺参更坏——接线漏了应当在**编译期**就报。
 */

import type {
  Decision,
  DecisionId,
  EventSink,
  EventStamper,
  PermissionContext,
  PermissionGate as PermissionGatePort,
  RecordId,
  ToolCall,
} from '@magic/contracts'
import { analyze } from './analyze.ts'
import { decisionMade, decisionRequest } from './events.ts'
import type { PermissionRule } from './rules.ts'
import { describeRule, matchRule, type CallFace } from './rules.ts'

/**
 * 权限域公开面——**即契约端口**（`decide` 三参 · `resolve` 两件）。
 *
 * 第 2 轮契约对齐：`callRef` 由可选注入位**升为必填参数**（见 `decide` 头注）。
 *
 * 两处**结构超集**（契约零改动 · 两参照常工作）：
 * - `decide` 的第三参 `callRef`——第四轮由契约补锚（已是端口形态本身）；
 * - `resolve` 的第三参 `options`——本单元的「总是允许」（契约答复词表尚未容下它，见 `ResolveOptions`）。
 */
export interface PermissionGate extends PermissionGatePort {
  decide(call: ToolCall, ctx: PermissionContext, callRef: RecordId): Promise<Decision>
  /**
   * 控制域答复路由至此——配对键＝**请求事件** `id`。
   *
   * 第三参是**结构超集**（契约端口两参照常工作，同 U07 之例）：`options.remember` ＝
   * 外壳的第三个按钮**「总是允许」**——本会话此后**同类**不再问（见 `ResolveOptions`）。
   */
  resolve(requestId: DecisionId, decision: Decision, options?: ResolveOptions): void
}

/**
 * `resolve` 的加宽位——「总是允许」（技术方案 · 权限：放行区——「总是允许」按
 * （工具 × 路径模式 × 操作类型）记录）。
 *
 * 落在本域是**会话级记忆**：凝成一条会话规则（工具 × 本次的操作类型；路径一格缺省＝根内），
 * 与配置规则同一套匹配、同一关禁区。**不落盘**——新会话＝新闸门实例＝记忆清零（阶段性）。
 *
 * ⚠️ 契约面的答复词表（`Decision` / `DecisionAnswer`）目前只有批准 / 拒绝两词，
 * 故本单元把这个能力落在**加宽位**上：控制域两参路由照旧（＝不记忆），
 * 端到端接上需要一个契约词（见回报「待决」）。
 */
export type ResolveOptions = {
  /** 「总是允许」——**只在批准时生效**（规则的条目只有「允许」这一形，没有「总是拒绝」）。 */
  readonly remember?: boolean
}

export type PermissionGateOptions = {
  /** 事件扇出入口（装配注入；本域只发不收）。 */
  readonly sink: EventSink
  /**
   * 信封铸造器——**产出方铸**（技术方案 · 领域划分 · 信封的归属 v0 锚定）。
   *
   * 对本域是硬约束：请求事件的 `id` 就是答复配对键，id 必须**当场铸**。
   * ⚠️ **必填，本域无缺省**——权限域不自造计数、不自取时钟。
   */
  readonly stamper: EventStamper
  /**
   * **持久规则**——（工具 × 路径模式 × 操作类型）→ 允许（技术方案 · 权限「规则化」）。
   *
   * 由装配从配置文件读来、经 `parseRules` 校验后注入（本域不碰文件系统，也不写回）。
   * **缺省＝无规则**：那便是阶段 1 的姿态——每个调用都问。
   */
  readonly rules?: readonly PermissionRule[] | undefined
  /**
   * 时钟（毫秒）——**度量**用：裁决耗时 ＝ 本域开始处理这次裁决 → 裁决落定
   * （`tool.decision.elapsedMs`；两种路径同一口径，见 `events.ts` · `decisionMade`）。
   * 缺省 `Date.now`；显式注入便于测试（域不各自读时钟，取用经此一处）。
   */
  readonly now?: (() => number) | undefined
}

/** 一件在途询问。 */
type Pending = {
  /** 调用链引用——裁决事件沿用（与配对键不是同一个 id）。 */
  readonly call: RecordId
  /** 度量锚：本域开始处理这次裁决的时刻（`elapsedMs` ＝ 它 → 答复）。 */
  readonly at: number
  /** 这次问的是「同类」里的哪一类——「总是允许」据此凝出会话规则（当场凝好，答复时不再重判）。 */
  readonly sessionRule: PermissionRule
  readonly settle: (decision: Decision) => void
}

/** 造一个权限闸门——内核的裁决者（契约端口 `PermissionGate` 的落地）。 */
export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const { sink, stamper } = options
  const now = options.now ?? Date.now
  const rules = options.rules ?? []

  /** 在途询问——**请求事件 id** → 待答复（答复按此配对）。 */
  const pending = new Map<DecisionId, Pending>()

  /**
   * **会话级记忆**——「总是允许」凝出的规则，按答复次序排在配置规则之后。
   *
   * 落在闭包里＝**会话级**：新会话＝新闸门实例＝清空（技术方案 · 权限：「总是允许」＝会话级记忆）。
   * 配置规则在前、记忆在后，只有材料里那句「是哪一条命中的」会因此不同。
   */
  const sessionRules: PermissionRule[] = []

  /** 自动放行——不发询问（没问），只落一条裁决事件：**裁者是 `auto`，耗时是真实测量**。 */
  function autoAllow(callRef: RecordId, started: number): Promise<Decision> {
    sink.emit(
      decisionMade(stamper, {
        call: callRef,
        decision: 'approve',
        decider: 'auto',
        elapsedMs: now() - started,
      }),
    )
    return Promise.resolve('approve')
  }

  return {
    decide(call, ctx, callRef) {
      const started = now() // 度量起点：本域开始处理这次裁决（人工 / 自动同一把尺子）
      const { weight, material, ops, landings } = analyze(call, ctx)

      // 规则轴与判定轴读的是**同一份** `analyze` 结论——两条路径结构上无从分叉
      const face: CallFace = { tool: call.name, ops, landings }
      // 配置规则在前、会话记忆在后——两条来路的规则同一套匹配、同一关禁区
      const rule = matchRule(rules, face, ctx) ?? matchRule(sessionRules, face, ctx)

      // **必闸 ＞ 规则**：命中的规则只在判定为**轻**时才有资格放行；判重一律问——
      // 必闸类是禁区（清单即禁区），任何规则不可放行。判据不押规则作者的自觉。
      if (rule !== undefined && weight === 'light') return autoAllow(callRef, started)

      const request = decisionRequest(stamper, {
        call: callRef,
        name: call.name,
        // 规则命中却被禁区否决时说清缘由——配了规则的人第一个会问的就是「为什么还问我」
        material: rule === undefined ? material : vetoed(material, rule),
        weight,
      })

      // **先登记、后扇出**——外壳可能在同一调用栈里答复（答复不必等一轮事件循环），
      // 顺序反了这条答复就落在空表上（丢答复＝永久挂起）。
      const answered = new Promise<Decision>((settle) => {
        pending.set(request.id, { call: callRef, at: started, sessionRule: sessionRuleOf(face), settle })
      })

      sink.emit(request)

      return answered
    },

    resolve(requestId, decision, options) {
      const question = pending.get(requestId)
      // 陌生 id（迟到 / 重复 / 伪造）＝忽略——不抛、不猜、不改写
      if (question === undefined) return
      pending.delete(requestId)

      // 「总是允许」——只认批准（规则只有「允许」这一形）；重复的同类条目不重复入册
      if (options?.remember === true && decision === 'approve' && !sessionRules.some((seen) => sameRule(seen, question.sessionRule))) {
        sessionRules.push(question.sessionRule)
      }

      // 裁决只走事件、不入条目（技术方案 · 领域划分 · 权限域）；耗时＝本域开始处理 → 答复（度量埋点）
      sink.emit(
        decisionMade(stamper, {
          call: question.call,
          decision,
          decider: 'user', // 人答的——自动放行走 `autoAllow`，两条路径的裁者分得开
          elapsedMs: now() - question.at,
        }),
      )

      question.settle(decision)
    },
  }
}

/**
 * 规则命中却被禁区否决——把缘由写进材料。
 *
 * 这一句是给**配规则的人**的：规则写宽了、碰到必闸类时，界面上的询问会照着材料显示，
 * 没有这一句，用户只会看到「配了规则还是问」而不知道规则其实命中了（且**本该**被否决）。
 */
function vetoed(material: string, rule: PermissionRule): string {
  return [
    material,
    `规则：命中「${describeRule(rule)}」但被必闸禁区否决（必闸 ＞ 规则——必闸类任何规则不可放行）。`,
  ].join('\n')
}

/**
 * 「总是允许」凝出的**会话规则**——（工具 × 本次调用的操作类型）；路径一格缺省＝**根内**。
 *
 * 三格照技术方案「按（工具 × 路径模式 × 操作类型）记录」落：工具**收到具体名**
 * （不推广到别的工具）、操作类型收到**本次实际发生的那几类**（复合命令的每一段都算数）、
 * 路径不写＝根内（用户说的是「这类事别再问」，不是「机器上哪儿都行」）。
 */
function sessionRuleOf(face: CallFace): PermissionRule {
  return { tool: face.tool, op: [...face.ops] }
}

/** 两条规则同不同——只为「总是允许」不重复入册（顺序无关的集合比对）。 */
function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.tool === b.tool && a.path === b.path && opKey(a.op) === opKey(b.op)
}

function opKey(op: PermissionRule['op']): string {
  if (op === undefined) return ''
  return (Array.isArray(op) ? op : [op]).join(',')
}
