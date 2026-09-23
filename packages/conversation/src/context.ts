/**
 * Context 装配 —— **由会话条目重建模型消息**（技术方案 · 领域划分：上下文由对话域装配）。
 *
 * 四步（阶段 3 添了第 ④ 步）：
 * ① 系统提示词即 `role:'system'` 的**首条**消息（提示词部件在 `./prompt/`，装配在 `./service.ts`）；
 * ② **定边界**（`planContext`）——压过的会话：旧段由一条 `summary` 顶掉，近段与新增照旧；
 * ③ 余下条目按序展开——`user` / `assistant`（带 `toolCalls`）/ `tool`（`callId` / `name` / `ok` / `output`）；
 * ④ 条目里的 blob 引用在装配时**解析为文本**（按策略截断）——记录只存引用，正文归装配取回。
 *
 * **工具消息的正文取条目正文、不取载荷**（第 2 轮 · 契约补锚）——工具条目的两个字段载两样
 * 东西：正文＝**面向模型的文本**（工具域 `ToolResult.output`，按上限截断）；载荷＝**记录侧
 * 形态**（`ToolResult.content`，全量，可能是 blob）。送模型的是前者——重放时逐字复原模型
 * 当时看到的那一份；后者留给审计与阶段 2 恢复的处置。
 *
 * **为什么由条目重建**（不是维护一个内存数组）——技术方案 · 记录：「上下文由条目重建」；
 * 恢复（阶段 2）走的也是这条路。代价是每轮多读一次条目，换来的是**记录即真源**：
 * 循环中途崩掉 / 被中止，下一轮装配出来的仍是记录里那个现场。
 *
 * **两处形态缺口（规约 4：本单元自决形态 · 只增不改 · 随回报备案）**：
 *
 * 1. **配对键由条目 id 派生**（`pairingKeyOf`）。契约的 `ToolCall.id` 是**供应商侧**调用 id
 *    （「只用于回填配对」），而条目侧的 `ToolCallPayload` 只有 `{ name, args }`——供应商 id
 *    **不入记录**。故重建期的配对键取「该次 `tool-call` 条目的 id」：回填配对只要求
 *    「助手消息的 `ToolCall.id`」与「工具消息的 `callId`」**同一次请求内自洽**，条目 id
 *    唯一且跨轮稳定，正合此用。供应商 id 是**线上概念**（一次调用内有效），不入记录并无损失。
 *
 * 2. **落单的 `tool-call` 不进上下文**——有调用条目而无结果条目＝进程被杀那一路留下的**在途**
 *    调用（U02 备案：在途识别＝有 `tool.call` 无 `tool.result`）。带 `toolCalls` 而无对应
 *    工具消息的助手消息**会被供应商拒**（整条上下文作废），故此处**不送**；怎么处置这条在途
 *    （重放 / 补偿 / 拒绝）是**恢复**的判据——U25 起在 `@magic/actions`；本单元只保证装配出的
 *    上下文合法（恢复补记之后，那条落单的调用就有回填了，故它不再被跳过）。
 *
 * ## 压缩（阶段 3 · U19）：摘要 ＋ 近段原文
 *
 * 压缩**只动上下文装配，不动记录**（技术方案 · 上下文压缩：append-only 不破）——
 * 记录里一条都不少，少的是**送模型的那一份**：旧段被一条 `summary` 条目顶掉，近段照旧原文。
 *
 * **边界由 `summary` 条目的位置定**（`planContext`）：条目只能追加，故摘要写在旧段**之后**，
 * 而它前面的**最后 `nearEntries` 条**就是「近段」——那是压缩那一刻刻意没压的尾巴，
 * 位置既已固定，装配随时能按同一条规则把它认回来：
 *
 * ```text
 * 条目流： [ 旧段（被压） ][ 近段（原文，K 条） ][ summary ][ 其后新增的（原文）… ]
 *                              ↑ 窗口 = 摘要前 K 条        ↑ 摘要之后的照常展开
 * 送模型： [system][摘要块][近段展开…][其后新增展开…]
 * ```
 *
 * **为什么要留近段**——压成光秃秃一份摘要，模型接着干活的现场感就没了（刚跑的命令、
 * 刚看到的报错都在摘要里磨平了）；近段原文保的正是「接着干」这一口气。
 *
 * **窗口按条目数、不按回合切**——边界可能落在一次工具往返的中间，那半截的 `tool` 消息
 * 按上面注 2 被丢掉（供应商侧仍然合法）。真实代价如实记：边界附近至多丢一次工具结果，
 * 而它本就在摘要覆盖的那一侧。
 */

