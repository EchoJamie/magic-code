/**
 * **会话主面** —— `ConversationService` 的落地（技术方案 · 会话与多会话）。
 *
 * 设计原话（技术方案 · 领域划分 · 端口签名）：「`interface ConversationService { … }
 * // 多会话（阶段 2）的新建 / 切换 / 列表在此扩展」——故**端口实现在这里**，
 * 它持一个活跃会话（**单活跃**），`submit` / `interrupt` 转发过去；
 * 一条会话的实例在 `./service.ts`（名字取 `ConversationSession`，免得与端口撞脸）。
 *
 * ## 三件在管
 *
 * - **列表**——目录来自记录域（`listSessions`），标题两路：**改过的取存值**、
 *   没改过的**按首条用户消息现算**（技术方案 · 会话与多会话：标题＝首条消息摘要）。
 *   两路都没有（没有用户消息 / 读不出）就**缺席**——不拿空串占位（缺席可辨，空串不可辨）。
 *   派生物**不落库**：存两份迟早分叉（改过的那份才落 `sessions.title`）。
 * - **切换**——**只是装载**：换一条实例链（记录实例 / 铸造器 / 闸门 / 工具域随会话各一份，
 *   由装配的 `open` 工厂给）。**上下文不用搬**——它每轮由条目重建（`./context.ts`），
 *   所以「装载」这件事在实现上就是「换一条实例」。**与恢复是两条路径**：处置在途操作
 *   是 `recover()` 的活（启动流转那一路），本命令不捎带。
 * - **改名**——写面归记录域（`setTitle`）；用户给的原文在此**裁剪 / 归一**（首行 · 折叠空白 ·
 *   超长截断），空标题不认。
 *
 * ## 三条纪律
 *
 * ① **单活跃**——同一时刻一个活跃会话。**忙时切不动**：一轮在跑时新建 / 切换一律驳回
 *   （出声说明），不半途改——半途切会让一轮的事记到两条会话上（`records.appendEvent` 按
 *   实例校验信封的 `session`，那种情形当场抛，但**别让它走到那一步**）。列表照问（只读）。
 * ② **切换 ≠ 恢复**——见上。
 * ③ **结果走事件**（`session.state`）：命令面只发不收（既有姿势），故三支命令的答复
 *   都是这一条事件；外壳据 `active` 变化决定是否重开一屏。**不做的事**不报（切到当前
 *   会话＝无事，一个事件都不发——「没切」就没什么可说的）。
 */

import type {
  ConversationService,
  EventSink,
  EventStamper,
  RecordsService,
  SessionCommand,
  SessionId,
  SessionSummary,
  Timestamp,
} from '@magic/contracts'
import type { ConversationSession } from './service.ts'
import type { RecoveryReport } from './recovery.ts'

/** 默认标题的字符上限——「首条消息摘要」的**实现级常量**（措辞可调，见回报备案）。 */
export const TITLE_LIMIT = 40

/**
 * 一条会话的**实例束**——装配的 `open` 工厂给。
 *
 * 三件同源：**铸造器按会话实例构造**（契约 · 信封的归属：上下文 `session` 由铸造器持），
 * 故它随实例一起来，不由主面另取。
 */
export type SessionInstance = {
  readonly session: SessionId
  readonly service: ConversationSession
  readonly stamper: EventStamper
}

/** 会话主面的构造入参——一切「谁来实现」的选择由装配根给出。 */
export type SessionHostDeps = {
  /** **开局会话**——装配按「启动流转」定好（接着最近一条；一条都没有则新造）。 */
  readonly session: SessionId
  /**
   * **开一条会话的实例链**——装配给（只有它知道怎么造记录实例 / 铸造器 / 闸门 / 工具域）。
   *
   * 每次切换都会调一次：单活跃，所以旧实例就此搁下（**不缓存**——「一个活跃会话」是结构，
   * 不是计数；代价如实记：切回来时闸门的会话级「总是允许」记忆不复原，与「新会话清零」同源）。
   */
  readonly open: (session: SessionId) => SessionInstance
  /** 记录域端口——目录（`listSessions`）与首条消息（`readEntries`）。 */
  readonly records: RecordsService
  /**
   * **标题写面**——记录域的**结构超集**（`RecordsService` 端口是只读面）。
   * 装配接 `(s, t, at) => store.setSessionTitle(s, t, at)`。
   */
  readonly setTitle: (session: SessionId, title: string, at: Timestamp) => void
  readonly sink: EventSink
  /** 时钟——条目时间戳与「当前会话」的落点（记录域不取时钟）。 */
  readonly now: () => Timestamp
  /** 默认标题的字符上限——缺省 `TITLE_LIMIT`。 */
  readonly titleLimit?: number
}

/**
 * 会话主面 ＝ 端口 ＋ 三件域外看不见的（控制面的入口、启动流转、活跃位读数）。
 *
 * `recover()` 的返回是**具体的报告**（域内形态）而不是端口上的 `unknown`——
 * 返回值协变，结构上仍满足 `ConversationService`。
 */
export type SessionHost = Omit<ConversationService, 'recover'> & {
  recover(): Promise<RecoveryReport>
  /**
   * 控制面的会话命令入口（`CommandRoutes.onSession` 的落点）。
   *
   * 返回那趟活的 promise——**命令面照旧不等**（`onSession` 的签名是 `void`，返回它即弃），
   * 而测试与调用方拿得到「跑完了」这个把手。不给的话，用例只能靠轮询猜，那是测试的噪声。
   */
  handle(command: SessionCommand): Promise<void>
  /** 当前活跃会话（单活跃）。 */
  active(): SessionId
}

