/**
 * `@magic/conversation` —— **对话域**（核心域）· 跨域可见面。
 *
 * 职责（技术方案 · 领域划分）：Agent 运行——主循环 · 上下文装配 · 系统提示词 · 中断 / 恢复。
 * ⚠️ 其中的「恢复」自 U25 起只指**第 ⑤ 步**（重建面：装载 ＋ 上下文由条目重建）——
 * ①②③④ 的编排归应用层（见文件末那一节）。设计表那一行尚未随之改写，以本注为准。
 * 对外端口 `ConversationService`（在 `@magic/contracts`）；本包＝它的实现域。
 * 域内规则：不认知任何域的内部、不认知外壳与供应商；会话推进（条目落账）归本域。
 *
 * **公开面三件**（技术方案 · 代码治理 · 边界纪律：「域包的 exports 只出**端口实现 ＋
 * 装配期构造入参形态**；域内读取面 / 内部视图 / 测试辅助不上公开面」——
 * 本条由 U04 落 `ConversationService` 时**定形**，见 M04 回报待决 2）：
 *
 * | 件 | 落点 |
 * | --- | --- |
 * | **端口实现**——`createConversationService` | `./service.ts` |
 * | **构造入参形态**——`ConversationDeps` | 同上 |
 * | 入参用到的两个形态——`PromptVars` · `ContextPolicy` | `./prompt/` · `./policy.ts` |
 *
 * **不出去**：提示词部件的读取面（`buildSystemPrompt` / `splitSystemPrompt` / `renderSection` …）·
 * Context 装配（`assembleContext`）· 主循环（`agentLoop`）· 条目落账（`./entries.ts`）。
 * 它们只在域内用（域外深链 `@magic/conversation/src/…` 由守护拦下）——**没出，就没承诺**：
 * 形态要改随时可改，不必当公开契约待。
 *
 * 域内引用一律相对路径（并行规约 1：域不得 import 他人内部）；跨域只经 `@magic/contracts`。
 */

// —— 端口实现 ＋ 装配期构造入参形态 ——

/**
 * 「端口实现」在 U16 之后是**两件合起来**：
 * - `createConversationService` —— **会话主面**，`ConversationService`（含多会话的
 *   新建 / 切换 / 列表 / 改名 / 恢复）的落地；单活跃，`submit` / `interrupt` 转发给活跃那条；
 * - `createConversationSession` —— **一条会话的实例**，装配的 `open` 工厂按会话各造一份。
 *
 * 两件的名与实一一对应（U04 时 `createConversationService` 就是单会话实例，U16 起
 * 那个位置归主面——端口名跟着端口走）。
 */
export { createConversationService } from './sessions.ts'
export type { SessionHost, SessionHostDeps, SessionInstance } from './sessions.ts'

export { createConversationSession } from './service.ts'
export type { ConversationDeps, ConversationSession, RebuildReport } from './service.ts'

// 构造入参里点名用到、装配根必须拿得到的两件形态：
// 提示词运行时注入值（`cwd` / `platform` / `date`）与上下文策略（阈值 / 截断）
export type { PromptVars } from './prompt/index.ts'
export type { ContextPolicy } from './policy.ts'

// ⚠️ **恢复的编排不在这里**（U25 起）——本域只出**重建面**（`ConversationService.rebuild`：
// 装载 ＋ 认下水位与开工位）。在途识别（记录域端口）与②③④的处置（重放 / 落账 / 记中止）
// 归应用层 `@magic/actions`；出在这儿的是它拿去用的那几个形态（`RebuildReport` 等）。