import type {
  BlobStore,
  Content,
  Entry,
  EntryPayload,
  InputRefEntry,
  ModelMessage,
  RecordId,
  RecordsService,
  SessionId,
  ToolCall,
  ToolResultPayload,
  ToolCallPayload,
  UsedSkillEntry,
} from '@magic/contracts'
import { planMaterialOf } from './plan.ts'

/**
 * blob 解析回文本的缺省上限（**字符**）——「按策略截断」（技术方案 · 领域划分 · 端口内类型）。
 * 只定「一条 blob 正文最多带多少进上下文」——**与压缩是两件事**：这个管单条的粗细，
 * 压缩管整段的去留（阈值 / 近段边界见 `./policy.ts`）。
 * 缺省值与策略对象（`./policy.ts`）同源——读侧单独用时不至于各写一个数。
 */
export const DEFAULT_BLOB_TEXT_LIMIT = 2000

/**
 * 「近段」边界（条目数）——压缩时**不压**的尾部，也是装配时从摘要往前认回来的那一段
 * （技术方案 · 上下文压缩：「上下文＝摘要 ＋ 近段原文」）。
 *
 * 缺省 20 的由头：工具往返一轮吃掉 3–4 条（助手 ＋ 调用 ＋ 结果），20 条 ≈ 最近五六轮的
 * **真身**——够模型接着干活，又不至于让压缩刚做完就再撞阈值。
 *
 * **两处必须同一个数**（压缩写、装配读）——故策略对象（`./policy.ts`）取的就是这一个常量，
 * 不与读侧各写一个（同 `DEFAULT_BLOB_TEXT_LIMIT` 的既定姿势）。
 */
export const DEFAULT_NEAR_ENTRIES = 20

export type AssembleContextInput = {
  readonly records: RecordsService
  /** 会话——条目按会话读（`readEntries` 的分束键）。 */
  readonly session: SessionId
  /** 系统提示词全文——由提示词部件装配好后传入（本文件不认知提示词的段结构）。 */
  readonly systemPrompt: string
  /** blob 正文上限（字符）——缺省 `DEFAULT_BLOB_TEXT_LIMIT`。 */
  readonly blobTextLimit?: number
  /** 「近段」条数（压缩后从摘要往前认几条原文）——缺省 `DEFAULT_NEAR_ENTRIES`。 */
  readonly nearEntries?: number
}

/**
 * 装配的计划——**哪些条目进上下文、旧段被哪条摘要顶掉**。
 *
 * 摘要是**条目**（`content` 里有正文），由调用方解析正文（可能要取 blob）——本函数
 * 只做**位置的算术**，不碰内容，故是纯函数、可直接断言。
 */
export type ContextPlan = {
  /** 顶掉旧段的那条 `summary` 条目——**没压过就是 `undefined`**。 */
  readonly summary: Entry | undefined
  /** 要展开成消息的条目——压过＝近段窗口 ＋ 摘要之后的条目；没压过＝全部。 */
  readonly entries: readonly Entry[]
}

/**
 * 定边界——最新那条 `summary` 条目即分水岭：它**往前 `nearEntries` 条**是近段（原文照送），
 * 再往前是旧段（已被它顶掉），它之后的新条目照常展开。
 *
 * **为什么认「摘要之前 K 条」而不是「最后 K 条」**：条目只能追加，摘要落在近段之后——
 * 若按「最后 K 条」算，摘要一进来就会把刚留下的近段判成「更早」，当场自相矛盾。
 * 按「摘要前 K 条」算，边界就此钉在压缩那一刻的位置上，后续追加不影响它。
 *
 * 反复压缩（B6）不需要特判：旧摘要就在新摘要的覆盖段里，会被一并再摘要一遍——
 * 记录 append-only 不破，条目流只是多了一条更靠后的 `summary`。
 */
export function planContext(input: {
  readonly entries: readonly Entry[]
  readonly nearEntries: number
}): ContextPlan {
  const { entries } = input

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.kind !== 'summary') continue

    const from = Math.max(0, index - input.nearEntries)
    return {
      summary: entry,
      entries: [...entries.slice(from, index), ...entries.slice(index + 1)],
    }
  }

  // 没压过——全部条目原文进上下文（阶段 1 / 2 的既有行为，一字不动）
  return { summary: undefined, entries: [...entries] }
}

