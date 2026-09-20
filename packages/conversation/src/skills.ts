/**
 * 技能送达 —— **什么时候把哪一份送进上下文**（U33 · 对话域这一半）。
 *
 * 上游是执行域的 `Skills`（有什么、在哪儿、读到的是什么）；本文件持有的是**两处**：
 *
 * 1. **目录（只有名称与描述）**——每次模型调用之前接进系统提示词。与项目规约的送达同法：
 *    **现取现接**（改过的技能下一趟就是新的），且**只有元数据**——「未选中的正文不进上下文」
 *    是设计要的行为，不是优化。
 * 2. **主文（按需）**——到真实提交那一刻才取（显式选定），或由模型经受限入口取（自主选用）。
 *
 * ## 两条选用路径，一份材料
 *
 * | 谁选的 | 何时取 | 材料从哪里进上下文 |
 * | --- | --- | --- |
 * | 用户（显式绑定草稿） | 提交出队那一刻 | **随这条交代**：作为 `user` 条目的载荷落账 |
 * | 模型（按描述自主选用） | 它调 `skill` 工具那一刻 | **一次工具往返**：工具结果落账 |
 *
 * 两路的**来源身份是同一种**（名称 ＋ 真路径 ＋ 人读标签），故「已使用的材料」在两处说得一样。
 * 而**技能说明与工具读回来的数据保持不同来源身份**（工单明写）：前者是这次交代的一部分
 * （`user` 条目载荷），后者是**工具域的结果**（`tool-result` 条目）——重放时两条路各自复原，
 * 不会把「技能里写的」当成「读出来的事实」。
 *
 * ## 取不到就是取不到
 *
 * 显式选定的技能读不出来时，**这一次交代不跑**（见 `agent-loop.ts` 的 `rejected`）：
 * 不换同名项、不忽略技能继续。理由在工单上写着——「我让你用这份技能做这件事」是用户的
 * 明确交代，内核不能替他把这句话删掉一半，也不能拿另一份同名技能顶上去冒充。
 */

import type { SkillRead, SkillRef, Skills, UsedSkillEntry } from '@magic/contracts'
import { withSkillsCatalog } from './prompt/skills.ts'

/** 一次技能送达——本对象**不存状态**（目录每次现扫、主文每次现读，同执行域那一条）。 */
export type SkillsDelivery = {
  /** 一次模型调用前：把当前技能目录（**只有名称与描述**）接上系统提示词。 */
  readonly promptFor: (base: string) => string
  /**
   * 按选定身份取主文——**按绑定时序**，逐个取。
   *
   * 一个取不到就整条失败：材料是**成套**的，送半套等于把用户的话执行了一半。
   */
  readonly load: (refs: readonly SkillRef[]) => SkillLoad
}

/** 取主文的结果——判别式（失败位借 `SkillRead` 的措辞：指得出是谁、为什么）。 */
export type SkillLoad =
  | { readonly ok: true; readonly used: readonly UsedSkillEntry[] }
  | { readonly ok: false; readonly reason: string }

/** 造一份技能送达（`skills` 端口由装配给——它是执行域的实现）。 */
export function createSkillsDelivery(skills: Skills): SkillsDelivery {
  return {
    promptFor: (base: string): string => withSkillsCatalog(base, skills.discover()),

    load: (refs: readonly SkillRef[]): SkillLoad => {
      const used: UsedSkillEntry[] = []

      for (const ref of refs) {
        const read: SkillRead = skills.readMain(ref.name, ref.path)
        if (!read.ok) return { ok: false, reason: read.reason }

        used.push({
          name: read.material.skill.name,
          source: read.material.skill.path,
          label: read.material.skill.label,
          // 正文**随条目落账**（不是引用）——见契约 `UsedSkillEntry`：只记身份的话，
          // 源文件一改，当时送出去的那一份就再也取不回来了
          text: read.material.text,
        })
      }

      return { ok: true, used }
    },
  }
}
