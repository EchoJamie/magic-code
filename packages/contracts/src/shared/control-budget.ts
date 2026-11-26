/**
 * 控制面预算——**产生侧的目标尺子**，与传输层的绝对上限分开。
 *
 * 2026-11-21 事故：产生侧合法地造了一条 13MB 的 `session.state`，传输层把
 * 「单帧太大」误判成「对端不读」并 `socket.terminate()`。用户的底线是
 * **无论数据多大，界面都要可用**——所以：
 *
 * - `CONTROL_FRAME_BUDGET_BYTES` 是**产生侧**的目标：超过就分页、预览或引用，
 *   不允许原样发出；它远小于传输层的 `WIRE_MESSAGE_BUDGET_BYTES`（8MiB），
 *   给信封、合并与兜底留余量。
 * - 传输层的绝对上限只负责「这一帧一个字节都不写」，**不负责断连接**。
 * - 积压保护只在「对端持续不读、且长时间零进展」时才断；单帧超限永不触发它。
 *
 * 这里的数值都是实现级常量，可以调；语义（产生侧预算 / 传输层兜底 / 积压宽限）
 * 不要混。
 */

/** 产生侧单帧目标——超过就分页/预览/引用。 */
export const CONTROL_FRAME_BUDGET_BYTES = 1024 * 1024

/** 发送积压宽限——欠账持续且零进展达这么久才认「连接坏了」。 */
export const CONTROL_BACKLOG_GRACE_MS = 30_000

/** 积压检查间隔——只在有欠账时挂定时器，有进展就重置。 */
export const CONTROL_BACKLOG_CHECK_MS = 1_000

/** 传输层给控制帧留的余量——积压阈值不得吃满绝对上限。 */
export const CONTROL_RESERVE_BYTES = 64 * 1024

/** 入站未换行残行的硬顶——超过它按协议违规断开，而不是当成一条消息。 */
export const WIRE_RECEIVE_HARD_CAP_BYTES = 64 * 1024 * 1024

/** 列表/提醒里一行预览的目标字节数。 */
export const CONTROL_PREVIEW_TEXT_BYTES = 2 * 1024

/** 目录类消息一页最多多少条——active 排最前，其余由分页/搜索补。 */
export const CONTROL_DIRECTORY_LIMIT = 200

/** 历史单条在线上占的目标字节数——超过就先给预览与来源，正文按需读。 */
export const HISTORY_ENTRY_PREVIEW_BYTES = 16 * 1024

/** 待处理输入在目录/列表里每条正文的预览字节数。 */
export const INPUT_PREVIEW_TEXT_BYTES = 8 * 1024

/**
 * 每会话待办（pending）受理上限——**容量拒收的定值**（总负责人 2026-11-27 裁定：
 * 常量可配置；UI 只说「待办已满」，不出现数字）。到达上限的受理当场拒
 * （rejectedKind='capacity'，原稿留输入位，动作＝一键重发）。
 */
export const PENDING_INPUT_LIMIT = 64
