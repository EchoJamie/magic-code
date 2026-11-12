/**
 * 调度面契约——引擎管理 ↔ 执行者。
 *
 * 四件：放置（Place）、绑定（Bind）、健康（Health）、回收（Reclaim）。
 * 引擎只决定「哪个执行者、在哪、能碰到什么」，然后退出路径；不解释会话消息。
 * 0.2.0 只有单引擎与本地执行者；远程宿主、多引擎目录是 0.3.0 预规划。
 */
import type { ModelChoice } from '../shared/model.ts'
import type { SessionId, Timestamp, TurnId } from '../shared/ids.ts'

/** 执行者标识——由引擎分配，界面只在绑定里看到它。 */
export type ExecutorId = string

/** 一次放置请求——按会话、工作区、模型与负载选执行者。 */
export type PlaceRequest = {
  readonly session: SessionId
  readonly workspace: readonly string[]
  readonly choice?: ModelChoice
  /** 当前承接代次；替换执行者时递增。 */
  readonly generation: number
}

/** 绑定——执行者地址、令牌、工作区、能力集；寿命等于一次承接。 */
export type Binding = {
  readonly session: SessionId
  readonly executor: ExecutorId
  /** 会话面连接地址（本机为 Unix socket；远程形态留到 0.3.0）。 */
  readonly address: string
  readonly token: string
  readonly workspace: readonly string[]
  readonly capabilities: readonly string[]
  readonly generation: number
  readonly boundAt: Timestamp
}

/** 健康读数——引擎持有，不写会话记录。 */
export type ExecutorHealth = {
  readonly executor: ExecutorId
  readonly alive: boolean
  readonly checkedAt: Timestamp
  readonly detail?: string
}

/** 回收请求——执行者替换或结束后释放。 */
export type ReclaimRequest = {
  readonly executor: ExecutorId
  readonly generation: number
  readonly turn?: TurnId
  readonly reason?: string
}

/** 调度面动作词表——线上与测试共用，不靠字符串各写一遍。 */
export const PLACEMENT_ACTIONS = ['place', 'health', 'reclaim'] as const

/** 调度面——引擎实现；界面看不见。 */
export type SchedulingFace = {
  place(request: PlaceRequest): Promise<Binding>
  health(executor: ExecutorId): Promise<ExecutorHealth>
  reclaim(request: ReclaimRequest): Promise<void>
}
