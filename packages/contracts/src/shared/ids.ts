/**
 * 共享语言 · 标识与时间口径（已冻结 v0）。
 *
 * 出处：技术方案 · 记录（「标量口径 v0」）。
 * 跨域名词汇——各域与外壳共用同一套标识与时间语义。
 */

/** 记录标识（条目 / 事件共用）——单调，排序权威。 */
export type RecordId = number

/** 会话标识（事件分束预留——技术方案 · 多智能体协作预留）。 */
export type SessionId = string

/**
 * 轮标识——一次用户交代（或 agent 激活）的边界；轮内可以有多次模型调用。
 * 0.2.0 起由记录域分配并落 `turns` 表。
 */
export type TurnId = number

/** 步标识——轮内的一次模型调用及其工具执行；落 `steps` 表。 */
export type StepId = number

/** 执行标识——一次执行者承接；落 `runs` 表，不是会话事实。 */
export type RunId = string

/** 时间戳——**epoch 毫秒**（`at` 与事件时间；技术方案 · 记录 · 标量口径 v0）。 */
export type Timestamp = number

/**
 * 大负载引用——大负载（长输出 / 大 diff）落文件 blob，条目与事件只存引用。
 * **对契约消费者不透明**——实现由记录域定（`blobs/` 下键）；消费方不得解析。
 * **写权唯一归记录域**——沙箱不产引用（只截断回报），转存由调用方经记录域公开面完成
 * （技术方案 · 记录 · 标量口径 v0）。
 */
export type BlobRef = string

/**
 * 裁决标识——**配对用的请求事件 id**（`tool.decision.request` 事件的 `id`）。
 *
 * ⚠️ 与 `tool.*` 事件载荷里的 `call` **不是同一个 id**：`call` 贯穿调用链
 * （请求 / 询问 / 裁决 / 结果四处同指 `tool.call` 事件），而配对用请求事件的 `id`。
 */
export type DecisionId = RecordId

/** 持久协作身份；名称、路径和 PID 均不充当地址。 */
export type AgentId = string
export type CollaborationId = string
export type OperationId = string
export type MessageId = RecordId
export type DelegationId = MessageId
