/**
 * 系统提示词段结构 v0 —— **对话域内部件**（段结构冻结 · 措辞可调）。
 *
 * 出处：技术方案 ·「系统提示词（内核持有）」。
 * 归属——内核持有，随内核版本治理（R2：协作质量归内核）；模板 + 运行时注入。
 * **段结构冻结**；具体文字属实现级，随内核迭代。
 *
 * **M04 迁入**——原落 `packages/kernel/src/contracts/prompt.ts`（那时占契约位）。
 * 技术方案 · 领域划分已定：**系统提示词归对话域内部件**（段结构冻结不变）——
 * 共享语言与跨域端口里都没有它，故降为域内件落此处，不再占契约位。
 * 段标识与顺序**一字未改**；本文件仍是**转写**：只落技术方案已冻结之段结构，不加设计。
 */

/** 必含段 v0（四段）。 */
export type PromptSectionId =
  | 'identity' // ① 身份（单机开发智能体）
  | 'conduct' // ② 行为规范（直接 · 克制 · 先澄清后动手）
  | 'tools' // ③ 工具使用指引（何时用 · 结果解读 · 失败处理）
  | 'permission' // ④ 权限姿态（危险操作会被闸门拦——先说明意图再请求）

/** 运行时注入项（模板变量——技术方案 · 系统提示词：工作目录 · 平台 · 日期）。 */
export type PromptRuntimeVar =
  | 'cwd' // 工作目录
  | 'platform' // 平台
  | 'date' // 日期

/** 段结构 v0——顺序即结构。 */
export const PROMPT_SECTIONS: readonly PromptSectionId[] = [
  'identity',
  'conduct',
  'tools',
  'permission',
]
