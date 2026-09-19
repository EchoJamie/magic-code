/**
 * 记录库——`RecordsService` 的实现（判据 1–6 的落点）。
 *
 * 出处：技术方案 · 记录（存储 · 数据落点）· 领域划分（`RecordsService`）。
 *
 * **一处形态缺口，按规约 4 自决（只增不改）**——契约的 `appendEntry(entry: NewEntry)`
 * 入参**不带会话**，而 `readEntries(sessionId)` 按会话读；条目形态（`entries.ts`）里
 * 也没有会话字段（那是「来源引用」`source`，属协作预留，另有所指）。故写入侧的会话归属
 * 只能由**实例**承载：`store.serviceFor(session)` 取一个会话实例，其 `appendEntry`
 * 落进该会话，其 `appendEvent` 校验信封的 `session` 与之一致（不一致＝跨会话串线，拒）。
 *
 * 这与设计的其它条款同向：装配按会话实例构造（`EventStamper` 亦然）· 构造与资源引用
 * 按实例化设计（多智能体预留：多会话并行＝多实例）。见回报「待决」。
 *
 * **U16 补的三件**（会话面——技术方案 · 会话与多会话）：
 * - `latestSession()`——启动流转「接着最近一条」的取材口（与 `listSessions` 同一个序）；
 * - `setSessionTitle()`——**改过的标题**落 `sessions.title` 列（默认标题由对话域现算，不落库）；
 * - `appendEvent(event)`——**按信封分束**的落库口（多会话之后扇出是进程级的，
 *   装配不必再维护一份「哪条会话用哪个实例」）。
 *
 * **U26 补的一件**（会话归属工作区——词典 · Workspace / Session）：
 * `sessions` 加 `workspace` 列，**建立时锚定 · 随记录持久**——锚定落在 `ensureSession`
 * 那一句（首写即建会话，就是「首条消息按下回车」那一下）；`ON CONFLICT DO NOTHING`
 * 保证此后换目录再开同一会话也改不动它。**为何归属随构造而落**、**为何记整组根**，
 * 见 `RecordsStoreOptions.workspace`。
 *
 * **fs 直触**——本域是内核仅有的两处之一（技术方案 · 代码治理 · 边界纪律）；
 * 库文件与 blob 目录都在本文件落下（`bun:sqlite` ＋ `node:fs/promises`）。
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BlobStore,
  DecisionHistory,
  Entry,
  EntryRange,
  EventDataOf,
  KernelEvent,
  NewEntry,
  RecordId,
  RecordsService,
  SessionId,
  SessionSummary,
  Timestamp,
} from '@magic/contracts'
import { BLOBS_DIR, createBlobStore } from './blobs.ts'
import { assertEntryShape, entryOfRow, entryParamsOf, type EntryRow } from './entries.ts'
import { eventOfRow, eventParamsOf, isTransientEvent, type EventRow } from './events.ts'
import { scanForRecovery, type RecoveryScan } from './recovery.ts'
import { createIdSpace } from './ids.ts'
import {
  ENTRIES_TABLE,
  EVENTS_TABLE,
  SESSIONS_TABLE,
  SESSION_WORKSPACE_COLUMN,
  initSchema,
  type NamedParams,
} from './schema.ts'

/** 库文件名——`<dataDir>/records.db`（技术方案 · 记录 · 存储）。 */
export const DATABASE_FILE = 'records.db'

/**
 * 分页读的块大小——**keyset 分页**（按 id 往后挪），不用活游标：
 * `bun:sqlite` 的 `.iterate()` 在迭代期间独占连接，而「读日志」与「写日志」
 * 在同一个连接上交替（循环边读边写）——块读每块一条语句、取完即散，没有这个互斥。
 * 顺带把内存也钉在常数上（恢复 / 审计要读长会话）。
 */
const READ_CHUNK = 512

/** `sessions` 的一行（`title` / `workspace` 可空——没写过就没有）。 */
type SessionRow = {
  readonly id: string
  readonly at: number
  readonly title: string | null
  readonly workspace: string | null
}

