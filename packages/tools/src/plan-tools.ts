/** 计划投影与历史读取；事项写入由 memory_update 负责。 */

import type {
  HistoryEntry,
  HistoryPage,
  HistoryQuery,
  PlanNote,
  PlanReader,
  PlanSnapshot,
  PlanStep,
} from '@magic/contracts'
import { defineTool } from './registry.ts'
import type { ToolDefinition, ToolRunResult } from './registry.ts'
import { refused, reasonOf } from './toolkit.ts'

/**
 * 两个读工具名字——**归属明确**（装配按它追加放行规则、权限域按它认这三格）。
 *
 * 挂在工具定义旁边而不是散在各处：改名时改一处就够（另一处漏了，放行规则会静默失效，
 * 而那正是「每次都弹卡」或「悄悄免审」两头之一）。
 */
export const PLAN_READ_TOOL = 'plan_read'
export const HISTORY_READ_TOOL = 'history_read'

/** 两个读工具名字齐——装配与权限域共用的一处清单。 */
export const PLAN_TOOL_NAMES: readonly string[] = [
  PLAN_READ_TOOL,
  HISTORY_READ_TOOL,
]

// ══ 参数模式 ══════════════════════════════════════════════════════════

export const PLAN_READ_PARAMETERS = {
  type: 'object',
  description: '取当前会话的计划笔记（目标、步骤清单与辅助笔记）。没有建立过就如实说没有。',
  properties: {},
  required: [],
  additionalProperties: false,
} as const

export const HISTORY_READ_PARAMETERS = {
  type: 'object',
  description:
    '读当前会话的一段实际记录（用户交代、助手答复、工具调用与结果）。' +
    '不给参数就从当前上下文之前最近的一页读起；按返回的位置可以继续往前翻。',
  properties: {
    before: {
      type: 'number',
      description: '从这一条记录往前翻（取它之前的记录）——填上次返回的 nextBefore',
    },
    entry: {
      type: 'number',
      description: '看一条已知记录（按记录号）——长内容接着用 offset 续读',
    },
    offset: {
      type: 'number',
      description: '配合 entry：从这条内容的第几个字符接着读（从 0 起）',
    },
  },
  required: [],
  additionalProperties: false,
} as const

// ══ 成文 ══════════════════════════════════════════════════════════════

/** 三格状态的中文——给人（与模型）读的那一份。 */
const STATUS_LABEL: Readonly<Record<PlanStep['status'], string>> = {
  pending: '未开始',
  in_progress: '进行中',
  completed: '已完成',
}

/**
 * 计划内容摆成文本——**读与写共用一处**（两处各写一遍，改一处漏一处）。
 *
 * 空的两处**如实说空**，不留一行空白让读的人猜「是不是没抄全」：
 * 没有步骤就说「（还没有步骤）」，**没有目标 / 笔记就不占一行**。
 *
 * 次序与界面**同一份**（U90）：目标在先（清单上那一行顶格）、步骤在后。
 */
export function planTextOf(plan: PlanNote): string {
  const lines: string[] = []

  if (plan.goal !== undefined) lines.push(`目标：${plan.goal}`)
  lines.push('步骤：')

  if (plan.steps.length === 0) lines.push('（还没有步骤）')
  else plan.steps.forEach((step, index) => lines.push(`${index + 1}. [${STATUS_LABEL[step.status]}] ${step.text}`))

  if (plan.notes.trim() !== '') lines.push(`笔记：${plan.notes}`)
  return lines.join('\n')
}

/** 没建立过计划时的回执——**如实说没有**，不编一份空的。 */
const NO_PLAN = '这个会话还没有计划笔记。需要时用 memory_update 增量维护目标与步骤事项。'

/**
 * 读的回执（`plan_read`）。
 *
 * ⚠️ **读的回执里必须有完整正文**：上下文装配据「这一条结果是不是完整落在窗口里」
 * 判「模型手上有没有最新计划」（`@magic/conversation` · `context.ts` 的计划材料）。
 * 少了正文，模型在压缩之后就真的什么都没有了。
 */
function readReceipt(snapshot: PlanSnapshot): string {
  if (snapshot.entry === null) return NO_PLAN
  if (snapshot.plan === null) {
    return `当前计划笔记已清空（清空记在记录 #${snapshot.entry}）。过程仍在会话记录里，可用 history_read 回查。`
  }

  return `当前计划笔记（记录 #${snapshot.entry}）：\n${planTextOf(snapshot.plan)}`
}

/**
 * 历史的回执（`history_read`）——一段记录 ＋ 继续往前的位置 ＋（有则）一句说明。
 *
 * 类别用中文短标签（`【用户】` 一类），与压缩摘要请求里那份铺开的写法**同一套词**
 * （模型在两处见到的是同一种记录，不必学两套）。
 */
