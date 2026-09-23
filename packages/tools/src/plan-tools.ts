/**
 * 计划与历史三件 —— `plan_read` · `plan_update` · `history_read`（U34）。
 *
 * 出处：设计 · 长任务计划与进度辅助（「数据与工具契约」那张表）。三件是**同一个功能的三面**：
 * 读当前笔记、写当前笔记、回查会话记录——故一个文件、一处造，不拆三家。
 *
 * ## 这一域只做「把参数摆对、把结果摆成模型读得懂的文本」
 *
 * 真正的判据全在**对话域**（`PlanReader`）：
 * - 当前计划 ＝ 最近一条成功且含 `plan` 的工具结果（**记录即真源**，本域不缓存、不推断）；
 * - 历史缺位置时从**活动窗口之前**读起（窗口边界是上下文那件事）。
 * 本域拿到的是一对**会话绑定的只读回调**——它不认识记录、不认识上下文，
 * 更不碰文件系统（「不经 shell 访问数据库」是纪律，不是分寸）。
 *
 * ## 更新那件的载荷怎么走（**本域不自行先写记录**）
 *
 * `plan_update` 只把 `PlanNote`（或 `null` ＝ 清空）**交回分发**（`ToolRunResult.plan`），
 * 由对话域随工具结果**一次**落进条目载荷、落账之后才发 `plan.changed`。故「先写计划、
 * 再写工具结果」这条错法在这一域**结构上无处发生**——这里根本没有写的口子。
 *
 * ## 参数校验的限度（设计明写）
 *
 * 只查**可读取的结构与状态取值**：步骤是不是对象、`text` 是不是非空字符串、
 * `status` 在不在那三格里。**不做**长度检查、步数检查、「只能有一个进行中」、
 * 「必须照某个模板」——步骤文本的「建议二十个字左右」**只写在参数说明里**
 * （见 `STEP_TEXT`），不另加统计、截断、警告或拒绝。
 *
 * ## 权限
 *
 * 三件的静态归类都是 `light`（只读同会话记录 / 只写协作笔记，不碰工作区），
 * 但**判定不在这儿**：权限域的分析表要显式认这三格，装配另按名字追加放行规则
 * （见 `@magic/permission` · `analyze.ts` 与 `@magic/app` · `assembly.ts`）。
 */

import type {
  HistoryEntry,
  HistoryPage,
  HistoryQuery,
  PlanNote,
  PlanReader,
  PlanSnapshot,
  PlanStep,
} from '@magic/contracts'
import { isText } from './args.ts'
import type { ToolDefinition, ToolRunResult } from './registry.ts'
import { refused, reasonOf } from './toolkit.ts'

/**
 * 三个名字——**归属明确**（装配按它追加放行规则、权限域按它认这三格）。
 *
 * 挂在工具定义旁边而不是散在各处：改名时改一处就够（另一处漏了，放行规则会静默失效，
 * 而那正是「每次都弹卡」或「悄悄免审」两头之一）。
 */
export const PLAN_READ_TOOL = 'plan_read'
export const PLAN_UPDATE_TOOL = 'plan_update'
export const HISTORY_READ_TOOL = 'history_read'

/** 三个名字齐——装配与权限域共用的一处清单。 */
export const PLAN_TOOL_NAMES: readonly string[] = [
  PLAN_READ_TOOL,
  PLAN_UPDATE_TOOL,
  HISTORY_READ_TOOL,
]

// ══ 参数模式 ══════════════════════════════════════════════════════════

/**
 * 步骤文本那一格——**「建议二十个字左右」只在这里**（设计明写：不加字数检查、
 * `maxLength`、警告或拒绝；界面按终端宽度正常换行，不按二十字裁切）。
 */
const STEP_TEXT = {
  type: 'string',
  description: '简短说明这一步要做成什么，建议二十个字左右。',
} as const

const STEP_STATUS = {
  type: 'string',
  enum: ['pending', 'in_progress', 'completed'],
  description: '这一步的进展：未开始 / 进行中 / 已完成',
} as const

export const PLAN_READ_PARAMETERS = {
  type: 'object',
  description: '取当前会话的计划笔记（步骤清单与辅助笔记）。没有建立过就如实说没有。',
  properties: {},
  required: [],
  additionalProperties: false,
} as const