/**
 * 装配上下文——由**会话条目**重建模型消息。
 *
 * 空会话的产物＝只有系统提示词一条（首条对话必是 `user`，故不会出现空对话的畸形请求）。
 */
export async function assembleContext(
  input: AssembleContextInput,
): Promise<readonly ModelMessage[]> {
  const limit = input.blobTextLimit ?? DEFAULT_BLOB_TEXT_LIMIT
  const messages: ModelMessage[] = [{ role: 'system', content: input.systemPrompt }]

  // 条目一次取尽——`assistant` 消息的 `toolCalls` 来自**紧随其后**的调用条目（需前瞻一拍），
  // 故先缓冲再走。上下文本就整条送模型，缓冲不增峰值（压缩也只多读一遍，见 `./compact.ts`）。
  const all: Entry[] = []
  for await (const entry of input.records.readEntries(input.session)) all.push(entry)

  /**
   * **完整展开成工具消息**的那些工具结果条目（U34）——计划材料据此判「已经送达了吗」。
   *
   * 只记**完整**的：正文被截断的不进（设计明写「正文被截断不算已经送达」），
   * 配对被丢弃的也不进（落单的 `tool-call` 那一路根本不展开，见文件头注 2）。
   */
  const delivered = new Set<RecordId>()

  // 压缩过就先摆摘要头，再展开「近段 ＋ 摘要之后的条目」（见文件头注 · 边界由摘要位置定）
  const plan = planContext({ entries: all, nearEntries: input.nearEntries ?? DEFAULT_NEAR_ENTRIES })
  if (plan.summary !== undefined) {
    messages.push(summaryMessage(await contentTextOf(plan.summary.content, input.records, limit)))
  }

  const entries = plan.entries
  let index = 0
  while (index < entries.length) {
    const entry = entries[index]
    if (entry === undefined) break

    if (entry.kind === 'user') {
      // **材料随用户消息一起摆，且**在原位**（U36）——每一处引用在它被说出来的那个位置
      // 展开（正文一个字不剥、前后文字照旧指向各自的对象）。
      //
      // 两种载荷两形（见 `UserPayload`）：
      // - `refs`（U36）——带位置，按位置展开（`inlineOf`）；
      // - `skills`（U33 旧形）——没有位置，照旧统一摆在正文之前（旧记录按原样重放，
      //   不替它编一个插入点）。
      //
      // 两半都取自**这一条条目**（话在正文、材料在载荷），故重放时逐字复原模型当时看到
      // 的那一份，**不重新去读文件**（源改了之后新调用才取新的，历史不被改写）。
      const text = await contentTextOf(entry.content, input.records, limit)
      const payload = entry.payload
      const refs = refsPayloadOf(payload)
      const skills = userPayloadOf(payload)

      const body =
        refs.length > 0
          ? inlineOf(text, refs)
          : skills.length === 0
            ? text
            : `${skillsBlockOf(skills)}\n\n${text}`

      messages.push({ role: 'user', content: body })
      index += 1
      continue
    }

    if (entry.kind === 'assistant') {
      const toolCalls: ToolCall[] = []
      const toolMessages: ModelMessage[] = []

      // 助手消息带上它请求的那些调用——写入侧按「调用 → 结果」成对落账、同轮按序逐个，
      // 故此处照序配对：`tool-call` 条目 ＋ 紧随的 `tool-result` 条目 ＝ 一次调用。
      let cursor = index + 1
      for (;;) {
        const callEntry = entries[cursor]
        const resultEntry = entries[cursor + 1]
        if (callEntry?.kind !== 'tool-call') break
        // 无结果＝在途调用——不进上下文（见文件头注 2），并就此打住本轮的配对
        if (resultEntry?.kind !== 'tool-result') break

        const call = toolCallPayloadOf(callEntry.payload)
        const result = toolResultPayloadOf(resultEntry.payload)
        if (call === undefined || result === undefined) break

        const pairKey = pairingKeyOf(callEntry.id)
        toolCalls.push({ id: pairKey, name: call.name, args: call.args })

        // 正文取**条目正文**（面向模型的文本，工具域按上限截断的那份）——
        // **不是**载荷里的记录形态：那是全量（可能是 blob），送模型的是这份截断文本。
        // 重放时因此逐字复原模型当时看到的那一份。
        //
        // 另记「这一份是不是完整的」（U34）——计划材料只认完整的那些（见 `delivered`）
        const content = await deliveredTextOf(resultEntry.content, input.records, limit)
        if (content.complete) delivered.add(resultEntry.id)

        toolMessages.push({
          role: 'tool',
          callId: pairKey,
          // 工具名**取自发起它的调用条目**，不从助手消息反查——压缩（阶段 3）来时反查会静默退化
          name: call.name,
          ok: result.ok,
          output: content.text,
        })
        cursor += 2
      }

      messages.push({
        role: 'assistant',
        content: await contentTextOf(entry.content, input.records, limit),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      })
      messages.push(...toolMessages)
      index = cursor
      continue
    }

    // `summary`——它落在**近段窗口里**（旧摘要离得太近，还没被新摘要顶掉）。照旧当一段
    // 摘要块送出去：窗口里出现的摘要**没被新摘要覆盖**，丢了就是真丢（见 `planContext`）。
    if (entry.kind === 'summary') {
      messages.push(summaryMessage(await contentTextOf(entry.content, input.records, limit)))
      index += 1
      continue
    }

    // `tool-call` / `tool-result` 已在上面按对消费；走到这里＝落单者（在途 / 无来处），不进上下文。
    index += 1
  }

  // **计划笔记的**再交付（U34）——压出窗口之后，最新笔记要重新回到模型眼前
  // （设计 · 上下文接入：最新内容已被压出窗口时，追加一份带记录位置的 assistant 会话材料）。
  // 判据与限度都在 `./plan.ts`：只有「当前计划条目没被完整送达」时才加，加的是**既有笔记**
  // 而不是新交代（故不用 system 角色、不伪造用户消息）。
  // （判据与限度都在 `./plan.ts`：只有「当前计划条目没被完整送达」时才加，
  //   加的是**既有笔记**而不是新交代——故不用 system 角色、不伪造用户消息。）
  const material = planMaterialOf({ delivered, all })
  if (material !== undefined) messages.push(material)

  return messages
}

