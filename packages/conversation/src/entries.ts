/**
 * 条目落账 —— 对话域的**写入侧**（读取侧＝装配，在 `./context.ts`）。
 *
 * 会话推进（条目落账）归对话域（技术方案 · 领域划分：对话域「不认知任何域的内部……
 * 会话推进（条目落账）归它」）。四类条目（技术方案 · 记录 · 条目）：
 *
 * | kind | 正文（`content`） | 载荷（`payload`） |
 * | --- | --- | --- |
 * | `user` | **用户的话**（超阈值转 blob） | ——，或随这次交代送出去的技能材料（U33） |
 * | `assistant` | 正文（超阈值转 blob） | —— |
 * | `tool-call` | 空 | `{ name, args }`——**重放真源** |
 * | `tool-result` | **面向模型的文本**（工具域截好的那份） | `{ ok, output }`——**记录侧形态**，与 `tool.result` 事件的 `output` 同物；读技能的那件另带交付身份（U33） |
 * | `summary` | 摘要全文（超阈值同样转 blob） | ——（阶段 3 压缩的产物，见 `./compact.ts`） |
 *
 * **工具结果为什么两个字段各载一样**（第 2 轮 · 契约补锚）——契约 `ToolResult` 载**两样输出**：
 * `output` 是面向模型的文本（按上限截断），`content` 是记录侧形态（内联或 blob）。
 * 本域照此落两处：**正文**取 `output`（重放时逐字复原模型当时看到的那一份）；
 * **载荷**取 `content`（重放真源——大输出在库里是全量，不因截断丢尾巴）。
 * 此前把面向模型的文本当内联记，大输出下条目与事件会当场分叉——现已对齐。
 *
 * `tool-call` 条目的正文则留空：那次调用没有「给模型看的文本」（调用本身在助手消息里）。
 *
 * **`at` 由调用方给**——记录域不取时钟（U02 备案）；本域取时钟只经 `now` 一处，
 * 装配时可注入固定钟（测试可复现）。
 */

import type {
  AssistantPayload,
  Content,
  InputRefEntry,
  PlanNote,
  RecordId,
  RecordsService,
  Timestamp,
  ToolCall,
  ToolResult,
  UsedSkill,
  UsedSkillEntry,
} from '@magic/contracts'

/** 落账的依赖束——记录面 ＋ 时钟 ＋ 阈值（由循环的构造入参给出）。 */
export type EntryLog = {
  readonly records: RecordsService
  /** 时钟——**本域取时钟的唯一出处**（别处不各取各的）。 */
  readonly now: () => Timestamp
  /** 正文字数阈值——超者转 blob（见 `./policy.ts`）。 */
  readonly blobThreshold: number
}

/**
 * 一条工具结果的**落账形态**——两样输出各归其位（见文件头注）：
 * `text` → 条目正文（面向模型）· `content` → 条目载荷（记录侧形态）。
 *
 * **为何不直接收 `ToolResult`**——违约路径（工具域抛异常，见 `./agent-loop.ts`）造不出
 * 一份 `ToolResult`：链引用 `callRef` 在违约路径上**无从取得**（`tool.call` 事件由工具域发，
 * 本域没见过）。落账只用到这两样，中间的形态差由本类型吸收——**不编造链引用**。
 */
export type ToolOutcome = {
  readonly ok: boolean
  /** 面向模型的文本——条目正文（重放时逐字复原模型看到的那份）。 */
  readonly text: string
  /** 记录侧形态——条目载荷（与该次 `tool.result` 事件的 `output` 同物）。 */
  readonly content: Content
  /**
   * **这次调用交付了一份技能主文**（U33）——只有读技能的那件工具会带（从 `ToolResult` 原样过来）。
   *
   * 落进条目载荷，为的是**自主选用那一路也留下来源身份**：没有它的话，
   * 日后要认「这一轮读的是哪个技能」就只能去抠回填正文的抬头（那是拿一句给人看的文案
   * 当跨域协议）。显式那一路的身份在 `UserPayload`，这一路在这条载荷上，两处各记各的账。
   */
  readonly skill?: UsedSkill
  /**
   * **这一次调用交付了一份计划更新**（U34）——从 `ToolResult.plan` 原样过来
   * （见契约那一格：`null` ＝ 清空，与「没有这一位」分得开）。
   *
   * 它落进条目载荷（`ToolResultPayload.plan`），而**条目落账是它唯一的写点**：
   * 更新工具不自行写记录、事件也晚于这一步才发（见 `agent-loop.ts` 的 `plan.changed`）。
   */
  readonly plan?: PlanNote | null
  /**
   * **压根没跑**（规约重审扣下 / 材料超限停批——本域唯一的两种产生处，见 `agent-loop.ts`
   * 的 `withholds`）。`ok` 分不开「没有开始」与「跑了没成」，故另记一位，与事件同源。
   * 缺省 ＝ 未标（工具域回来的结果都不是它）。
   */
  readonly notExecuted?: true
}

/** 端口结果 → 落账形态——两样输出各取各的，改名不改义。 */
export function toolOutcomeOf(result: ToolResult): ToolOutcome {
  return {
    ok: result.ok,
    text: result.output,
    content: result.content,
    // 交付身份**原样过手**（有就带、没有就不带——不补 `undefined` 占位）
    ...(result.skill === undefined ? {} : { skill: result.skill }),
    // 计划载荷同理——⚠️ 判 `undefined`（不在场）而非真假：`null` 是**清空**
    ...(result.plan === undefined ? {} : { plan: result.plan }),
  }
}

