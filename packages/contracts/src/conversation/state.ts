/**
 * 状态层字段——统一投影里由 engine 计算与持有的字段（边界方案 §3.1）。
 *
 * **枚举全部定死，前端禁止自判**：前端按值映射呈现与动作（§3.3 动作映射表）；
 * 未知值显示通用兜底（如「资源不足」），不崩溃——契约测试锁这条。
 * 读取快照＋订阅（CQRS 读模型）；除注明外都由 engine 写、TUI 与 App 读。
 */


/**
 * 这一格在等什么——**engine 计算**（只有 engine 知道主会话是否在等该成员；P29）。
 * 变更随投影推送。
 */
export type WaitClass = 'blocking' | 'advisory' | 'none'

/**
 * 资源等待的类别——**定死枚举 ＋ 动作映射表**（§3.3）：新增资源类型＝枚举加值 ＋
 * 映射表加一行 ＋ 前端按新值映射动作。`executor` 类等待由 engine 给出
 * `occupantSessions`（占用方会话列表）；`model`/`input-capacity` 无占用方。
 */
export type QuotaClass = 'executor' | 'model' | 'input-capacity'

/** 通知缘由码——engine 落通知时写；显示端按它映射文案，不自己归因。 */
export type NoticeReasonCode = 'needs-answer' | 'failed' | 'completed' | 'resource-starved' | 'needs-attention'

/**
 * 阻塞态——原因 × 谁等谁 × 退出动作 × 收敛规则（P33：可退出、不无声停留）。
 * **落账本**（engine 写，重启后计时保留）；进入阻塞态写、退出清。
 *
 * ⚠️ **单槽**：`BlockedState` 一次只持一种阻塞。同一会话可能同时存在多种等待
 * （如既等批准又等资源）——并存时按优先级取最高者呈现，其余不丢（解除高者后次者顶上）：
 * `awaiting-approval` > `awaiting-resource` > `awaiting-receipt` > `awaiting-settlement` > `awaiting-reattach`。
 */
export type BlockedKind = 'awaiting-approval' | 'awaiting-resource' | 'awaiting-receipt' | 'awaiting-settlement' | 'awaiting-reattach'

/**
 * 阻塞态载荷（账本三字段的投影形状）。`by` ＝ 会话/成员/execution id；
 * `since` ＝ 何时开始等——「等了多久」由它算（重启不重置）。
 */
export type BlockedState = {
  readonly kind: BlockedKind
  readonly by?: string
  readonly since: number
}
