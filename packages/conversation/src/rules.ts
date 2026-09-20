/**
 * 规约送达 —— **什么时候把哪几条送进上下文**（U32 · 对话域这一半）。
 *
 * 上游是执行域的 `ProjectRules`（有什么、在哪儿、是哪一版）；本文件持有的是**会话内**的
 * 两样记账，加上「工具产生副作用之前」这道闸：
 *
 * - **作用域**（`targets`）——本会话**接触过的**目标路径，累积、去重。会话开局是空的
 *   （只取各根一级），每碰一处就长一点。用途有二：决定**送哪些**（近目录约定只细化其子树），
 *   以及决定**改过之后算不算新**（一次请求里带的内容，下一趟重读时不因「它变了」而反复拦截）。
 * - **已送达**（`delivered`）——进过至少一次请求的那些**内容版本**。判据是版本不是路径：
 *   用户改了规约 ⇒ 另算一版 ⇒ 该重送一次；同一版送过就不再拦。这正是「相同版本不循环拦截」。
 *
 * ## 为什么由对话域持有这两样
 *
 * 「这一轮在动哪儿」只有主循环知道（它拿到的是模型的工具调用），而「送进上下文」也只有它
 * 能做（上下文由条目与系统提示词装配，那是本域的事）。执行域只管读盘，它不该知道谁在跑。
 *
 * ## 送达发生在两处（顺序即语义）
 *
 * 1. **每次模型调用之前**（`promptFor`）——把**当前作用域**里适用的规约接进系统提示词，
 *    并记下这一趟送出去的版本。这是「无路径规则首次模型调用前载入」与「条件规则在目标
 *    相关时送达」共同的落点：作用域里没有的目标，压根不在这一趟的名单上。
 * 2. **一批工具执行之前**（`preflight`）——拿这批调用的目标再查一遍：**有没送达过的新内容
 *    就拦下整批**（回填「需重审」，见 `needsReviewText`），让它下一趟随请求送进去。
 *    **第一次副作用因此没有发生**——拦在 `invoke` 之前，沙箱与闸门都还没被碰到。
 *
 * 拦截**只在新内容上发生**：送达过同一版就照常执行，模型重提的那一次因此只会执行一次
 * （「重审后仅执行一次」）。
 */

import type { ProjectRule, ProjectRules, ToolCall } from '@magic/contracts'
import { withProjectRules } from './prompt/rules.ts'

/**
 * 一次会话的规约送达。
 *
 * 有状态、**按会话各一份**（装配在 `createConversationSession` 里造）——切了会话就是另
 * 一本账：那一头碰过哪些目录、送过哪几版，与这一头无关。
 */
export type RulesDelivery = {
  /** 一次模型调用前：把当前作用域的规约接上，并记下送出去的版本。 */
  readonly promptFor: (base: string) => string
  /**
   * 一批工具执行前：**有没送达过的新规约就返回它们**（非空＝这一批一份都不许执行）。
   * 顺带把这批的目标**并入作用域**——无论拦不拦，下一趟请求都要带上它们。
   */
  readonly preflight: (calls: readonly ToolCall[]) => readonly ProjectRule[]
}

/**
 * 作用域的**条数上限**——**先进先出**。
 *
 * 「不要递归把整仓规约都塞进每次调用」这条纪律，靠两道拦：一道是**只送碰过的**
 * （此处的累积），另一道是**送过的不能无限攒**（这个数）。一个长会话在仓库里挪上几百个
 * 文件之后，早年的目标既不再相关、又每趟都要重新走一遍祖先目录——留着就是纯成本。
 *
 * **落在上限之外不是「丢了」**：会话回头再碰那个目录，它照旧被收回来、那几份规约照旧在
 * 下一趟请求里（`delivered` 记着版本，故**不会**为此再拦一次）——只是中间那几趟不在上下文里。
 */
export const MAX_SCOPE_TARGETS = 64

/** 造一份送达账（一条会话一份）。 */
export function createRulesDelivery(rules: ProjectRules): RulesDelivery {
  /** 本会话接触过的目标（累积、去重、按接触序）。 */
  const targets: string[] = []
  /** 去重面——与 `targets` 同生共死（出队时一并删）。 */
  const known = new Set<string>()
  /** 进过至少一次请求的内容版本。 */
  const delivered = new Set<string>()

  const absorb = (fresh: readonly string[]): void => {
    for (const target of fresh) {
      if (known.has(target)) continue
      known.add(target)
      targets.push(target)
    }

    while (targets.length > MAX_SCOPE_TARGETS) {
      const dropped = targets.shift()
      if (dropped !== undefined) known.delete(dropped)
    }
  }

  return {
    promptFor: (base: string): string => {
      const load = rules.load(targets)
      for (const document of load.documents) delivered.add(document.version)

      return withProjectRules(base, load)
    },

    preflight: (calls: readonly ToolCall[]): readonly ProjectRule[] => {
      // 没有新目标也照查一遍：**规约可能刚被改过**（改版＝新版本＝该重送一次）。
      // 这一趟是幂等的——送达过就什么都不返回，故不产生多余的拦截。
      absorb(calls.flatMap(targetsOf))

      return rules.load(targets).documents.filter((document) => !delivered.has(document.version))
    },
  }
}

/**
 * 一次工具调用**静态可推**的目标路径。
 *
 * 工具集 v1 的参数键是**契约冻结**的（`ports.ts` · 参数键全表）：`read` / `write` / `edit`
 * 按 `path`；`grep` / `glob` / `ls` 的 `path` 可选（缺省＝默认根——那一层在会话开局就送达了，
 * 故缺席不必另补）。键名不带方言，取不到就该没有。
 *
 * ⚠️ **`exec` 不在其列，这是有意为之的限度**：它只收 `cmd`，而任意 shell 字符串实际会碰
 * 哪些文件**静态推不出来**（`cd src && ./build.sh` 就是现成的反例）。故它的范围按**执行 cwd**
 * （＝工作区默认根）算——那几条根一级的规约在会话开局就已经在上下文里了。
 * **不假装推得出来**，是本版对这件事的诚实处置（设计 · 项目规约第 4 条明写）。
 */
function targetsOf(call: ToolCall): readonly string[] {
  const path = call.args['path']
  return typeof path === 'string' && path.trim() !== '' ? [path] : []
}

/**
 * 被拦下那一次调用的回填文本——**说清三件**：没执行 · 为什么 · 接下来怎么办。
 *
 * 不这么写，模型会以为工具坏了（或者以为写完了）；而这一批**确实一次都没执行**，
 * 回填必须让「重提一次」成为显然的下一步。
 */
export function needsReviewText(blocking: readonly ProjectRule[]): string {
  const names = blocking.map((rule) => rule.name).join(' · ')

  return (
    `未执行——这个目标上刚发现新的项目规约（${names}），已送入上下文。` +
    `请照新规约复核这次调用，然后重新提出；这一次没有任何副作用发生。`
  )
}
