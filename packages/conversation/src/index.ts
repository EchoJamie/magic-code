/**
 * `@magic/conversation` —— **对话域**（核心域）。
 *
 * 职责（技术方案 · 领域划分）：Agent 运行——主循环 · 上下文装配 · 系统提示词 · 中断 / 恢复。
 * 对外端口 `ConversationService`（在 `@magic/contracts`）；本包＝它的实现域。
 * 域内规则：不认知任何域的内部、不认知外壳与供应商；会话推进（条目落账）归本域。
 *
 * 当前进度（M04 · 对话域落位）：本步只落**提示词部件**（`prompt/`）——
 * 主循环 · 上下文装配归 **U04**，到站时在此扩公开面（＋ `ConversationService` 实现）。
 *
 * 域内引用一律相对路径（并行规约 1：域不得 import 他人内部）；跨域只经 `@magic/contracts`。
 */
export * from './prompt/index.ts'
