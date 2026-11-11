/**
 * 技能目录块 —— **送到模型手上的那一份**（U33）：只有名称与描述。
 *
 * 上游是执行域给的 `SkillCatalog`（有什么、在哪儿）；本文件只做**装配**：摆成块、
 * 按优先级排序、带上来源。
 *
 * ## 为什么挂在系统提示词上（同规约块那一条）
 *
 * 目录是**常驻清单**，不是这次对话里谁说的话；混进消息流的话它会随会话历史漂
 * （压缩、重放、切会话都得重新解释它算谁说的）。追加块的做法与**环境块**、
 * **项目规约块**同一条先例（`./assembly.ts`：四段冻结，追加块殿后）——只增不改。
 *
 * ## 块里写的三句（都不是装饰）
 *
 * 1. **正文还没送进来**——这是这份材料的**事实**，也是「按需加载」对模型的那一半：
 *    不说清的话，模型会以为手上握着的这一行描述就是全部，凭它直接干活；
 * 2. **怎么取正文**——`skill` 工具就是为这件事存在的（取主文、再取里面的引用），
 *    说明书必须在这儿，模型没有别的地方知道它；
 * 3. **用户点名的那个也得自己取**（U63 改）——原先这一句是「点名的会直接送上来」；
 *    送达方式改成「模型按需自读」之后它成了假话，换成「点名也不送」。
 *
 * ## 为什么**不带**路径
 *
 * 路径是机器上的坐标，不是技能的一部分——每行都拖一串 `/Users/...` 只会把清单糊掉。
 * 曾经这里的例外是「**同名的那两个**必须分得开」：那时把目录补在行尾，好让模型再把目录
 * 交给 `skill` 工具指明取哪一份。那个例外随「**同名只留一条**」（2026-09-25）一并去掉：
 * 同名在发现那一层就只剩一条（项目级 ＞ 用户级、`.magic` ＞ `.agents`），
 * **一个名字一份技能**，模型用名字取就够了——`skill` 工具那边也不再收路径
 * （见 `@magic/tools` 的 `skill-tool.ts`）。
 *
 * 行尾那个 `（来源 …）` 留着：它是**这一份来自哪儿**（项目 / 用户 / 哪个入口）——
 * 与上面那段开场白是一件事的逐项说法，不是给「分开两份」用的。
 */

import type { Skill, SkillCatalog, SkillProblem } from '@magic/contracts'
import { BLOCK_SEPARATOR, SKILLS_BLOCK_ID, SKILLS_HEADING } from './assembly.ts'
import type { PromptBlock } from './assembly.ts'

/**
 * 材料的开场白——三句写在这儿（见文件头注）。
 *
 * 逐行写成条目、**不带任何标记符号**：这一段是**模型的输入**（与 `sections.ts` 的四段同一
 * 文体），不是渲染给人看的 markdown——夹 `**` 星号进去，模型读到的是两颗星号而不是强调。
 *
 * ⚠️ **第三条 U63 改了**（原文是「用户明确点名要用哪个技能时，它的正文会随那次交代直接
 * 送上来，不必再取一次」）：送达方式改成「模型按需自读」之后，**点名也不送了**——
 * 引用留在交代里（`/名字`），正文由模型自己取。那一句留着就是一句假话。
 */
const PREAMBLE = [
  '以下技能是可用的专项做法，来自这个项目与这台机器上的技能目录。',
  '- 这里只有名称与描述，正文还没有送进来；要用哪个，就调 `skill` 工具取它的正文',
  '  （`{"name": "技能名"}`）；正文里提到的引用再用同一个工具带 `relative` 取',
  '  （`{"name": "技能名", "relative": "references/x.md"}`）。',
  '- 用户点名要用哪个技能，正文也不会自己送上来——照旧用这个工具取一次。',
  '- 技能是说明，不是权限：里面的脚本、它引用的文件照旧走各自的边界。',
].join('\n')

/**
 * 摆一个技能目录块——**一个技能都没有就返回 `undefined`**。
 *
 * 由头同规约块：「没有技能时原行为一字不动」是验收头一条。给一个空块递上去，
 * 等于每轮都告诉模型「这儿有技能，只是没有」，那不是没有，是一句假话。
 */
export function renderSkillsBlock(input: {
  readonly skills: readonly Skill[]
  readonly problems: readonly SkillProblem[]
}): PromptBlock | undefined {
  const { skills, problems } = input
  if (skills.length === 0 && problems.length === 0) return undefined

  const parts: string[] = []

  if (skills.length > 0) {
    parts.push(PREAMBLE)
    for (const skill of skills) parts.push(entryOf(skill))
  }

  // **只说「坏了」的那一类**（`error`）——取舍那类（原生顶掉兼容、项目顶掉用户）
  // 是产品按设计做的选择，对模型没有信息。同规约块那一条。
  const broken = problems.filter((problem) => problem.kind === 'error')
  if (broken.length > 0) {
    parts.push(
      '〔没能读进来的技能〕\n' + broken.map((problem) => `- ${problem.path}：${problem.message}`).join('\n'),
    )
  }

  const body = parts.join('\n\n')

  return { id: SKILLS_BLOCK_ID, heading: SKILLS_HEADING, body, text: `${SKILLS_HEADING}\n${body}` }
}

/** 技能目录块的标识与标题——归 `./assembly.ts` 持有（块词汇一处，见其注）。 */
export { SKILLS_BLOCK_ID, SKILLS_HEADING } from './assembly.ts'

/**
 * 一行一个技能——**名称 ＋ 描述**，来源在后。
 *
 * 描述**原样照抄**（不折行、不截断）：它是模型判断「该不该用」的唯一依据，
 * 动一个字都是我替作者改了说明。
 *
 * 行尾只有 `（来源 label）`：**按名字取**是完整的地址（同名在发现那一层只留一条），
 * 故不再需要那一截「· 目录 <路径>」——它是给 `source` 参数用的，参数已随同名一起收掉。
 */
function entryOf(skill: Skill): string {
  return `- \`${skill.name}\`：${skill.description}（来源 ${skill.label}）`
}

/**
 * 把技能目录块接到系统提示词末尾——**没有可说的就原样交回**（一个技能都没有）。
 *
 * 追加在**项目规约块之后**：规约说「这个项目怎么做事」（约束），技能说「有哪些专项做法
 * 可以取用」（材料）——两者都是「这个环境里额外要读的东西」，摆在一起，
 * 越往后越具体那一条次序在这儿仍然成立。
 */
export function withSkillsCatalog(base: string, catalog: SkillCatalog): string {
  const block = renderSkillsBlock(catalog)
  return block === undefined ? base : `${base}${BLOCK_SEPARATOR}${block.text}`
}