function historyReceipt(page: HistoryPage): string {
  const head = page.entries.length === 0 ? '这段没有可读的记录。' : ''
  const body = page.entries
    .map((entry) => `#${entry.id} ${kindLabelOf(entry)}${cutHintOf(entry)}\n${entry.text}`)
    .join('\n\n')

  const lines: string[] = []
  if (head !== '') lines.push(head)
  if (body !== '') lines.push(body)
  if (page.nextBefore !== undefined) {
    lines.push(
      `还有更早的记录——再读一次时带上 before=${page.nextBefore}（要从这里接着往前翻）。`,
    )
  }
  if (page.note !== undefined) lines.push(page.note)

  return lines.join('\n')
}

/**
 * 节选那一条的**续读参数**——`entry` ＋ `offset` **原样写进回执**。
 *
 * 由头（独立验收退回 · 第二条）：域那边本来就给出 `nextOffset`，但回执只写了「节选」——
 * 模型手里只有半条正文，**没有接着读的那两格参数**，只能猜偏移量。标了截断却不说怎么续读，
 * 等于把「这里还有」变成一句没法行动的话。
 *
 * ⚠️ 与页尾那条 `before=` **分工不混**（契约 `HistoryQuery`：两种定位各管各的）：
 * 这一格管**同一条长内容往后读**，页尾那一格管**往前翻页**。
 * `truncated` 与 `nextOffset` 在契约里成对出现；万一只来了一半，退回一句「节选」
 * （不编一个偏移量出来）。
 */
function cutHintOf(entry: HistoryEntry): string {
  if (entry.truncated !== true) return ''
  if (entry.nextOffset === undefined) return '（节选）'

  return `（节选——后面还有，接着读用 entry=${entry.id} offset=${entry.nextOffset}）`
}

/** 记录类别 → 中文短标签（工具结果另标成败——失败那几条正是回查时要找的）。 */
function kindLabelOf(entry: HistoryEntry): string {
  if (entry.kind === 'user') return '【用户】'
  if (entry.kind === 'assistant') return '【助手】'
  if (entry.kind === 'tool-call') return '【工具调用】'
  if (entry.kind === 'tool-result') return '【工具结果】'
  return '【摘要】'
}

// ══ 读面 ═════════════════════════════════════════════════════════════

/**
 * 造计划与历史读取工具。`reader` 是**会话绑定**的（装配按会话各造一份）——故两个工具实例
 * 也按会话各造一份：它们手里的读写范围就是那一条会话，模型给不出第二条。
 */
export function definePlanTools(reader: PlanReader): readonly ToolDefinition[] {
  return [readTool(reader), historyTool(reader)]
}

function readTool(reader: PlanReader): ToolDefinition {
  return defineTool({
    spec: {
      name: PLAN_READ_TOOL,
      summary: '取当前会话的计划笔记（目标、步骤清单与辅助笔记）',
      parameters: PLAN_READ_PARAMETERS,
      danger: { level: 'light' },
    },

    prepare: args => args,
    async run(): Promise<ToolRunResult> {
      try {
        const snapshot = await reader.readPlan()
        return { ok: true, output: readReceipt(snapshot), ...(snapshot.knowledge === undefined ? {} : { knowledge: snapshot.knowledge }) }
      } catch (error) {
        return refused(`计划读取失败：${reasonOf(error)}`)
      }
    },
  })
}

function historyTool(reader: PlanReader): ToolDefinition {
  return defineTool({
    spec: {
      name: HISTORY_READ_TOOL,
      summary: '读当前会话的一段实际记录（默认从当前上下文之前翻起）',
      parameters: HISTORY_READ_PARAMETERS,
      danger: { level: 'light' },
    },

    prepare(args) {
      const query = historyQueryOf(args)
      if (typeof query === 'string') throw new Error(query)
      return { ...query }
    },
    async run(query): Promise<ToolRunResult> {
      try {
        const page = await reader.readHistory(query)
        return { ok: true, output: historyReceipt(page), knowledge: page.entries.flatMap(entry => entry.knowledge ?? []) }
      } catch (error) {
        return refused(`历史读取失败：${reasonOf(error)}`)
      }
    },
  })
}

/** 参数 → 定位（两种定位不混用；错用**说清**而不是静默挑一个——见契约 `HistoryQuery`）。 */
function historyQueryOf(args: Readonly<Record<string, unknown>>): HistoryQuery | string {
  for (const key of ['before', 'entry'] as const) {
    const problem = idProblemOf(args[key], key)
    if (problem !== undefined) return problem
  }

  const offset = args['offset']
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)) {
    return '参数错误：offset 须是从 0 起的整数（只配合 entry 用）'
  }

  const before = args['before'] as number | undefined
  const entry = args['entry'] as number | undefined

  if (before !== undefined && entry !== undefined) {
    return '参数错误：before（往前翻页）与 entry（看某一条）不能一起给——要哪种定位就只给哪种'
  }
  if (offset !== undefined && entry === undefined) {
    return '参数错误：offset 只配合 entry 用（单独给一个 offset 不知道该读哪一条）'
  }

  return {
    ...(before === undefined ? {} : { before }),
    ...(entry === undefined ? {} : { entry }),
    ...(offset === undefined ? {} : { offset }),
  }
}

/** 记录号参数——不在场（`undefined`）不算错；在场但不是正整数＝错。 */
function idProblemOf(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return `参数错误：${key} 须是记录号（正整数）`
  }
  return undefined
}
