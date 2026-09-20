/**
 * 系统提示词装配 —— 模板 + 运行时注入（技术方案 ·「系统提示词（内核持有）」）。
 *
 * 装配产物 ＝ 段结构四段（`PROMPT_SECTIONS` 顺序）+ 环境注入块；
 * 消费面是 `buildSystemPrompt(vars) → string`——U04（主循环 · 提示词装配）直接取用。
 *
 * **注入值的来源由调用方给**——本单元不读文件系统、不读环境变量、不取当前时间
 * （那是装配方的事；缺值报错而非就地取材）。
 */

import { PROMPT_SECTIONS } from './structure.ts'
import type { PromptRuntimeVar, PromptSectionId } from './structure.ts'
import { renderSections, sectionHeading } from './sections.ts'

// —— 块 ——

/**
 * 环境注入块标识。
 *
 * 技术方案「段结构 v0」列了环境注入，但段结构 `PROMPT_SECTIONS` 只冻四段（身份 / 行为 / 工具 / 权限）
 * ——故环境以**追加块**落于四段之后，不改段结构、不新增 `PromptSectionId`（只增不改）。
 */
export const ENVIRONMENT_BLOCK_ID = 'environment'

/** 环境注入块的标题行（**边界锚**）。 */
export const ENVIRONMENT_HEADING = '## 环境'

/**
 * 项目规约块标识（U32）。
 *
 * 与环境块同一条先例——**只增不改**：段结构 `PROMPT_SECTIONS` 仍是四段，规约以**追加块**
 * 落于其后（见 `./rules.ts`，那份材料的正文与边界都在那儿）。块的**词汇**（标识 / 标题）
 * 归本文件统一持有：`splitSystemPrompt` 的标题表就在下面，两处若各写一份，改标题时会漏掉一头。
 */
export const PROJECT_RULES_BLOCK_ID = 'project-rules'

/** 项目规约块的标题行（**边界锚**）。 */
export const PROJECT_RULES_HEADING = '## 项目规约'

/**
 * 技能目录块标识（U33）。
 *
 * 同一条先例——**只增不改**：段结构 `PROMPT_SECTIONS` 仍是四段，技能目录以**追加块**
 * 落于规约块之后（见 `./skills.ts`，那份材料的正文与边界都在那儿）。
 */
export const SKILLS_BLOCK_ID = 'skills'

/** 技能目录块的标题行（**边界锚**）。 */
export const SKILLS_HEADING = '## 可用技能'

/** 块的标识——段结构四段之一，或三个追加块（环境注入 · 项目规约 · 技能目录）。 */
export type PromptBlockId =
  | PromptSectionId
  | typeof ENVIRONMENT_BLOCK_ID
  | typeof PROJECT_RULES_BLOCK_ID
  | typeof SKILLS_BLOCK_ID

/** 装配产物的一块。 */
export type PromptBlock = {
  readonly id: PromptBlockId
  /** 标题行（含前缀）——块的边界锚。 */
  readonly heading: string
  /** 正文（不含标题行、不含尾随空行）。 */
  readonly body: string
  /** 标题 + 正文——块的完整文本。 */
  readonly text: string
}

/** 块间分隔——空行。 */
export const BLOCK_SEPARATOR = '\n\n'

// —— 运行时注入 ——

/** 注入值——段结构 `PromptRuntimeVar` 的取值（来源由调用方给）。 */
export type PromptVars = Readonly<Record<PromptRuntimeVar, string>>

/**
 * 注入项与**呈现顺序**——段结构只给类型，未给齐序表（实现级补充：只增不改）。
 * `satisfies` 保证不写错名；漏项由测试的齐项断言拦下。
 */
export const PROMPT_RUNTIME_VARS = [
  'cwd',
  'platform',
  'date',
] as const satisfies readonly PromptRuntimeVar[]

/** 注入项的中文标签（环境块逐行呈现）。 */
const RUNTIME_VAR_LABELS: Readonly<Record<PromptRuntimeVar, string>> = {
  cwd: '工作目录',
  platform: '平台',
  date: '日期',
}

/**
 * 装配错误——运行时注入值缺失（未给 / 空串 / 纯空白）。
 * 缺失即**报错**，不静默降级为占位文本：静默降级会把「没有工作目录」的提示词送去模型，错得无声。
 */