/**
 * 摘要块——**以 `user` 消息送出**（而不是往系统提示词里拼）：
 * 系统提示词由内核持有、随版本治理（技术方案 · 系统提示词），压缩是**会话内**发生的事，
 * 混进去会让「提示词说了什么」随会话历史而变。另起一条 `user` 消息也让摘要的**位置**是对的
 * ——它讲的事都发生在近段之前。
 */
export function summaryMessage(text: string): ModelMessage {
  return { role: 'user', content: `【此前对话的摘要（上下文已压缩；原文仍在记录里）】\n${text}` }
}

/**
 * 配对键——由 `tool-call` 条目的 id 派生（见文件头注 1）。
 *
 * 前缀是刻意的：供应商 id 形如 `call_1`，两串 id 在日志里**一眼分得开**，
 * 免得调试时把「记录里的配对键」误当「线上的调用 id」。
 */
export function pairingKeyOf(entryId: RecordId): string {
  return `entry_${entryId}`
}

// —— 内容 → 文本（blob 解析 ＋ 截断）——

/**
 * 条目内容 → **原始文本**（不做任何截断）：内联者原样，blob 引用者取回。
 *
 * 一处解码、两处按各自的口径切：装配那一侧按 `blobTextLimit` 截（送模型的那一份要细），
 * 回查那一侧按记录位置切片（U34 的历史回查——`./plan.ts`）。
 * 两个解码器＝两处可能不同的编码假设，故只此一处。
 */
export async function rawTextOf(
  content: Content,
  records: { readonly blobs: BlobStore },
): Promise<string> {
  if ('text' in content) return content.text

  return new TextDecoder().decode(await records.blobs.get(content.blob))
}

/**
 * 条目内容 → 文本：内联者原样，blob 引用者取回按策略截断。
 *
 * **导出给压缩用**（`./compact.ts` 把旧段渲染成摘要请求时要取同一份正文）——
 * 两处各写一遍截断，迟早截出两种口径（同一段原文，送模型的和进摘要的长度不一样）。
 */
export async function contentTextOf(
  content: Content,
  records: { readonly blobs: BlobStore },
  limit: number,
): Promise<string> {
  return (await deliveredTextOf(content, records, limit)).text
}

/**
 * 与 `contentTextOf` 同一份文本，另带**「完整送达了吗」**——U34 的计划材料据它判
 * 「最新笔记是不是已经完整落在这一次的消息里」（设计：正文被截断的不算已经送达）。
 *
 * 截断留痕照旧（模型看得到「这里被截了」与原文规模，才不会把半截结果当完整事实下结论）。
 */
