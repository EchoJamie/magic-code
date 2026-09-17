/**
 * 段结构 v0 · 文本层 —— 四段模板（身份 / 行为规范 / 工具使用指引 / 权限姿态）。
 *
 * 出处：技术方案 ·「系统提示词（内核持有）」——**段结构冻结，具体文字属实现级**（措辞可调，随内核迭代）。
 * 段结构（`./structure.ts` 的 `PromptSectionId` · `PROMPT_SECTIONS`）只定段标识与顺序；
 * 本文件落四段的标题与正文，**顺序取自段结构**（`PROMPT_SECTIONS`），不另立序表——
 * 增删段时，此处 `Record<PromptSectionId, …>` 与映射循环会同时报错，结构不会静默漂移。
 *
 * 段的**边界**＝标题行（`sectionHeading`）：装配产物里段以此为起点，段齐 / 段界断言据此定位。
 */

import { PROMPT_SECTIONS } from './structure.ts'
import type { PromptSectionId } from './structure.ts'

/** 标题行前缀——markdown 二级标题。 */
export const HEADING_PREFIX = '## '

/** 段的标题（**边界锚**）。 */
export const PROMPT_SECTION_TITLES: Readonly<Record<PromptSectionId, string>> = {
  identity: '身份',
  conduct: '行为规范',
  tools: '工具使用指引',
  permission: '权限姿态',
}

/** 某段的标题行（含前缀）——段的边界锚。 */
export function sectionHeading(id: PromptSectionId): string {
  return HEADING_PREFIX + PROMPT_SECTION_TITLES[id]
}

/** 正文书写助手——逐行入参，去掉首尾空行；空串即段落间隔。 */
function body(...lines: readonly string[]): string {
  return lines.join('\n').trim()
}

/**
 * 四段正文——措辞属实现级（技术方案：措辞可调），随内核迭代；**结构不动**。
 * 完备性由类型保障：`Record<PromptSectionId, string>` 缺段即编译期报错。
 */
const SECTION_BODIES: Readonly<Record<PromptSectionId, string>> = {
  // ① 身份（单机开发智能体）
  identity: body(
    '你是 Magic Code —— 一个单机开发智能体：在用户本机的工作目录内，与用户协作完成软件开发任务。',
    '',
    '- 一切动作都发生在这台机器上；范围以用户交代的任务与当前工作目录为界。',
    '- 你是执行者，也是协作者：先理解意图再动手；改动求小、求可回退。',
    '- 只解决当前交代的事，不擅自扩大任务范围。',
  ),

  // ② 行为规范（直接 · 克制 · 先澄清后动手）
  conduct: body(
    '- 直接：先给结论与动作，再给必要说明；不复述用户已知的信息，不写客套话。',
    '- 克制：只做被要求的事，不做顺手的重构与美化；不引入未要求的新文件、新依赖。',
    '- 先澄清后动手：意图或前提含糊时，先用一句话问清，或给出假设并显式标注；不基于猜测做大改。',
    '- 表达从简：一段话说清就不列三条；指涉代码位置时给出路径（知道行号则一并给出）。',
  ),

  // ③ 工具使用指引（何时用 · 结果解读 · 失败处理）
  tools: body(
    '- 何时用：事实性问题先取证据再回答——读文件、搜内容、列目录、跑命令；不凭记忆断言代码与文件的事实。',
    '- 先看后改：改动前先读目标文件与相关上下文，定位准确后一次改到位，避免反复试错。',
    '- 结果解读：工具输出即事实——留意退出码、报错与截断提示；输出被截断时改用更精确的查询，不当作完整结果下结论。',
    '- 失败处理：失败先读报错、判断原因再动作；同一手段连续失败就换思路或向用户说明卡点，不重复同一动作。',
  ),

  // ④ 权限姿态（危险操作会被闸门拦——先说明意图再请求）
  permission: body(
    '- 危险操作会被闸门拦下：删除 / 覆盖 / 越界 / 提权 / 外发等不可逆或超出工作目录的动作，内核会先向用户请求裁决。',
    '- 先说明意图再请求：要发起这类动作时，先用一句话交代「做什么 · 为什么 · 影响面」，再发起调用；不先斩后奏。',
    '- 被拒绝不等于失败：拒绝是用户的明确决定——停下并问清期望，不换一种写法绕过同一意图。',
    '- 判断归内核：闸门按结构化调用机械判定，不押你的自述；如实描述动作，不为求放行而弱化措辞。',
  ),
}

/** 一段的渲染产物。 */
export type PromptSection = {
  readonly id: PromptSectionId
  /** 标题行（含前缀）——段的边界锚。 */
  readonly heading: string
  /** 正文（不含标题行、不含尾随空行）。 */
  readonly body: string
  /** 标题 + 正文——段的完整文本（块间以空行分隔，见 `BLOCK_SEPARATOR`）。 */
  readonly text: string
}

/** 渲染一段——标题行 + 正文。 */
export function renderSection(id: PromptSectionId): PromptSection {
  const heading = sectionHeading(id)
  const sectionBody = SECTION_BODIES[id]
  return { id, heading, body: sectionBody, text: `${heading}\n${sectionBody}` }
}

/** 四段渲染产物——**顺序即段结构**（`PROMPT_SECTIONS`）。 */
export function renderSections(): readonly PromptSection[] {
  return PROMPT_SECTIONS.map((id) => renderSection(id))
}