/** 一次动作的收场——`undefined` ＝**无事可说**（不发事件）。 */
type Attempt = {
  readonly session: SessionId
  /** 有事要说时给（忙时切不动 / 标题空）——不给＝顺顺当当。 */
  readonly note?: string
}

const BUSY_NOTE = '正在跑一轮——先 Ctrl+C 中断，再切会话（同一时刻只有一个活跃会话）'
const EMPTY_TITLE_NOTE = '标题为空——会话名不能是空的（原来那个不动）'

/** 造会话主面——`ConversationService` 的落地。 */
export function createConversationService(deps: SessionHostDeps): SessionHost {
  const limit = deps.titleLimit ?? TITLE_LIMIT
  let active = deps.open(deps.session)

  // —— 目录（列表 ＋ 标题）——

  /**
   * 会话目录——最近在前。**当前会话总在列**：一条还没落账的新会话也该看得见自己
   * （否则 `/session` 刚建完就问「有哪些会话」，屏上却没有它）。
   */
  async function catalog(): Promise<readonly SessionSummary[]> {
    const rows = await deps.records.listSessions()
    const titled = await Promise.all(rows.map(withTitle))
    if (titled.some((row) => row.id === active.session)) return titled

    return [{ id: active.session, at: deps.now() }, ...titled]
  }

  /** 标题：改过的取存值；没改过的按首条用户消息现算。 */
  async function withTitle(row: SessionSummary): Promise<SessionSummary> {
    if (row.title !== undefined) return row

    const derived = await derivedTitle(row.id)
    return derived === undefined ? row : { ...row, title: derived }
  }

  /** 首条**用户**消息的摘要——条目按序读，见着第一条就收（后面不必读）。 */
  async function derivedTitle(session: SessionId): Promise<string | undefined> {
    for await (const entry of deps.records.readEntries(session)) {
      if (entry.kind !== 'user') continue

      return summarize(await textOf(entry.content), limit)
    }

    return undefined
  }

  /** 条目内容 → 文本（blob 引用取回；记录只存引用，正文归取回方——同上下文装配的姿势）。 */
  async function textOf(content: { readonly text: string } | { readonly blob: string }): Promise<string> {
    if ('text' in content) return content.text

    return new TextDecoder().decode(await deps.records.blobs.get(content.blob))
  }

  // —— 三个动作（失败以 `note` 如实报，不静默）——

  /** 新建一条并切过去。 */
  function fresh(): Attempt {
    if (active.service.busy()) return { session: active.session, note: BUSY_NOTE }

    active = deps.open(crypto.randomUUID())
    return { session: active.session }
  }

  /** 切到某条会话——**只是装载**；已经在的那条＝无事。 */
  function switchTo(session: SessionId): Attempt | undefined {
    if (session === active.session) return undefined
    if (active.service.busy()) return { session: active.session, note: BUSY_NOTE }

    active = deps.open(session)
    return { session: active.session }
  }

  /** 改名——先裁后存；空标题不认（原来的不动）。 */
  function renameTo(session: SessionId, title: string): Attempt {
    const normalized = summarize(title, limit)
    if (normalized === undefined) return { session, note: EMPTY_TITLE_NOTE }

    deps.setTitle(session, normalized, deps.now())
    return { session }
  }

  // —— 事件（命令面的答复）——

  /** 报当前会话状态——目录 ＋ 活跃位（有事时附一句说明）。 */
  async function announce(attempt: Attempt): Promise<void> {
    const sessions = await catalog()

    deps.sink.emit(
      active.stamper.stamp('session.state', {
        active: active.session,
        sessions,
        ...(attempt.note === undefined ? {} : { note: attempt.note }),
      }),
    )
  }

  async function run(command: SessionCommand): Promise<void> {
    if (command.type === 'session.list') {
      await announce({ session: active.session })
      return
    }
    if (command.type === 'session.new') {
      await announce(fresh())
      return
    }
    if (command.type === 'session.open') {
      const attempt = switchTo(command.session)
      // 切到当前会话＝无事——「没切」就没什么可报的（外壳也不必重开一屏）
      if (attempt === undefined) return
      await announce(attempt)
      return
    }

    await announce(renameTo(command.session, command.title))
  }

  return {
    submit: (input) => active.service.submit(input),
    interrupt: () => active.service.interrupt(),

    /** 对**当前会话**跑一次恢复——启动流转（装配的 `boot` 就这一跳）。 */
    recover: () => active.service.recover(),

    listSessions: () => catalog(),

    async newSession(): Promise<SessionId> {
      const attempt = fresh()
      // 端口面「失败＝抛」（同沙箱「调用不成立用抛」的分寸）——命令面那条路把缘由说成 note
      if (attempt.note !== undefined) throw new Error(attempt.note)

      return attempt.session
    },

    async openSession(session: SessionId): Promise<void> {
      const attempt = switchTo(session)
      if (attempt?.note !== undefined) throw new Error(attempt.note)
    },

    async renameSession(session: SessionId, title: string): Promise<void> {
      const attempt = renameTo(session, title)
      if (attempt.note !== undefined) throw new Error(attempt.note)
    },

    handle(command: SessionCommand): Promise<void> {
      // 兜底——异常不吞：发 `error`（内核自身异常，产生方就近），否则命令石沉大海
      return run(command).catch((error: unknown) => {
        deps.sink.emit(
          active.stamper.stamp('error', { message: `会话面异常：${messageOf(error)}` }),
        )
      })
    },

    active: () => active.session,
  }
}

/**
 * 标题的裁法（默认标题与改名**共用一套**——两处各裁一遍＝两处迟早不一样）：
 * 首行起、折叠连续空白、超长截断加省略号；**空（裁完什么都没剩）＝`undefined`**。
 */
export function summarize(text: string, limit: number = TITLE_LIMIT): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return undefined

  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