/**
 * 正文条目（`user` / `assistant`）——落账并回 id（事件按它引用这条内容）。
 *
 * `payload` **只有 `assistant` 用得上**（U41：供应商要求回传的那份思考）——
 * 给了才写那一位，不给就与加它之前逐字同形（旧记录照读）。
 */
export async function appendTextEntry(
  log: EntryLog,
  kind: 'user' | 'assistant',
  text: string,
  payload?: AssistantPayload,
): Promise<RecordId> {
  return log.records.appendEntry({
    kind,
    content: await contentOf(text, log),
    ...(payload === undefined ? {} : { payload }),
    at: log.now(),
  })
}

/**
 * **用户交代**条目（U33 起，U36 加成）——正文是用户的话，载荷是随它一起送出去的材料。
 *
 * 两处各归其位（与工具条目**反着来**，理由见契约 `UsedSkillEntry`）：用户条目的正文
 * 用户自己也要读（屏上那一行就是他说的话），几 KB 的技能正文拼进去，恢复会话时那面墙
 * 就顶在眼前；而载荷不进屏、进上下文。
 *
 * ## 两个键：`refs`（新形）与 `skills`（旧形）
 *
 * - `refs`（U36）——**带位置**、有序，正文里那一句原话照着次序展开（见 `InputRefEntry`）；
 * - `skills`（U33 旧形）——**只有旧调用方**（无人值守脚本的 `{ skills }`）还走它，
 *   照旧不带位置。两形**不互相转换**：给旧输入编一个 `at: 0` 就是伪造原插入点。
 *
 * **一份材料都没有时一字不多**（两个数组都空就不写 `payload` 这个键）：纯文本交代的条目
 * 与加这一条之前逐字同形——旧库照读，旧用例照绿（验收第一条：「现有纯文本输入兼容」）。
 */
export async function appendUserEntry(
  log: EntryLog,
  text: string,
  input: { readonly refs?: readonly InputRefEntry[]; readonly skills?: readonly UsedSkillEntry[] },
): Promise<RecordId> {
  const refs = input.refs ?? []
  const skills = input.skills ?? []
  const payload =
    refs.length === 0 && skills.length === 0
      ? undefined
      : {
          ...(refs.length === 0 ? {} : { refs }),
          ...(skills.length === 0 ? {} : { skills }),
        }

  return log.records.appendEntry({
    kind: 'user',
    content: await contentOf(text, log),
    ...(payload === undefined ? {} : { payload }),
    at: log.now(),
  })
}

/**
 * 工具调用条目——`{ name, args }` 载荷。
 * 与后续的结果条目**成对**：「有调用无结果」＝在途（阶段 2 恢复的判据）。
 */
export function appendToolCallEntry(log: EntryLog, call: ToolCall): RecordId {
  return log.records.appendEntry({
    kind: 'tool-call',
    content: { text: '' },
    payload: { name: call.name, args: call.args },
    at: log.now(),
  })
}

/**
 * 工具结果条目——正文取面向模型的文本、载荷取记录侧形态（见 `ToolOutcome`）。
 *
 * `notExecuted` **只在这一处往载荷里写**，且只在给出来时写（缺省不留位——与事件侧同口径：
 * 「没这一位」本身就是一条信息，别拿 `false` 占位）。
 *
 * **计划更新也在这儿落地**（U34）——「工具只核对参数、由对话域一次落账」这句话的落点：
 * 更新工具交回载荷（`ToolOutcome.plan`），结果与计划字段**同一次**进这条条目；
 * 写入侧的硬闸（`@magic/records`）照旧把关，形状不对连条目都落不下去。
 * ⚠️ **清空要写出 `plan: null` 这个键**（不是省略）——省略就是「这次跟计划无关」。
 */
export function appendToolResultEntry(log: EntryLog, outcome: ToolOutcome): RecordId {
  return log.records.appendEntry({
    kind: 'tool-result',
    content: { text: outcome.text },
    payload: {
      ok: outcome.ok,
      output: outcome.content,
      ...(outcome.skill === undefined ? {} : { skill: outcome.skill }),
      ...(outcome.plan === undefined ? {} : { plan: outcome.plan }),
      ...(outcome.notExecuted === undefined ? {} : { notExecuted: outcome.notExecuted }),
    },
    at: log.now(),
  })
}

/**
 * 摘要条目——压缩的产物（技术方案 · 上下文压缩：「旧段交模型生成摘要 → 以 `summary`
 * 条目入库」）。
 *
 * 它与别的条目**同待遇**：正文超阈值照样转 blob（摘要也可能是长的），时间戳照样取
 * `log.now`。**只增不改**——旧段那些条目一条都不动，这条只是追加在末尾（append-only 不破）。
 */
export async function appendSummaryEntry(log: EntryLog, text: string): Promise<RecordId> {
  return log.records.appendEntry({
    kind: 'summary',
    content: await contentOf(text, log),
    at: log.now(),
  })
}

/** 正文 → 内容——超阈值转 blob（规则 ②：大负载落 blob）；**写权唯一归记录域**（经其公开面）。 */
async function contentOf(text: string, log: EntryLog): Promise<Content> {
  if (text.length <= log.blobThreshold) return { text }

  return { blob: await log.records.blobs.put(text) }
}
