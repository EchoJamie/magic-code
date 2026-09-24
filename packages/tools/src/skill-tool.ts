/**
 * `skill` —— **受限的技能读取入口**（U33）：模型按描述自主选用那一半。
 *
 * 一个工具，不是每个技能各注册一个（工单明写）。两形：
 *
 * | 参数 | 取的 |
 * | --- | --- |
 * | `{ name }` | 该技能的**主文**（`SKILL.md` 正文） |
 * | `{ name, relative }` | 它**来源内**的一份引用（`references/x.md`…） |
 *
 * ## 边界：只按已发现身份 ＋ 来源内的相对引用读
 *
 * 两件都不是在**这里**判的——它们是执行域 `Skills` 端口唯一的两个入口
 * （`readMain` / `readReference`），本工具只是把模型的话转成那两次调用：
 * - **身份**（名称 ＋ 技能目录真路径）——找不到那一对就是不认（改名 / 删除 / 换了来源），
 *   **不退回同名项**；
 * - **来源内**——绝对路径与 `..` 越出在那边就被拒（它还会 `realpath` 一次，
 *   挡住「目录里放个软链接指到外面」）。
 *
 * 本域**不碰文件系统**（内核仅 records / execution 两处 fs 直触），故这个工具走的
 * **不是沙箱**，是那个端口——这也是它**没有**落在「工具集 v1 七件」里的原因：
 * 那七件都是对工作区的动作，这一件读的是**只读材料**（技能目录），与 `ProjectRules`
 * 同一处境（能读到，不等于能对它执行工具）。
 *
 * ## 权限
 *
 * `danger: light` 只声明了「这一类动作的方向」；**真正的判定在权限域**
 * （`analyze.ts` 的 `skill` 那一条）——不在这儿，也不靠 `ToolSpec` 一个字段说了算。
 *
 * ## 同名怎么办：**没有这个问题了**（2026-09-25 收）
 *
 * 曾经这里有一个 `source` 参数：名字不唯一时**不静默挑一个**，回填里列出各来源的目录，
 * 让模型带 `source` 再要一次。那个参数随「**同名只留一条**」一起收掉——
 * 同名在**发现那一层**就只剩一份了（项目级 ＞ 用户级、`.magic` ＞ `.agents`，
 * 同档按目录名字典序取第一个，见 `@magic/execution` 的 `skills.ts`），
 * 于是「名字 → 哪一份」是一个**单值**：名字本身就是完整的地址，没有第二件要说的事。
 *
 * ⚠️ **不是把那个判定挪走，是它成立的前提没了**：收掉 `source` 之后，这里**不保留**
 * 任何「名字不唯一」的分支——一份判定留在那儿当死代码，比没有更坏（读的人会以为它活着）。
 * 真出现同名的目录（桩、或将来别处喂进来的清单），取的是**次序里靠前的那一份**：
 * 那正是发现层的规则，此处不另立一套。
 *
 * ⚠️ 连带的一处：`analyze.ts` 的 `skill` 那一格原先拿模型给的 `source` 算**影响面落点**
 * （规则轴比对）。参数没了，落点就没有来处——那一格同步收窄成「只按名字取」，
 * 不再假装知道模型指了哪儿。读的边界本来也不由它担保（见上「边界」）。
 */

import type { Skill, SkillMaterial, SkillRead, Skills, UsedSkill } from '@magic/contracts'
import { isText } from './args.ts'
import type { ToolDefinition, ToolRunResult } from './registry.ts'
import { refused } from './toolkit.ts'

/**
 * 参数模式——**键名锚定在本文件**（`name` / `relative`）。
 *
 * 不放进契约的「参数键全表」：那张表管的是**工具集 v1 七件**（阶段 2 冻结的公开词表），
 * 而这一件是**本单元按需长出来的一件**，键名与语义都在这里。
 *
 * `description` 是给模型读的说明书——两个键各答一个问题：要哪个技能 · 取哪一份文件。
 * **一个名字一份技能**（同名在发现那一层就收成一条了，见文件头注），故不需要第三个键
 * 去指「哪一份来源」。
 */
export const SKILL_PARAMETERS = {
  type: 'object',
  description:
    '取一份技能的正文或它引用的文件。给 name 取主文；再给 relative（相对技能目录，' +
    '如 references/x.md）取那份引用。技能清单在系统提示词的「可用技能」一节里。',
  properties: {
    name: {
      type: 'string',
      description: '技能名称——取系统提示词「可用技能」一节里列的那个名字',
    },
    relative: {
      type: 'string',
      description: '技能目录内的相对路径（如 references/x.md）——不给就取主文 SKILL.md',
    },
  },
  required: ['name'],
  additionalProperties: false,
} as const