export class PromptVarsError extends Error {
  /** 缺失的注入项（按 `PROMPT_RUNTIME_VARS` 顺序）。 */
  readonly missing: readonly PromptRuntimeVar[]

  constructor(missing: readonly PromptRuntimeVar[]) {
    super(`系统提示词缺运行时注入值：${missing.join('、')}——注入值由调用方提供（内核不就地取材）`)
    this.name = 'PromptVarsError'
    this.missing = missing
  }
}

/** 校验注入值——未给 / 空串 / 纯空白一律记缺失。 */
function assertVars(vars: PromptVars): void {
  // 防 JS 调用方传空——类型层已要求齐项，运行时再兜一层
  const source: Partial<Record<PromptRuntimeVar, unknown>> = vars ?? {}

  const missing = PROMPT_RUNTIME_VARS.filter((name) => {
    const value = source[name]
    return typeof value !== 'string' || value.trim() === ''
  })

  if (missing.length > 0) throw new PromptVarsError(missing)
}

/**
 * 环境注入块——标题 + 逐项一行。
 * 值**按原样呈现**（不修剪）：校验只拒绝空白，不改造调用方给的内容。
 */
export function renderEnvironment(vars: PromptVars): PromptBlock {
  assertVars(vars)

  const body = PROMPT_RUNTIME_VARS.map((name) => `- ${RUNTIME_VAR_LABELS[name]}：${vars[name]}`).join(
    '\n',
  )

  return {
    id: ENVIRONMENT_BLOCK_ID,
    heading: ENVIRONMENT_HEADING,
    body,
    text: `${ENVIRONMENT_HEADING}\n${body}`,
  }
}

// —— 装配 / 边界读取 ——

/** 装配全部块——段结构四段（`PROMPT_SECTIONS` 顺序）+ 环境注入块（殿后）。 */
export function buildPromptBlocks(vars: PromptVars): readonly PromptBlock[] {
  return [...renderSections(), renderEnvironment(vars)]
}

/** 装配系统提示词——消费面（U04 · 主循环 · 提示词装配）。 */
export function buildSystemPrompt(vars: PromptVars): string {
  return buildPromptBlocks(vars)
    .map((block) => block.text)
    .join(BLOCK_SEPARATOR)
}

/**
 * 已知标题 → 块标识（四段 + 环境块 + 项目规约块）。
 *
 * 规约块那一行**即便多数产物里没有这一块也要在**：缺席与「读不出来」是两回事——
 * 少了它，一份带规约的提示词会被切错（规约的标题与正文被算进环境块里）。
 */
const BLOCK_ID_BY_HEADING: ReadonlyMap<string, PromptBlockId> = new Map<string, PromptBlockId>([
  ...PROMPT_SECTIONS.map((id): readonly [string, PromptBlockId] => [sectionHeading(id), id]),
  [ENVIRONMENT_HEADING, ENVIRONMENT_BLOCK_ID],
  [PROJECT_RULES_HEADING, PROJECT_RULES_BLOCK_ID],
  [SKILLS_HEADING, SKILLS_BLOCK_ID],
])

/**
 * 产物 → 块（**段边界读取**）——`buildSystemPrompt` 之逆：按已知标题切分。
 *
 * 首块标题之前的散行被丢弃（正常装配下不存在——产物以首段标题开头）；
 * 块正文去掉尾随空行，故 `splitSystemPrompt(buildSystemPrompt(vars))` 与 `buildPromptBlocks(vars)` 逐块相符。
 */
export function splitSystemPrompt(prompt: string): readonly PromptBlock[] {
  const blocks: PromptBlock[] = []
  let open: { id: PromptBlockId; heading: string; lines: string[] } | undefined

  const flush = (): void => {
    if (open === undefined) return

    const lines = open.lines
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    const body = lines.join('\n')
    blocks.push({ id: open.id, heading: open.heading, body, text: `${open.heading}\n${body}` })
    open = undefined
  }

  for (const line of prompt.split('\n')) {
    const id = BLOCK_ID_BY_HEADING.get(line)
    if (id === undefined) {
      open?.lines.push(line) // 无主散行（首个标题之前）自然丢弃
      continue
    }

    flush()
    open = { id, heading: line, lines: [] }
  }

  flush()
  return blocks
}
