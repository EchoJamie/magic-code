/**
 * **读面命令**（T1.7 SRP 拆分）——不碰执行器、不落写账的分发与目录/历史读面。
 *
 * 从 `commands.ts` 分治出来（命令路由 vs 读面处理）：`installCommands` 保留路由壳与
 * 写面，这一份只做「读」——纯函数与读侧 if 链整体搬移，行为不变（同一提交纪律）。
 * `installReadCommands(ctx)` 与 `installCommands(ctx)` 同形：依赖同走 `ManagerContext`。
 */
import type { Command, TurnTimingEvent } from '@magic/contracts'
import type { ClientConn } from '../connections.ts'
import type { ManagerContext } from './context.ts'
import {
  CONTROL_DIRECTORY_LIMIT,
  CONTROL_FRAME_BUDGET_BYTES,
  CONTROL_PREVIEW_TEXT_BYTES,
  isTurnTimingEvent,
  pendingViews,
  type Entry,
  type KernelEvent,
} from '@magic/contracts'
import { clipEntryForWire, clipTextBytes, wireBytesOf } from '../wire-view.ts'
import { loadConfig } from '@magic/state'
import { createPlanReader, readSessionDisplayHistory } from '@magic/conversation'
import {
  memoryWorkspace,
  readMemory,
  readMemorySource,
  readReferenceSessions,
  workspaceOf,
} from '@magic/host'

/** 单条历史记录装得下的预算——超过就裁正文（保留开头并注明），别让一条旧记录撑破连接。 */
const HISTORY_ENTRY_BYTES = CONTROL_FRAME_BUDGET_BYTES / 2

/** 历史分批的字节预算——`CONTROL_FRAME_BUDGET_BYTES` 减末包余量（原 commands.ts 的常量随之）。 */
const HISTORY_BATCH_BYTES = CONTROL_FRAME_BUDGET_BYTES - 256 * 1024

/** 末包随附的元数据条数上限——timing 最近 1000 条、messages 最近 50 条、compactions 最近 20 条。 */
const HISTORY_META_TIMING = 1_000
const HISTORY_META_MESSAGES = 50
const HISTORY_META_COMPACTIONS = 20

/** welcome 里最多带多少条未读提醒——其余由后续读取补，不能压住握手帧。 */
const WELCOME_NOTICE_LIMIT = 20

/** **目录视图**：active 在首位，超出上限的会话由后续分页/搜索补。 */
function directoryView<T extends { readonly id: string }>(sessions: readonly T[], active: string): readonly T[] {
  const head = sessions.find(one => one.id === active)
  return [
    ...(head === undefined ? [] : [head]),
    ...sessions.filter(one => one.id !== active),
  ].slice(0, CONTROL_DIRECTORY_LIMIT)
}

/** 提醒视图：条数有上限、正文按预算截断（welcome 帧**按构造**装得下，不能等 wire 兜底）。 */
export function welcomeNotices<T extends { readonly detail?: string }>(notices: readonly T[]): readonly T[] {
  return notices.slice(0, WELCOME_NOTICE_LIMIT).map(one => {
    if (one.detail === undefined) return one
    return { ...one, detail: clipTextBytes(one.detail, CONTROL_PREVIEW_TEXT_BYTES) }
  })
}

/** 纯读命令集——只读观察连接（T1.6）放行这些，其余一律拒。 */
export const READONLY_COMMANDS = new Set([
  'session.list', 'session.open', 'session.new', 'session.references', 'history.read', 'plan.read',
  'model.list', 'model.refresh', 'models.search', 'provider.list', 'skills.list',
  'paths.list', 'paths.identify', 'mcp.list', 'knowledge.query', 'knowledge.read',
  'memory.read', 'memory.source', 'collaboration.read', 'compact.query',
])