/**
 * 会话的两个查询**共用一个序**（`at` 降序、同刻按 id 升序）——`listSessions` 与
 * `latestSession` 各写一份的话，启动落点与列表头名迟早分叉。
 */
function sessionSelect(): string {
  return `SELECT id, at, title, workspace FROM ${SESSIONS_TABLE} ORDER BY at DESC, id ASC`
}

/** 行 → 摘要：标题 / 工作区**缺席即不给键**（不是空串 / 空数组——缺席可辨，空值不可辨）。 */
function summaryOf(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    at: row.at,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.workspace === null ? {} : { workspace: parseWorkspace(row.workspace) }),
  }
}

/** 工作区列的落盘形态＝JSON 一列（同 `events.data` 的姿势）——读回即那组根。 */
function parseWorkspace(column: string): readonly string[] {
  return JSON.parse(column) as readonly string[]
}

/** 装配期构造入参——数据目录与**本进程的工作区**（其余选择归装配根）。 */
export type RecordsStoreOptions = {
  /**
   * 数据落点。**须是字面路径**——前导 `~` 的展开归配置加载器
   * （`@magic/contracts` · `expandHome`），本库不展开（见 `assertPlainDataDir`）。
   */
  readonly dataDir: string
  /**
   * **本进程工作的那个工作区**（U26）——会话**建立时锚定**的就是它：库里这一列只在
   * **建行那一次**写（`ON CONFLICT DO NOTHING`），故此后的启动目录改了也改不到它。
   *
   * 形态＝执行域 `roots()` 给的**那组根**（`realpath` 后的规范形 · 声明序，`[0]` 默认根）。
   * **为何是整组而不是默认根**：这一列的用处是**恢复回到原位**——只记默认根，多根工作区
   * 就重建不回去（词典 · Workspace：「≥ 1 条路径的联合作用域」，`U18` 多根已落地）。
   *
   * **归属为何随构造而落、不由每次写入带**：工作区是**进程级**的（配置 `workspaceRoots`
   * 在则整组接管，缺省则回落启动目录——两者都在装配那一刻定死），同一进程里开的会话
   * 同属一个工作区。带上它写进本域，是为了让「建立时锚定」**有处可落**——建行的动作在
   * 本域的事务里（首写即建会话，`D5`）。
   *
   * 本域**不当它是工作区**：只当作一列 JSON 存下、读回（根合不合格归执行域，
   * 见 `@magic/contracts` · `WorkspaceRoots`：一个真源，别处不重判一遍）。
   */
  readonly workspace: readonly string[]
}

/**
 * 记录库（域侧把手）——库文件与 blob 目录的**唯一持有者**。
 * 会话实例经 `serviceFor` 取（条目写入的会话来处，见文件头注）。
 */