/** 抬头的两种写法——见 `compose`。 */
const MAIN_HEADING = '技能主文'
const REFERENCE_HEADING = '技能引用'

/**
 * 造 `skill` 的工具定义。
 *
 * `skills` 是**同一个来源口**（与对话域那一半同源，见 `ConversationDeps.skills` 的注）：
 * 两条选用路径读的是同一份「有什么、在哪儿」。
 */
export function defineSkillTool(skills: Skills): ToolDefinition {
  return {
    spec: {
      name: 'skill',
      summary: '取技能正文或其引用的文件（只读技能目录）',
      parameters: SKILL_PARAMETERS,
      // 声明的是**方向**（只读材料）；判定归权限域（`analyze.ts`）
      danger: { level: 'light' },
    },

    run(args): ToolRunResult {
      const name = args['name']
      if (!isText(name)) return refused('参数错误：name 须为非空字符串')

      const relative = args['relative']
      if (relative !== undefined && !isText(relative)) {
        return refused('参数错误：relative 须为非空字符串（不给就取主文）')
      }

      // 身份由**这一趟的发现结果**给（名字 → 那一份的真路径）；没有这个名字就照实说
      const target = resolve(skills, name)
      if (typeof target === 'string') return refused(target)

      const read: SkillRead =
        relative === undefined
          ? skills.readMain(target.name, target.path)
          : skills.readReference(target.name, target.path, relative)

      if (!read.ok) return refused(read.reason)

      return {
        ok: true,
        output: compose(read.material, relative),
        // **交付身份**（U33）——**只有主文那一趟带**：引用是「同一项技能里的另一份文件」，
        // 再报一次整项技能就是重复（契约 `ToolResult.skill`）
        ...(relative === undefined ? { skill: usedOf(read.material.skill) } : {}),
      }
    },
  }
}

/**
 * 归位结果——要么是一处技能（名字 ＋ 真路径），要么是一句给模型的回填。
 *
 * **两种结果**：取到了 / 没有这个名。曾经还有第三种（同名多个 ⇒ 报出各处让模型指明），
 * 随 `source` 参数一起收掉——同名在发现那一层只剩一条（见文件头注），
 * 这里也就只剩「有 / 没有」。**不保留那条判定当死代码**：真出现同名的清单，
 * 取的是**靠前那一份**（发现层的次序），此处不另立一套。
 */
function resolve(
  skills: Skills,
  name: string,
): { readonly name: string; readonly path: string } | string {
  // **一次发现，两处用**（挑与报）——现扫本就是每次调用的代价，别为了报错再扫一遍
  const catalog = skills.discover().skills
  const found = catalog.find((skill) => skill.name === name)
  if (found !== undefined) return { name, path: found.path }

  const known = [...new Set(catalog.map((skill) => skill.name))]

  return known.length === 0
    ? `没有「${name}」这个技能——这台机器上这次一个技能都没发现（技能清单见系统提示词的「可用技能」一节）`
    : `没有「${name}」这个技能。可用的有：${known.join(' · ')}`
}

/**
 * 材料 → 面向模型的文本——**抬头说清这是哪一份**。
 *
 * 抬头两件的用处与上下文里那份同源（`context.ts` 的 `skillsBlockOf`）：名字让模型知道
 * 手上是什么，来源让同名分得开。**技能说明与读出来的数据是两种东西**（工单明写）：
 * 这两个抬头就是那条分界线——工具读回来的这一份**也算「技能里写的」**，
 * 不是模型自己查出来的事实（工作区里的 `read` 才是）。
 *
 * ⚠️ 抬头是**给人（与模型）读的**，不是协议：交付身份走 `ToolResult.skill` 那一位。
 * 谁要认「这一趟读的是哪个技能」，读那一位，**不要来抠这一行字**。
 */
function compose(material: SkillMaterial, relative: string | undefined): string {
  const { skill, text } = material
  const what = relative === undefined ? MAIN_HEADING : `${REFERENCE_HEADING} ${relative}`
  const which = relative === undefined ? skill.name : `${skill.name} 的`

  return `〔${what}：${which}（来源 ${skill.path}）〕\n${text}`
}

/** 材料 → 交付身份（契约 `UsedSkill` 的三件）——标签取发现结果上那一个（见其注）。 */
function usedOf(skill: Skill): UsedSkill {
  return { name: skill.name, source: skill.path, label: skill.label }
}