export async function deliveredTextOf(
  content: Content,
  records: { readonly blobs: BlobStore },
  limit: number,
): Promise<{ readonly text: string; readonly complete: boolean }> {
  const text = await rawTextOf(content, records)
  if (text.length <= limit) return { text, complete: true }

  return {
    text: `${text.slice(0, limit)}\n…（截断：原文 ${text.length} 字符，以上为前 ${limit} 字符）`,
    complete: false,
  }
}

// —— 载荷收窄（契约的 `Entry.payload` 是松散联合；域间不得互 import，故自持一份）——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContent(value: unknown): value is Content {
  return isRecord(value) && (typeof value['text'] === 'string' || typeof value['blob'] === 'string')
}

/**
 * 判据收在 `unknown` 入口——`EntryPayload` 是对象联合，直接收窄不会长出索引面。
 * **导出给压缩用**（`./compact.ts` 要把旧段渲染成文本，认的得是同一份载荷形态——
 * 两处各收窄一次，迟早收出两种口径）。
 */
export function toolCallPayloadOf(payload: EntryPayload | undefined): ToolCallPayload | undefined {
  const source: unknown = payload
  if (!isRecord(source)) return undefined

  const { name, args } = source
  if (typeof name !== 'string' || !isRecord(args)) return undefined

  return { name, args }
}

export function toolResultPayloadOf(payload: EntryPayload | undefined): ToolResultPayload | undefined {
  const source: unknown = payload
  if (!isRecord(source)) return undefined

  const { ok, output } = source
  if (typeof ok !== 'boolean' || !isContent(output)) return undefined

  return { ok, output }
}

/**
 * 用户条目的载荷 → 技能材料（U33）——**只认三件齐全的**（名字 / 来源 / 正文）。
 *
 * 缺一件的那条**不当作材料**（当作没有）：它进不了模型眼前这件事，比多送半条要好——
 * 半条材料会让模型按一份内核都没看全的东西干活（同发现那一步「读不懂的不生效」）。
 * 与别处同一姿势：判据收在 `unknown` 入口，靠收窄不靠 `as`。
 */
export function userPayloadOf(payload: EntryPayload | undefined): readonly UsedSkillEntry[] {
  const source: unknown = payload
  if (!isRecord(source)) return []

  const declared = source['skills']
  if (!Array.isArray(declared)) return []

  const skills: UsedSkillEntry[] = []
  for (const item of declared) {
    if (!isRecord(item)) continue

    const { name, source: from, text } = item as Record<string, unknown>
    if (typeof name !== 'string' || typeof from !== 'string') continue
    if (typeof text !== 'string') continue

    skills.push({ name, source: from, label: String(item['label'] ?? ''), text })
  }

  return skills
}

/**
 * 用户条目的载荷 → 引用表（U36）——**只认三件齐全的**（位置 / 标记 / 来源），
 * 内容那一格按 kind 各取各的（技能与文件都要 `text`，目录也一样）。
 *
 * 缺件的条目**不当作材料**（当作没有）：与 `userPayloadOf` 同一条姿势——半条材料会让模型
 * 按一份内核都没看全的东西干活。旧库（只有 `skills` 键）在这里读出空数组，走另一支。
 */
export function refsPayloadOf(payload: EntryPayload | undefined): readonly InputRefEntry[] {
  const source: unknown = payload
  if (!isRecord(source)) return []

  const declared = source['refs']
  if (!Array.isArray(declared)) return []

  const refs: InputRefEntry[] = []
  for (const item of declared) {
    if (!isRecord(item)) continue

    const at = item['at']
    const marker = item['marker']
    const from = item['source']
    const text = item['text']
    if (typeof at !== 'number' || typeof marker !== 'string') continue
    if (typeof from !== 'string' || typeof text !== 'string') continue

    const label = typeof item['label'] === 'string' ? item['label'] : ''

    if (item['kind'] === 'skill') {
      const name = item['name']
      if (typeof name !== 'string') continue
      refs.push({ kind: 'skill', at, marker, name, source: from, label, text })
      continue
    }

    if (item['kind'] === 'dir') {
      const omitted = item['omitted']
      refs.push({
        kind: 'dir',
        at,
        marker,
        source: from,
        label,
        text,
        ...(typeof omitted === 'number' ? { omitted } : {}),
      })
      continue
    }

    if (item['kind'] === 'file') {
      refs.push({
        kind: 'file',
        at,
        marker,
        source: from,
        label,
        text,
        ...(item['truncated'] === true ? { truncated: true as const } : {}),
        ...(item['external'] === true ? { external: true as const } : {}),
      })
    }
  }

  return refs
}