export function installReadCommands(ctx: ManagerContext): {
  readonly catalog: (conn: ClientConn, archived?: boolean) => Promise<void>
  readonly readHistory: (conn: ClientConn, session: string) => Promise<void>
  /** 处理纯读命令；返回 `false` ＝ 不归读面（继续走写面路由）。 */
  readonly handleReadCommand: (conn: ClientConn, command: Command) => Promise<boolean>
} {
  const { options, now, store, connections, sessions } = ctx
  const { workRoot, isArchived } = sessions

  async function catalog(conn: ClientConn, archived = false): Promise<void> {
    try {
      const all = await ctx.nativeSessions({ archived })
      if (conn.link.closed) return
      const active = conn.selectedSession ?? ''
      const listed = directoryView(all, active)
      conn.link.send({
        t: 'ev', gen: null, event: {
          id: 0, turn: null, at: now(), session: active, kind: 'session.state',
          data: {
            active, sessions: listed,
            ...(all.length > listed.length ? { total: all.length, truncated: true as const } : {}),
          },
        }
      })
      if (conn.selectedSession !== null) { const session = conn.selectedSession; conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session, kind: 'session.changed', data: { session: workRoot(session), archived: isArchived(session), canArchive: ctx.sessions.canArchive(session), terminalOpen: ctx.terminalClients(session).length > 0 } } }) }
      if (conn.selectedSession !== null) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: conn.selectedSession, kind: 'input.pending', data: { inputs: pendingViews(store.serviceFor(conn.selectedSession).inputs.list()) } } })
    } catch { if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session: conn.selectedSession ?? '', kind: 'session.state', data: { active: conn.selectedSession ?? '', sessions: [], note: '无法读取会话目录' } } }) }
  }

  async function readHistory(conn: ClientConn, session: string): Promise<void> {
    if (!store.hasSession(session)) { conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'session.history', data: { session, entries: [], done: true, error: '会话已不可达' } } }); return }
    const revision = connections.beginHistory(conn, session)
    if (revision === undefined) return
    try {
      let entries: Entry[] = []
      let batchBytes = 0
      const timing: TurnTimingEvent[] = []
      const compactEvents: Extract<KernelEvent, { kind: 'compact.state' }>[] = []
      const localInputs: Extract<KernelEvent, { kind: 'input.local' }>[] = []
      // **最后那一次调用的读数**（见 `session.history.usage`）——与在场时状态行 ④ 同一条规矩：
      // 分子取 `model.usage` 的输入消耗，分母取 `model.call.start` 的预算（那一次没带预算就退回
      // 用量事件自带的窗长）。两个都只在**末次**有效：往前那些是更早的账。
      let lastUsage: { inputTokens?: number; contextWindow?: number } | undefined
      let lastBudget: number | undefined
      let started = false
      for await (const event of store.serviceFor(session).readEvents(session)) {
        if (event.kind === 'input.local') localInputs.push(event)
        if (isTurnTimingEvent(event)) timing.push(event)
        if (event.kind === 'compact.state') compactEvents.push(event)
        if (event.kind === 'model.call.start') { started = true; lastBudget = event.data.inputBudget }
        if (event.kind === 'model.usage') lastUsage = { inputTokens: event.data.inputTokens, contextWindow: event.data.contextWindow }
      }
      const usage = lastUsage === undefined ? undefined : {
        ...(lastUsage.inputTokens === undefined ? {} : { inputTokens: lastUsage.inputTokens }),
        ...(started ? (lastBudget === undefined ? {} : { contextWindow: lastBudget })
          : (lastUsage.contextWindow === undefined ? {} : { contextWindow: lastUsage.contextWindow })),
      }
      // 子会话正文里的 `agent-message` 条目只带引用；正文随末块交给外壳并入正文。
      const agent = store.collaboration.agentForSession(session)
      const work = agent === undefined ? undefined : store.collaboration.collaborationForSession(session)
      const messages = agent === undefined || work === undefined || agent.agentId === work.coordinatorId
        ? [] : store.collaboration.listMessages(agent.agentId)
      const send = (done: boolean): void => {
        // 末包元数据的条数上限——timing 随 turn 数线性增长，messages 来自无 LIMIT 的协作
        // 消息列表（2026-11-21 审计）。字节预算只管**会话历史条目**（2026-11-24 收权）。
        const meta = done ? {
          timing: timing.slice(-HISTORY_META_TIMING),
          compactions: compactEvents.slice(-HISTORY_META_COMPACTIONS),
          ...(usage === undefined ? {} : { usage }),
          ...(messages.length === 0 ? {} : { messages: messages.slice(-HISTORY_META_MESSAGES) }),
          ...(timing.length > HISTORY_META_TIMING
            || compactEvents.length > HISTORY_META_COMPACTIONS
            || messages.length > HISTORY_META_MESSAGES
            ? { truncated: true as const }
            : {}),
        } : {}
        conn.link.send({
          t: 'ev', gen: null, event: {
            id: 0, turn: null, at: now(), session, kind: 'session.history',
            data: { session, entries, done, ...meta },
          }
        })
        entries = []
        batchBytes = 0
      }
      /** 一条（已裁好的）条目装进当前批——装不下就先发一批。 */
      const admit = (entry: Entry, bytes: number): void => {
        if (entries.length > 0 && batchBytes + bytes > HISTORY_BATCH_BYTES) send(false)
        entries.push(entry)
        batchBytes += bytes
        if (entries.length === 50) send(false)
      }
      /** 单条过预算管线：先裁全部字段，仍装不下一批再降档，别让门面来砍。 */
      const fit = (raw: Entry): { readonly entry: Entry; readonly bytes: number } => {
        let entry = clipEntryForWire(raw, HISTORY_ENTRY_BYTES)
        let bytes = wireBytesOf(entry)
        while (bytes > HISTORY_BATCH_BYTES) {
          const tighter = clipEntryForWire(entry, Math.max(1, Math.floor(bytes / 2)))
          const next = wireBytesOf(tighter)
          if (next >= bytes) break
          entry = tighter
          bytes = next
        }
        return { entry, bytes }
      }
      /**
       * 本地输入**并入条目流**（2026-11-24 收权）：它们本来就是转录里的用户行——
       * 事件与条目共用同一个 id 序列，按 id 归并即得原序。
       */
      const woven = localInputs.map(event => ({
        id: event.id, kind: 'user' as const, at: event.at,
        content: { text: event.data.text }, payload: { local: true as const, inputRefs: event.data.refs },
      })).sort((a, b) => a.id - b.id)
      const wove = woven[Symbol.iterator]()
      let nextInput = wove.next()
      const admitFitted = (raw: Entry): void => {
        const fitted = fit(raw)
        admit(fitted.entry, fitted.bytes)
      }
      for await (const raw of readSessionDisplayHistory(store, session)) {
        if (!connections.historyCurrent(conn, revision)) return
        while (nextInput.done === false && nextInput.value.id < raw.id) { admitFitted(nextInput.value); nextInput = wove.next() }
        admitFitted(raw)
      }
      while (nextInput.done === false) { admitFitted(nextInput.value); nextInput = wove.next() }
      if (connections.historyCurrent(conn, revision)) {
        // 条目与 meta 分开：先发最后一批 entries，再发空条目的 done 帧——
        // 末包再大也不会把「读完了」这件事挤掉。
        if (entries.length > 0) send(false)
        send(true)
        const notice = ctx.reconcileNotice(workRoot(session))
        if (conn.selectedSession === session && notice?.unread) conn.link.send({ t: 'notice', notice })
      }
    } catch { if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'session.history', data: { session, entries: [], done: true, error: '无法读取会话记录' } } }) }
    finally { connections.finishHistory(conn, revision) }
  }

  async function handleReadCommand(conn: ClientConn, command: Command): Promise<boolean> {
    if (command.type === 'session.references') {
      const data = await readReferenceSessions(store, command).catch((error: unknown) => ({ requestId: command.requestId, query: command.query, offset: command.offset ?? 0, rows: [], error: String(error) }))
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: conn.selectedSession ?? '', kind: 'session.references', data } })
      return true
    }
    if (command.type === 'memory.read') {
      const data = await (async () => readMemory(store, command.session, await memoryWorkspace(store, command.session, command.session === undefined ? workspaceOf(loadConfig({ magic: options.magic }), conn.cwd).roots() : []), command))().catch(error => ({ ...(command.session === undefined ? {} : { session: command.session }), workspace: [], error: String(error) }))
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: command.session ?? '', kind: 'memory.state', data: { requestId: command.requestId, ...data } } })
      return true
    }
    if (command.type === 'memory.source') {
      const result = await (async () => {
        const workspace = await memoryWorkspace(store, command.session, command.session === undefined ? workspaceOf(loadConfig({ magic: options.magic }), conn.cwd).roots() : [])
        return readMemorySource(store.forWorkspace(workspace), command)
      })().then(page => ({ page }), error => ({ error: String(error) }))
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: command.session ?? '', kind: 'memory.source', data: { requestId: command.requestId, ...(command.session === undefined ? {} : { session: command.session }), ...result } } })
      return true
    }
    if (command.type === 'knowledge.query' || command.type === 'knowledge.read') {
      const data = await (async () => {
        const workspace = await memoryWorkspace(store, command.session, command.session === undefined ? workspaceOf(loadConfig({ magic: options.magic }), conn.cwd).roots() : [])
        const knowledge = store.forWorkspace(workspace).knowledge
        if (command.type === 'knowledge.query') return { workspace, page: knowledge.search(command.query) }
        const item = knowledge.read(command.id)
        if (item === undefined) throw new Error('知识已不可读取或不在当前范围')
        return { workspace, item }
      })().catch(error => ({ workspace: [], error: String(error) }))
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: command.session ?? '', kind: 'knowledge.state', data: { requestId: command.requestId, ...(command.session === undefined ? {} : { session: command.session }), ...data } } })
      return true
    }
    if (command.type === 'knowledge.forget' || command.type === 'knowledge.forget-result') {
      const data = await (async () => {
        const workspace = await memoryWorkspace(store, command.session, command.session === undefined ? workspaceOf(loadConfig({ magic: options.magic }), conn.cwd).roots() : [])
        const knowledge = store.forWorkspace(workspace).knowledge
        const current = knowledge.read(command.id)
        if (current !== undefined && (current.scope.kind !== command.scope.kind || (current.scope.kind === 'project'
          && command.scope.kind === 'project' && JSON.stringify(current.scope.workspace) !== JSON.stringify(command.scope.workspace)))) throw new Error('知识范围与所见对象不一致，未执行遗忘')
        const request = { requestId: command.requestId, id: command.id, expectedRevision: command.expectedRevision }
        return { result: command.type === 'knowledge.forget' ? knowledge.forget(request) : knowledge.forgetResult(request) }
      })().catch(error => ({ error: String(error) }))
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: command.session ?? '', kind: 'knowledge.forgotten', data: { requestId: command.requestId, ...(command.session === undefined ? {} : { session: command.session }), ...data } } })
      return true
    }
    if (command.type === 'history.read') {
      const session = command.session ?? conn.selectedSession
      if (session !== null && session !== undefined) void readHistory(conn, session)
      return true
    }
    if (command.type === 'plan.read') {
      // 计划的读侧答复——**全文、零裁剪**（2026-11-24 起计划不搭历史帧的车）。
      const session = command.session ?? conn.selectedSession
      if (session === null || session === undefined) return true
      const data = await (async () => createPlanReader({ records: store.serviceFor(session), session }).readPlan())()
        .catch(() => ({ entry: null, plan: null }))
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session, kind: 'plan.changed', data: { requestId: command.requestId, entry: data.entry, plan: data.plan } } })
      return true
    }
    if (command.type === 'session.list') { void catalog(conn, command.archived ?? false); return true }
    return false
  }

  return { catalog, readHistory, handleReadCommand }
}