export type RecordsStore = {
  serviceFor(session: SessionId): RecordsService
  /**
   * **按会话读条目**——**不经会话实例**（第 19 轮补）。
   *
   * 由头：会话**懒建立**之后，装配手上可能还没有一条会话实例（首条消息才开张），
   * 而目录、首条消息摘要、读面（`history.read` 的重建展示）都要按 id 读条目。
   * 写入仍走实例（会话归属由实例承载，见文件头注）；**读**没有那个约束。
   */
  readEntries(session: SessionId, range?: EntryRange): AsyncIterable<Entry>
  /**
   * **blob 存取**（写权唯一归本域）——**不经会话实例**：blob 引用与会话无关
   * （它是记录域内部键，契约里对消费者不透明）。会话未定时取回正文要用它（读面同例）。
   */
  readonly blobs: BlobStore
  listSessions(): Promise<readonly SessionSummary[]>
  /**
   * **裁决的历史累计**（U28 · `B10` 口径的跨会话面）——本工作区的会话们走过的全部裁决，
   * 按 `decider` 分成两格（见 `DecisionHistory`）。
   *
   * 由头：权限域那个 `GateTally` 是**本会话**的数（闸门按会话实例构造），只够看
   * 「这一趟顺不顺」；**「这个项目值不值得配规则」得跨会话**——故这条读面在库里数
   * （`tool.decision` 事件本就在这儿，裁者在事件上）。
   *
   * **范围＝本工作区**：`dataDir` 是全局的（`~/.magic`），库里住着不止一个项目——
   * 数进来的只有**归属对得上的那些会话**（`sessions.workspace` 那一列，U26）。
   * ⚠️ **归属缺席的会话不计**（加列之前落账的那些：它们属于哪个工作区**无法知道**，
   * 拿当下这个顶上去就是编——同 `schema.ts` 里那条注）。
   *
   * **同步**（同 `latestSession` / `nextId`）：本地 `bun:sqlite` 本就是同步的；
   * 它不是端口面（不随会话实例、也不进 `RecordsService`），跨进程那道缝日后要接
   * 另说——不先替它背一副异步壳。
   */
  decisionHistory(): DecisionHistory
  /**
   * **这条会话在不在库里**（U28）——入口 `--session <id>` 那道校验的取材。
   *
   * 判据就是**库里有没有这一行**：会话**首写即建**（`D5`：首条消息按下回车才落库），
   * 故「不在库里」就是「**没有这条会话**」——打错的 id、从没落过账的 id 都在此列
   * （`/session new` 之后没写过话的那条空壳也**不在**：它还没有可接的东西）。
   *
   * 由头：`--session s-typo` 原先照 id 装载一条**空的**——用户以为接上了，其实没有。
   * 校验放在**入口**（报错不降级），此处只答「在不在」，**不判该不该**。
   */
  hasSession(session: SessionId): boolean
  /**
   * **最近一条会话**——启动流转「接着最近一条」的取材口（U16）；库里没有会话则 `undefined`。
   *
   * 与 `listSessions()` 同一个序（`at` 降序、同刻按 id），故恒等于它的第一条
   * ——两处若各写一个序，启动落点与列表头名就会分叉。
   * ⚠️ 同步：本地 `bun:sqlite` 本就是同步的（`nextId` 同例）；端口那面保持异步是为远端留缝。
   */
  latestSession(): SessionId | undefined
  /**
   * **按信封分束落一条事件**（U16）——给**装配的扇出**用。
   *
   * 由头：多会话之后扇出是**进程级**的（一个 `EventSink` 服务所有会话），而写事件原先
   * 只能经 `serviceFor(session)` 那条会话实例——扇出于是得自己维护「哪条会话用哪个实例」，
   * 那份对应关系与信封里的 `session` 是同一件事，维护它就是**第二真源**。
   * 此处直接按信封分束：一件事实，一处判定。
   *
   * 与 `serviceFor(session).appendEvent` 的关系：后者多一道**实例绑定校验**
   * （跨会话串线即拒）——域内调用者用那条更严；扇出这条按信封走，天然不会串。
   */
  appendEvent(event: KernelEvent): void
  /**
   * **写会话标题**（U16 · 技术方案 · 会话与多会话：标题可改）——
   * 只存「改过的」，默认标题（首条消息摘要）由对话域现算。
   *
   * `at` 由调用方给（**记录域不取时钟**——同条目 / 事件的纪律）：目标会话还没有行时
   * 用它建行（用户明确命名了一条会话，那一下就是它头一次落地）。
   */
  setSessionTitle(session: SessionId, title: string, at: Timestamp): void
  /**
   * **恢复查询面**（技术方案 · 领域划分：在途识别由本域提供）——一次扫描说全
   * 「要处置什么」：在途调用（有 `tool.call` 无 `tool.result`）· 中断的轮 · 轮号水位。
   *
   * 归本域的理由：两侧的来处都在库里（事件侧给裁决轨迹、条目侧给配对），
   * 而**判据只有一份**——放这儿，别家（应用层的恢复用例）就不必各写一遍。
   * 扫描**只读不判**：处置（重放 / 落账）归应用层（`@magic/actions`）。
   *
   * ⚠️ 与端口上的 `RecordsService.scanInFlight` 是**同一个函数的两张面孔**（U25）：
   * 那是**生产路径**（恢复的编排搬去应用层之后，装配给它的就是这个端口面，见下 `serviceFor`）；
   * 域侧这一张留着给本包的用例与验收脚本用（按 id 直取，不必先造一个会话实例）。
   * 两处都指向 `runRecoveryScan` 一处实现——形态漂不了。
   */
  recoveryScan(session: SessionId): Promise<RecoveryScan>
  /** 关连接（blob 无需收尾）。 */
  close(): void
  /** 落点（验收查询脚本 / 装配期日志用）。 */
  readonly paths: { readonly database: string; readonly blobs: string }
}

