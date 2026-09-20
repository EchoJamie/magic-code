/**
 * 项目规约块 —— **送到模型手上的那一份**（U32）。
 *
 * 上游是执行域给的 `RulesLoad`（有什么、在哪儿、是哪一版）；本文件只做**装配**：
 * 摆成块、按次序、带上来源，并把几条**边界**写在材料里（这是材料该说的话，不是实现细节）。
 *
 * **为什么挂在系统提示词上（而不是另起一条用户消息）**：规约是**常驻指令**，不是这次对话
 * 里谁说的话；混进消息流的话，它会随会话历史漂（压缩、重放、切会话都得重新解释它算谁说的）。
 * 追加块的做法与**环境块**同一条先例（`./assembly.ts`：四段冻结，环境以追加块殿后）——
 * 只增不改，段结构那一行一个字没动。
 *
 * **块里写的三句边界**（都不是装饰）：
 * 1. **用户本次的明确交代优先**——产品口径（设计 · 项目规约第 3 条）。规约是项目维护者
 *    早先写下的，用户此刻说的话才是这一轮的意图；
 * 2. **规约不能授权路径 / 进程 / 网络**——它们是**只读材料**：不修改 `permissions.rules`、
 *    不运行其中脚本、不接 hooks。写进材料，模型才不会把「规约里写着可以删 build/」当成许可。
 * 3. **没进来的那些照报**——「读失败或超限须明确说哪份未加载，不能静默截掉关键约定后
 *    宣称已生效」（设计 · 项目规约第 6 条）。这是这份材料的**诚实条款**。
 *
 * ## 每一条都带**范围**（2026-09-20 裁）
 *
 * 首轮的材料只有「抬头名 ＋ 正文」——`paths:` 被摘掉之后，一条 `src/**` 的规则看上去
 * 与一条全局规则**一模一样**。模型据此拿它去管别处的文件，而它本该只管 `src`。
 * 故每一条都写上**所属根 · 管到哪儿 · 什么条件下适用**（见 `entryOf`）：
 * 材料要自足，不能让模型靠文件名猜范围。
 */

import type { ProjectRule, RulesLoad, RulesProblem } from '@magic/contracts'
import {
  BLOCK_SEPARATOR,
  PROJECT_RULES_BLOCK_ID,
  PROJECT_RULES_HEADING,
} from './assembly.ts'
import type { PromptBlock } from './assembly.ts'

/**
 * 材料的开场白——三句边界写在这儿（见文件头注）。
 *
 * 逐行写成条目、**不带任何标记符号**：这一段是**模型的输入**（与 `sections.ts` 的四段同一种
 * 文体），不是渲染给人看的 markdown——夹 `**` 星号进去，模型读到的是两颗星号而不是强调。
 */
const PREAMBLE = [
  '以下内容来自这个项目的规约文件（目录里的 AGENTS.md 或 CLAUDE.md，以及 .magic/rules、',
  '.claude/rules 下的规则），由项目维护者在仓库里维护。',
  '- 用户本次的明确交代优先于它们；两者冲突时按用户此刻说的办。',
  '- 它们不能授权任何路径、进程或网络操作——那由权限闸门管。',
].join('\n')

/**
 * 摆一个项目规约块——**没有可说的就返回 `undefined`**（一条规约都没有、也没出过问题）。
 *
 * 由头：「无规约时原行为一字不动」是验收头一条。给一个空块递上去，等于每轮都告诉模型
 * 「这个项目有份规约，只是内容是空的」——那不是没有，是一句假话。
 */
export function renderProjectRulesBlock(input: {
  readonly documents: readonly ProjectRule[]
  readonly problems: readonly RulesProblem[]
}): PromptBlock | undefined {
  const { documents, problems } = input
  if (documents.length === 0 && problems.length === 0) return undefined

  const parts: string[] = []

  if (documents.length > 0) {
    parts.push(PREAMBLE)
    for (const rule of documents) parts.push(entryOf(rule))
  }

  // **只说「坏了」的那一类**（`error`）——取舍那类（原生顶掉兼容、AGENTS 顶掉 CLAUDE）
  // 是**产品按设计做的选择**，对模型没有信息：它不需要知道「另有一份没生效的规则」。
  // 说给模型听，只会让它去猜那份没生效的写了什么。那类归 `--check` 与启动回执说给用户。
  const broken = problems.filter((problem) => problem.kind === 'error')
  if (broken.length > 0) {
    parts.push(
      '〔没能加载的规约〕\n' +
        broken.map((problem) => `- ${problem.path}：${problem.message}`).join('\n'),
    )
  }

  const body = parts.join('\n\n')

  return {
    id: PROJECT_RULES_BLOCK_ID,
    heading: PROJECT_RULES_HEADING,
    body,
    text: `${PROJECT_RULES_HEADING}\n${body}`,
  }
}

/** 项目规约块的标识与标题——归 `./assembly.ts` 持有（块词汇一处，见其注）。 */
export { PROJECT_RULES_BLOCK_ID, PROJECT_RULES_HEADING } from './assembly.ts'

/**
 * 一条规约的摆法——**抬头说清「这条管到哪儿」，正文原样跟在后面**。
 *
 * **抬头三样，各答一个问题**（2026-09-20 裁；首轮只报了名字，范围全丢）：
 *
 * - **哪一个项目**（`根 <绝对路径>`）——多根下这句话就是「甲根的规范不作乙根的全局规范」
 *   在材料上的落点。**单根也照报**：模型据此把「这条规约」与它手上的那个工作目录对上，
 *   不必靠猜；不报的话，多根与单根的材料形态还会不一样，模型两边都得适应。
 * - **管到哪儿**（`范围`）——目录规约管它那棵子树（`src` 那份只管 `src/**`）；
 *   规则文档按根算（`paths` 管的就是这个）。
 * - **什么条件下适用**（`paths`）——**有 `paths` 才写这一句**：它是「当前请求里为什么会有
 *   这一条」的答案。没写的＝无条件（会话开局就该在的）。
 *
 * 取舍：`scope` 与 `root` 相同时（规则文档、根一级的目录规约）**不重复报范围**——
 * 「根就是它管的地方」这一句在抬头里已经说完了，再写一遍是同义反复。
 */
function entryOf(rule: ProjectRule): string {
  const where: string[] = []
  if (rule.root !== null) where.push(`根 ${rule.root}`)
  if (rule.scope !== null && rule.scope !== rule.root) where.push(`管 ${rule.scope}`)
  if (rule.paths.length > 0) where.push(`只在 ${rule.paths.join('、')} 上适用`)

  const head = where.length === 0 ? '' : `（${where.join(' · ')}）`

  return `〔${rule.name}${head}〕\n${rule.text}`
}

/**
 * 把规约块接到系统提示词末尾——**没有可说的就原样交回**（`load` 缺席 / 空块两种情况）。
 *
 * 追加在**环境块之后**：环境说的是「这是台什么机器」，规约说的是「这个项目怎么做事」——
 * 越往后越具体，模型读到最后一条时手上已经握着全部语境。
 */
export function withProjectRules(base: string, load: RulesLoad | undefined): string {
  if (load === undefined) return base

  const block = renderProjectRulesBlock(load)
  return block === undefined ? base : `${base}${BLOCK_SEPARATOR}${block.text}`
}
