/**
 * 系统提示词段结构 v0 —— **提示词契约**（已冻结 · 措辞可调）。
 *
 * 出处：技术方案 · 系统提示词（内核持有）。
 * 归属——内核持有，随内核版本治理（R2：协作质量归内核）；模板 + 运行时注入。
 * **段结构冻结**；具体文字属实现级，随内核迭代。
 *
 * 本文件是**转写**：只落技术方案已冻结之段结构，不加设计。
 */

/** 必含段 v0（四段）。 */
export type PromptSectionId =
  | 'identity' // ① 身份（单机开发智能体）
  | 'conduct' // ② 行为规范（直接 · 克制 · 先澄清后动手）
  | 'tools' // ③ 工具使用指引（何时用 · 结果解读 · 失败处理）
  | 'permission' // ④ 权限姿态（危险操作会被闸门拦——先说明意图再请求）

/**
 * 运行时注入项（模板变量）。
 *
 * TODO(规划侧)：技术方案只列三项（工作目录 · 平台 · 日期），未定变量名；占位如下。
 */
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