/**
 * **正文 ＋ 引用处的材料**——材料**展开在它被说出来的那个位置**（U36）。
 *
 * 三条分寸：
 * - **正文一个字不剥**：`/review`、`@src/login.ts` 照旧留在句子里——前后文字指向哪件事
 *   靠的就是这个次序（设计 · 终端交互：「模型收到的也须保留这个对应关系」）；
 * - **材料插在那一处引用之后**：读者读到 `先读 @需求.md`，紧跟着就是那份需求——而不是
 *   一整摞材料摆在最前面、再由用户自己认哪份管哪处；
 * - **位置越界一律夹回**（手改过的旧记录 / 越界数据）：宁可把材料摆在末尾，也不把它丢掉
 *   或插到一段文字中间。
 */
export function inlineOf(text: string, refs: readonly InputRefEntry[]): string {
  const ordered = [...refs].sort((left, right) => left.at - right.at)
  let out = ''
  let cursor = 0

  for (const ref of ordered) {
    // 材料接在**引用文字之后**（`at` ＋ 标记长度），且不许越过上一份材料
    const end = Math.max(cursor, Math.min(ref.at + ref.marker.length, text.length))
    out += `${text.slice(cursor, end)}\n${materialBlockOf(ref)}\n`
    cursor = end
  }

  return out + text.slice(cursor)
}

/**
 * 一处引用的材料块——**抬头说清是什么、从哪来；结尾划出边界**。
 *
 * 抬头三件（缺一件，模型就会把材料当成别的东西）：
 * - **类别**（技能 / 文件 / 目录）——技能是「别人写好的做法」，文件是「读出来的事实」；
 * - **用户说的那一处**（`marker` 去掉 `@`／`/`）——对上正文里那一段；
 * - **来源**（`label`）——同名两份靠它分得开；工作区外那份另外标一句「只读附件」。
 *
 * 结尾那一行是**边界**：材料是**被引用的东西**，不是用户在说话（也不是助手的产出）。
 * 长材料一旦没有结尾，后面接着的文字就会被读成材料的一部分——那正是「拿材料里的字当
 * 用户的话」这条错法的入口。
 *
 * 截断 / 未展开**在抬头就说明白**（`truncated` / `omitted`）：宁可先说「只送到这里」，
 * 也不能让模型以为手里是全份（设计：不能静默缺材料）。
 */
function materialBlockOf(ref: InputRefEntry): string {
  const kind = ref.kind === 'skill' ? '技能' : ref.kind === 'dir' ? '目录' : '文件'
  const external = ref.kind === 'file' && ref.external === true ? '（工作区外 · 只读附件）' : ''
  const cut = ref.kind === 'file' && ref.truncated === true ? '（原文更长，这里是前一段）' : ''
  const more = ref.kind === 'dir' && ref.omitted !== undefined ? `（只列了这一层，另有 ${ref.omitted} 项未列）` : ''

  const head =
    ref.kind === 'skill'
      ? `〔本次技能 · ${ref.name}（来源 ${ref.label}）〕`
      : `〔本次材料 · ${kind} ${ref.label}${external}${cut}${more}〕`

  return `${head}\n${ref.text}\n〔${ref.kind === 'skill' ? '技能' : '材料'}完 · ${ref.kind === 'skill' ? ref.name : ref.label}〕`
}

/**
/**
 * 技能材料摆成块（**U33 旧形**——`UserPayload.skills`，无位置的那一份）。
 *
 * 抬头给三件：名字（模型要用它取引用）、来源（同名时靠它分得开）、以及一句
 * 「以下是一份技能说明」——**技能说明与读出来的数据是两种东西**（工单明写），
 * 抬头就是那条分界线：模型据此知道这是**别人写好的做法**，不是它自己查出来的事实。
 *
 * ⚠️ **U36 起新写入不走这里**：正文里带位置的引用走 `inlineOf`（材料展开在那一处，
 * 抬头另有一形）。本函数留着只为**旧记录照原样重放**——旧条目的载荷里没有位置，
 * 材料本来就是统一前置的，硬套新形式等于替它编一个插入点。
 */
function skillsBlockOf(skills: readonly UsedSkillEntry[]): string {
  return skills
    .map((skill) => `〔本次使用技能：${skill.name}（来源 ${skill.label}）〕\n${skill.text}`)
    .join('\n\n')
}