export function createRecordsStore(options: RecordsStoreOptions): RecordsStore {
  const dataDir = assertPlainDataDir(options.dataDir)
  mkdirSync(dataDir, { recursive: true })

  const blobsDir = join(dataDir, BLOBS_DIR)
  mkdirSync(blobsDir, { recursive: true })

  const databasePath = join(dataDir, DATABASE_FILE)
  const db = new Database(databasePath, { create: true })
  // WAL ＋ NORMAL：读者不挡写者（循环边写边读）；应用崩溃不丢已提交（「崩溃 / 重启后的重建依据」）。
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  initSchema(db, databasePath)

  const ids = createIdSpace(db)
  const blobs = createBlobStore(blobsDir)

  // —— 语句（`query` 走缓存；参数一律具名，免得列序漂移悄悄错位）——
  //
  // 首写即建会话（D5：会话在首条消息时才建立）——**工作区就在这一句里锚下**，此后
  // `DO NOTHING`：换目录再开同一会话，那一次写入碰不到这一列（归属在建立时定死）。
  const workspaceColumn = JSON.stringify(options.workspace)
  const ensureSession = db.query<never, [string, number, string]>(
    `INSERT INTO ${SESSIONS_TABLE} (id, at, ${SESSION_WORKSPACE_COLUMN}) VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
  )
  const insertEntry = db.query<never, [NamedParams]>(
    `INSERT INTO ${ENTRIES_TABLE}
       (id, session, kind, content_kind, content_text, content_blob, payload, at, source)
     VALUES ($id, $session, $kind, $contentKind, $contentText, $contentBlob, $payload, $at, $source)`,
  )
  const insertEvent = db.query<never, [NamedParams]>(
    `INSERT INTO ${EVENTS_TABLE} (id, session, turn, at, kind, data)
     VALUES ($id, $session, $turn, $at, $kind, $data)`,
  )
  const selectEntries = db.query<EntryRow, [string, number, number, number]>(
    `SELECT id, session, kind, content_kind, content_text, content_blob, payload, at, source
       FROM ${ENTRIES_TABLE}
      WHERE session = ? AND id > ? AND id <= ?
      ORDER BY id
      LIMIT ?`,
  )
  const selectEvents = db.query<EventRow, [string, number, number]>(
    `SELECT id, session, turn, at, kind, data
       FROM ${EVENTS_TABLE}
      WHERE session = ? AND id > ?
      ORDER BY id
      LIMIT ?`,
  )
  // 历史累计（U28）：两条判据都在这一句里——**是裁决**（`kind`）× **是本工作区的会话**
  // （`sessions.workspace` 那一列，归属缺席的不进子查询）。全表扫一遍：`events` 上没有
  // kind 索引，而 `kind` 又不是分页条件——本读面是「开抽屉时问一次」，不逐帧跑。
  const selectDecisions = db.query<{ data: string }, [string]>(
    `SELECT data FROM ${EVENTS_TABLE}
      WHERE kind = 'tool.decision'
        AND session IN (SELECT id FROM ${SESSIONS_TABLE} WHERE ${SESSION_WORKSPACE_COLUMN} = ?)`,
  )
  const selectSessions = db.query<SessionRow, []>(sessionSelect())
  const selectSessionExists = db.query<{ one: number }, [string]>(
    `SELECT 1 AS one FROM ${SESSIONS_TABLE} WHERE id = ? LIMIT 1`,
  )
  const selectLatest = db.query<{ id: string }, []>(`${sessionSelect()} LIMIT 1`)
  // 改名：有行即就地更新，没行即建行（`at` ＝改名那一刻——建行不另取时钟，用调用方给的）
  const upsertTitle = db.query<never, [string, number, string]>(
    `INSERT INTO ${SESSIONS_TABLE} (id, at, title) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title`,
  )

  // 一次写入＝一个事务：会话表先落（首写即建会话，`at` 用该次写入的时间——不另取时钟），
  // 条目 / 事件随后。半截写入不会留下「有行无会话」的孤儿。
  const writeEntry = db.transaction((session: SessionId, entry: NewEntry, id: RecordId): void => {
    ensureSession.run(session, entry.at, workspaceColumn)
    insertEntry.run(entryParamsOf(id, session, entry))
  })
  const writeEvent = db.transaction((event: KernelEvent): void => {
    ensureSession.run(event.session, event.at, workspaceColumn)
    insertEvent.run(eventParamsOf(event))
  })

  function appendEntry(session: SessionId, entry: NewEntry): RecordId {
    assertEntryShape(entry) // 硬闸在取号之前——不合形态的条目连号都不吃
    // **号在事务外取**：取号可能触发一次水位预留（写库）——若在事务内，写失败回滚会连
    // 水位一起回滚，而内存窗口已经推进，重启 / 后续预留便会**重发已发过的号**。
    // 代价只是失败时留个空档——单调性与唯一性都比「号连续」要紧。
    const id = ids.next()
    writeEntry(session, entry, id)
    return id
  }

  function appendEvent(session: SessionId, event: KernelEvent): void {
    if (isTransientEvent(event.kind)) return // 规则 ①：流式增量不落库
    if (event.session !== session) {
      throw new Error(
        `事件信封的 session（${event.session}）与服务实例绑定（${session}）不一致——` +
          `信封由产出方按会话实例铸（技术方案 · 领域划分 · 信封的归属），跨会话串线此处即拒`,
      )
    }
    writeEvent(event)
  }

  /** keyset 分页——每块一条语句，取完即散（无活游标）。 */
  async function* paginate<Row extends { readonly id: number }, T>(
    fetch: (after: number) => readonly Row[],
    map: (row: Row) => T,
  ): AsyncGenerator<T> {
    let after = 0
    for (;;) {
      const rows = fetch(after)
      if (rows.length === 0) return
      for (const row of rows) yield map(row)

      const last = rows.at(-1)
      if (last === undefined || rows.length < READ_CHUNK) return
      after = last.id
    }
  }

  function readEntries(sessionId: SessionId, range?: EntryRange): AsyncIterable<Entry> {
    assertSessionId(sessionId)
    // 闭区间含端点：`from ≤ id ≤ to`；缺省＝该端不限。倒挂（from > to）自然读空。
    const floor = range?.from === undefined ? 0 : range.from - 1
    const ceiling = range?.to ?? Number.MAX_SAFE_INTEGER

    return paginate(
      (after) => selectEntries.all(sessionId, Math.max(after, floor), ceiling, READ_CHUNK),
      entryOfRow,
    )
  }

  function readEvents(sessionId: SessionId): AsyncIterable<KernelEvent> {
    assertSessionId(sessionId)
    return paginate(
      (after) => selectEvents.all(sessionId, after, READ_CHUNK),
      eventOfRow,
    )
  }

  /** 会话列表——写入过的会话各现一次，最近在前（同刻按 id 定序，结果稳定）。 */
  async function listSessions(): Promise<readonly SessionSummary[]> {
    return selectSessions.all().map(summaryOf)
  }

  /** 最近一条——与 `listSessions()` 同序（见端口注：两处一个序，启动落点才与列表头名一致）。 */
  function latestSession(): SessionId | undefined {
    return selectLatest.get()?.id
  }

  /**
   * 裁决的历史累计（见 `RecordsStore.decisionHistory` 那条注）——
   * **数出来的只有两格**：走了几次裁决、其中几次没问就放行（`decider: 'auto'`）；
   * 「还得你点」是差，不另存一位（三个数里两个数得出来，第三个就不该再存一遍）。
   */
  function decisionHistory(): DecisionHistory {
    let total = 0
    let auto = 0

    for (const row of selectDecisions.all(workspaceColumn)) {
      const data = JSON.parse(row.data) as EventDataOf['tool.decision']
      total += 1
      if (data.decider === 'auto') auto += 1
    }

    return { total, auto }
  }

  /** 在不在库里（见 `RecordsStore.hasSession`）——一行存在即「在」。 */
  function hasSession(session: SessionId): boolean {
    return selectSessionExists.get(session) !== null
  }

  function setSessionTitle(session: SessionId, title: string, at: Timestamp): void {
    assertSessionId(session)
    upsertTitle.run(session, at, title)
  }

  /**
   * 恢复扫描——两侧各读一遍（分页读，见 `READ_CHUNK`），判定交给 `scanForRecovery`。
   * 先事件后条目：判据在事件侧（链引用），条目侧只补配对。
   */
  async function runRecoveryScan(session: SessionId): Promise<RecoveryScan> {
    const events: KernelEvent[] = []
    for await (const event of readEvents(session)) events.push(event)

    const entries: Entry[] = []
    for await (const entry of readEntries(session)) entries.push(entry)

    return scanForRecovery({ session, events, entries })
  }

  return {
    paths: { database: databasePath, blobs: blobsDir },

    serviceFor(session: SessionId): RecordsService {
      assertSessionId(session)
      return {
        nextId: () => ids.next(),
        appendEntry: (entry) => appendEntry(session, entry),
        appendEvent: (event) => appendEvent(session, event),
        readEntries: (sessionId, range) => readEntries(sessionId, range),
        readEvents: (sessionId) => readEvents(sessionId),
        // 在途识别（恢复 ①）——**端口面**（U25）：恢复的编排搬去应用层之后，消费方
        // 够不着 `RecordsStore` 那把把手（域外只认端口）。与 `readEvents` 同例：方法收 id。
        scanInFlight: (sessionId) => runRecoveryScan(sessionId),
        listSessions,
        blobs,
      }
    },

    readEntries,
    blobs,

    listSessions,
    latestSession,
    decisionHistory,
    hasSession,
    setSessionTitle,
    appendEvent: (event) => appendEvent(event.session, event),
    recoveryScan: runRecoveryScan,

    close(): void {
      db.close()
    },
  }
}

/**
 * `dataDir` 只收**字面路径**——前导 `~` 的展开归配置加载器（`expandHome`），本库不展开。
 *
 * ⚠️ 已踩过的坑：字面 `~` 直接交给运行时库会在 **cwd 下造一个名为 `~` 的目录**，
 * 不报错、且回环测试全绿（读写都在同一个错位置）。故此处**拒绝**而非放行——
 * 把静默错位换成一声响（能靠设计兜底的，别靠自觉）。
 */
function assertPlainDataDir(dataDir: string): string {
  if (dataDir.trim() === '') {
    throw new Error('dataDir 不得为空——数据落点须由配置加载器给出（技术方案 · 配置与密钥）')
  }
  if (dataDir === '~' || dataDir.startsWith('~/')) {
    throw new Error(
      `dataDir 含前导 \`~\`（${dataDir}）——记录库**不展开** \`~\`：展开归配置加载器` +
        `（@magic/contracts · expandHome），库只写字面路径。直通运行时库会静默落到 ` +
        `cwd 下的 \`~\` 目录（错误位置且不报错）——故此处拒绝。`,
    )
  }
  return dataDir
}

/** 会话 id 是事件分束的键——空串不是会话。 */
function assertSessionId(session: SessionId): void {
  if (session === '') {
    throw new Error('session 不得为空——SessionId 是事件分束的键（技术方案 · 记录 · 信封）')
  }
}