export const PLAN_UPDATE_PARAMETERS = {
  type: 'object',
  description:
    '更新当前计划笔记：给 plan 就整体替换（步骤清单 ＋ 辅助笔记），给 null 就清空。' +
    '它保存你的判断，不验证工作是否完成、也不控制执行。',
  properties: {
    plan: {
      type: ['object', 'null'],
      description: '新的计划内容；null ＝ 清空当前计划笔记（过程仍在会话记录里）',
      properties: {
        steps: {
          type: 'array',
          description: '有序步骤清单——用户会看到它，按你要得到的结果拆',
          items: {
            type: 'object',
            properties: { text: STEP_TEXT, status: STEP_STATUS },
            required: ['text', 'status'],
            additionalProperties: false,
          },
        },
        notes: {
          type: 'string',
          description:
            '辅助笔记：目标、关键约束、已确认事实、未解决问题与回查线索；没有就留空串',
        },
      },
      required: ['steps', 'notes'],
      additionalProperties: false,
    },
  },
  required: ['plan'],
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
 * 没有步骤就说「（还没有步骤）」，没有笔记就不占一行。
 */
export function planTextOf(plan: PlanNote): string {
  const lines: string[] = ['步骤：']

  if (plan.steps.length === 0) lines.push('（还没有步骤）')
  else plan.steps.forEach((step, index) => lines.push(`${index + 1}. [${STATUS_LABEL[step.status]}] ${step.text}`))

  if (plan.notes.trim() !== '') lines.push(`笔记：${plan.notes}`)
  return lines.join('\n')
}

/** 没建立过计划时的回执——**如实说没有**，不编一份空的。 */
const NO_PLAN = '这个会话还没有计划笔记。需要时用 plan_update 建立一份（步骤清单 ＋ 辅助笔记）。'

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

// ══ 三件 ═════════════════════════════════════════════════════════════

/**
 * 造三件工具。`reader` 是**会话绑定**的（装配按会话各造一份）——故三个工具实例
 * 也按会话各造一份：它们手里的读写范围就是那一条会话，模型给不出第二条。
 */
export function definePlanTools(reader: PlanReader): readonly ToolDefinition[] {
  // ⚠️ 更新那件**不接读面**：它只核对参数、交回载荷（写记录归对话域）——
  // 手里没有读口子，也就没有「先读旧计划再拼一份新的」这条歧路可走。
  return [readTool(reader), updateTool(), historyTool(reader)]
}

function readTool(reader: PlanReader): ToolDefinition {
  return {
    spec: {
      name: PLAN_READ_TOOL,
      summary: '取当前会话的计划笔记（步骤清单与辅助笔记）',
      parameters: PLAN_READ_PARAMETERS,
      danger: { level: 'light' },
    },

    async run(): Promise<ToolRunResult> {
      try {
        return { ok: true, output: readReceipt(await reader.readPlan()) }
      } catch (error) {
        return refused(`计划读取失败：${reasonOf(error)}`)
      }
    },
  }
}

function updateTool(): ToolDefinition {
  return {
    spec: {
      name: PLAN_UPDATE_TOOL,
      summary: '整体替换当前计划笔记，或清空它（只保存判断，不控制执行）',
      parameters: PLAN_UPDATE_PARAMETERS,
      danger: { level: 'light' },
    },

    run(args): ToolRunResult {
      // **`undefined` 与 `null` 分得开**：没给这一位＝调用不成立（模式要求必填）；
      // 给了 `null` 才是「清空」（`in` 判在场——`args['plan'] === undefined` 会把两者混成一件）
      if (!('plan' in args)) {
        return refused('参数错误：要更新就给 plan（对象），要清空就给 plan: null')
      }

      const raw = args['plan']
      if (raw === null) {
        return {
          ok: true,
          output: '计划笔记已清空。过程仍在会话记录里（history_read 可回查，排障时用得上）。',
          plan: null,
        }
      }

      const parsed = planOf(raw)
      if (typeof parsed === 'string') return refused(parsed)

      return {
        ok: true,
        // **回执里带上完整正文**：它是模型此后判断「手上有没有最新计划」的那一份
        // （上下文装配按「这条结果完整落在窗口里没有」判，见 `readReceipt` 的注）
        output: `计划笔记已更新：\n${planTextOf(parsed)}`,
        plan: parsed,
      }
    },
  }
}

/**
 * 参数 → 计划笔记（`undefined` 之外的一切都由这里收口）。
 *
 * 只查结构（见文件头注）：一有不合就**整条拒绝**——半份计划比没有更坏
 * （步骤少了一条，读的人不会知道少的是哪一条）。
 */
function planOf(raw: unknown): PlanNote | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return '参数错误：plan 须是 { steps, notes } 对象，或 null（清空）'
  }

  const fields = raw as Record<string, unknown>
  const steps = fields['steps']
  if (!Array.isArray(steps)) return '参数错误：plan.steps 须是数组（没有步骤就给空数组）'

  const parsed: PlanStep[] = []
  for (const [index, item] of steps.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return `参数错误：第 ${index + 1} 个步骤须是对象（形如 { text, status }）`
    }

    const step = item as Record<string, unknown>
    if (!isText(step['text'])) {
      return `参数错误：第 ${index + 1} 个步骤缺 text（须是非空字符串）`
    }

    const status = step['status']
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      return `参数错误：第 ${index + 1} 个步骤的 status 须是 pending / in_progress / completed 之一`
    }

    parsed.push({ text: step['text'], status })
  }

  const notes = fields['notes']
  if (notes !== undefined && typeof notes !== 'string') {
    return '参数错误：plan.notes 须是字符串（没有就留空串）'
  }

  return { steps: parsed, notes: notes ?? '' }
}

function historyTool(reader: PlanReader): ToolDefinition {
  return {
    spec: {
      name: HISTORY_READ_TOOL,
      summary: '读当前会话的一段实际记录（默认从当前上下文之前翻起）',
      parameters: HISTORY_READ_PARAMETERS,
      danger: { level: 'light' },
    },

    async run(args): Promise<ToolRunResult> {
      const query = historyQueryOf(args)
      if (typeof query === 'string') return refused(query)

      try {
        return { ok: true, output: historyReceipt(await reader.readHistory(query)) }
      } catch (error) {
        return refused(`历史读取失败：${reasonOf(error)}`)
      }
    },
  }
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
