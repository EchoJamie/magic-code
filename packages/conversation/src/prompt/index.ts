/**
 * 系统提示词 —— **公开面**（M04 迁入 · 对话域内部件 · `@magic/conversation`）。
 *
 * 段结构 v0（技术方案 ·「系统提示词（内核持有）」）——模板 + 运行时注入（工作目录 · 平台 · 日期）。
 * 域内消费者（U04 · 主循环 · 提示词装配）请只 import 本文件；段结构归 `./structure.ts`
 * （**域内部件**——已不占契约位，跨域语言里没有它）。
 *
 * 消费面：
 * - `buildSystemPrompt(vars) → string` —— 一步取全量系统提示词；
 * - `buildPromptBlocks(vars)` / `splitSystemPrompt(prompt)` —— 块的装配与读取（段边界可测）；
 * - `sectionHeading(id)` —— 段的边界锚（段齐 / 段界断言据此定位）。
 *
 * 注入值的来源由调用方给——本模块不读文件系统、不读环境变量、不取当前时间。
 */

export { PROMPT_SECTIONS } from './structure.ts'
export type { PromptSectionId, PromptRuntimeVar } from './structure.ts'

export {
  HEADING_PREFIX,
  PROMPT_SECTION_TITLES,
  renderSection,
  renderSections,
  sectionHeading,
} from './sections.ts'
export type { PromptSection } from './sections.ts'

export {
  BLOCK_SEPARATOR,
  ENVIRONMENT_BLOCK_ID,
  ENVIRONMENT_HEADING,
  PROMPT_RUNTIME_VARS,
  PromptVarsError,
  buildPromptBlocks,
  buildSystemPrompt,
  renderEnvironment,
  splitSystemPrompt,
} from './assembly.ts'
export type { PromptBlock, PromptBlockId, PromptVars } from './assembly.ts'
