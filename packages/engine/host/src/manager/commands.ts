import type {
  ClientToManager,
  CollaborationCommand,
  Command,
  Entry,
  KernelEvent,
  StopScope,
  TurnTimingEvent,
  Wire,
} from '@magic/contracts'
import { isTurnTimingEvent } from '@magic/contracts'
import { loadConfig, setPrefs } from '@magic/state'
import { ARCHIVED_NOTE, backgroundOf, createWorkEnvironment, linkOf, memoryWorkspace, query as observe, readMemory, readMemorySource, readReferenceSessions, workspaceOf } from '@magic/host'
import { bindSessionReferences, createPlanReader, readSessionDisplayHistory } from '@magic/conversation'
import type { Socket } from 'bun'
import { sendToExecutor as send, type Executor } from '../executor-control.ts'
import type { ClientConn } from '../connections.ts'
import type { ManagerContext } from './context.ts'

/** 客户端命令的受理、路由与回执。 */
export function installCommands(ctx: ManagerContext): void {
  const { options, now, store, lastRuns, connections, sessions, mcpCatalog, compactions, control, collaboration, environments, collaborationInputs, sudoRequests, diagnosticLog, identity } = ctx
  const { clients } = connections
  const { workRoot, isArchived, manageSession } = sessions

  function accept(socket: Socket<unknown>): void {
    const link = linkOf<Wire>(socket)
    if (!ctx.available) { link.close(); return }
    /** 这条连接立起来的时候是谁的——`hello` 那一刻定下，之后不再变。 */
    let greeted = false
    let client: ClientConn | undefined

    link.onMessage((message) => {
      try {
        if (message.t === 'hello') {
          if (greeted) { link.close(); return }
          greeted = true
        }
        if (ctx.native.receive(link, message)) return
        if (message.t === 'hello' && message.role === 'observer') return
        if (message.t === 'hello') {
          if (ctx.stopped) { link.send({ t: 'line', text: 'Magic Code 正在退出' }); link.close(); return }
          if (message.protocol !== identity.protocol || message.version !== identity.version || message.source !== identity.source) {
            link.send({ t: 'line', text: 'App 与终端版本或来源不同，请退出原版后重试' }); link.close(); return
          }
          const conn = connections.create({
            link: link as unknown as import('@magic/host').Link<ClientToManager>,
            selectedSession: message.session ?? null,
            cwd: message.cwd,
            switch: message.switch,
          })
          client = conn

          if (message.session !== undefined && (!store.hasSession(message.session) || (isArchived(message.session) && !message.reattach))) {
            link.send({
              t: 'welcome',
              identity,
              conn: conn.id,
              base: options.magic.base,
              // 回绝这一条不必等预检（它连不上就是连不上，与外部工具无关）
              mcp: ctx.probed,
              // 这一条**不是给窗口的读数**（连接当场就关了）——给一份空的，形态上照旧
              runs: [],
              notices: [],
              refuse: isArchived(message.session) ? ARCHIVED_NOTE :
                `没有这条会话：${message.session}——` +
                `magic resume 收的是会话 id（/resume 那张列表里那串）；库里没有它，本次一步都没走`,
            })
            link.close()
            return
          }

          connections.accept(conn)

          link.send({
            t: 'welcome',
            identity,
            conn: conn.id,
            base: options.magic.base,
            mcp: ctx.probed,
            // 开屏那张摘要据它说「这一摊有几项在跑」——**接上就读得到**，不必先问一次
            runs: ctx.rows(),
            // 汇总只读；具体事项另行确认已读。
            notices: store.attention.list().filter((one) => one.unread),
          })
          if (message.openRequest !== undefined) ctx.native.attached(message.openRequest, message.session ?? null)

          // 已在运行则接回；完成的会话只读历史，直到下一次明确输入。
          if (message.session !== undefined) {
            if (message.reattach && isArchived(message.session)) {
              conn.link.send({ t: 'target', gen: null, session: message.session })
              void ctx.catalog(conn).then(() => ctx.readHistory(conn, message.session!))
              ctx.native.changed()
            } else ctx.retarget(conn, message.session)
          }
          return
        }

        if (client !== undefined) {
          if (ctx.stopped) { link.send({ t: 'line', text: 'Magic Code 正在退出' }); return }
          if (message.t === 'read') { store.attention.markRead(message.ids); ctx.native.changed() }
          if (message.t === 'cmd' && 'gen' in message) {
            if (message.environment !== undefined) connections.updateEnvironment(client, message.environment)
            void ctx.onCommand(client, message.gen, message.cmd)
          }
          if (message.t === 'stop') ctx.stopRun(client, message.session, message.scope)
          if (message.t === 'sudo.answer') ctx.answerSudo(client, message)
          if (message.t === 'bye') ctx.dropConnection(client.id)
          return
        }

      } catch (error) {
        link.send({ t: 'line', text: `操作未完成：${String(error)}` })
        diagnosticLog.write('error', 'client.operation.failed', identity)
      }
    })
    link.onClose(() => { if (client !== undefined) ctx.dropConnection(client.id) })
  }

  async function catalog(conn: ClientConn, archived = false): Promise<void> {
    try {
      const sessions = await ctx.nativeSessions({ archived })
      if (conn.link.closed) return
      conn.link.send({
        t: 'ev', gen: null, event: {
          id: 0, turn: null, at: now(), session: conn.selectedSession ?? '', kind: 'session.state',
          data: { active: conn.selectedSession ?? '', sessions },
        }
      })
      if (conn.selectedSession !== null) { const session = conn.selectedSession; conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'session.changed', data: { session: workRoot(session), archived: isArchived(session), canArchive: ctx.sessions.canArchive(session), terminalOpen: ctx.terminalClients(session).length > 0 } } }) }
      if (conn.selectedSession !== null) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: conn.selectedSession, kind: 'input.pending', data: { inputs: store.serviceFor(conn.selectedSession).inputs.list() } } })
    } catch { if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session: conn.selectedSession ?? '', kind: 'session.state', data: { active: conn.selectedSession ?? '', sessions: [], note: '无法读取会话目录' } } }) }
  }

  async function readHistory(conn: ClientConn, session: string): Promise<void> {
    if (!store.hasSession(session)) { conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'session.history', data: { session, entries: [], done: true, error: '会话已不可达' } } }); return }
    const revision = connections.beginHistory(conn, session)
    if (revision === undefined) return
    try {
      let entries: Entry[] = []
      const inputs: Extract<KernelEvent, { kind: 'input.local' }>[] = []
      const timing: TurnTimingEvent[] = []
      const compactEvents: Extract<KernelEvent, { kind: 'compact.state' }>[] = []
      for await (const event of store.serviceFor(session).readEvents(session)) {
        if (event.kind === 'input.local') inputs.push(event)
        if (isTurnTimingEvent(event)) timing.push(event)
        if (event.kind === 'compact.state') compactEvents.push(event)
      }
      // 子会话正文里的 `agent-message` 条目只带引用；正文随末块交给外壳并入正文。
      const agent = store.collaboration.agentForSession(session)
      const work = agent === undefined ? undefined : store.collaboration.collaborationForSession(session)
      const messages = agent === undefined || work === undefined || agent.agentId === work.coordinatorId
        ? [] : store.collaboration.listMessages(agent.agentId)
      const plan = await createPlanReader({ records: store.serviceFor(session), session }).readPlan()
      const send = (done: boolean): void => {
        conn.link.send({
          t: 'ev', gen: null, event: {
            id: 0, turn: null, at: now(), session, kind: 'session.history', data: { session, entries, done, ...(done ? { inputs, timing, plan, compactions: compactEvents, ...(messages.length === 0 ? {} : { messages }) } : {}) },
          }
        })
        entries = []
      }
      for await (const entry of readSessionDisplayHistory(store, session)) {
        if (!connections.historyCurrent(conn, revision)) return
        entries.push(entry)
        if (entries.length === 50) send(false)
      }
      if (connections.historyCurrent(conn, revision)) {
        send(true)
        const notice = ctx.reconcileNotice(workRoot(session))
        if (conn.selectedSession === session && notice?.unread) conn.link.send({ t: 'notice', notice })
      }
    } catch { if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'session.history', data: { session, entries: [], done: true, error: '无法读取会话记录' } } }) }
    finally { connections.finishHistory(conn, revision) }
  }

  async function onCommand(conn: ClientConn, gen: number | null, command: Command): Promise<void> {
    const session = conn.selectedSession
    const execution = command.type === 'input.submit' || command.type === 'collaboration.input' || command.type === 'collaboration.resume' || (command.type === 'input.manage' && command.action !== 'list')
    if (session !== null && execution && isArchived(session)) {
      const input = command.type === 'input.submit' ? command : command.type === 'collaboration.input' ? command.input : undefined
      if (input !== undefined) conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'input.settled', data: { ok: false, ref: input.ref, reason: ARCHIVED_NOTE } } })
      else conn.link.send({ t: 'line', text: ARCHIVED_NOTE })
      return
    }
    const root = session !== null && execution ? workRoot(session) : undefined
    const release = root === undefined ? undefined : sessions.admit(root)
    try {
      const input = command.type === 'input.submit' ? command : command.type === 'collaboration.input' ? command.input : undefined
      if (input?.local !== true && input?.refs?.some(ref => ref.kind === 'session' || ref.kind === 'memory' || ref.kind === 'note')) {
        const target = command.type === 'collaboration.input' && command.member !== undefined
          ? store.collaboration.getAgent(command.member)?.sessionId : session
        try {
          for (const ref of input.refs) {
            if (ref.kind === 'memory' && ref.scope.kind === 'session') throw new Error('旧事项引用不适用于工作笔记；请重新查看并选择')
            if (ref.kind !== 'note') continue
            if (ref.session !== target || target == null) throw new Error('纠正对象与发送目标不一致；请回到原目标交代')
            const latest = await readMemory(store, target, [], { path: ref.source })
            if (!latest.notes?.page) throw new Error('所选笔记已不可读取；草稿保留，请重新查看')
          }
          const existing = target == null || input.ref === undefined ? undefined : store.serviceFor(target).inputs.get(input.ref)
          const bound = existing?.input ?? await bindSessionReferences(input, store)
          if (conn.selectedSession !== session) throw new Error('输入目标已改变，未受理；原稿保留')
          command = command.type === 'collaboration.input' ? { ...command, input: bound } : { ...bound, type: 'input.submit' }
        } catch (error) {
          conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: target ?? session ?? '', kind: 'input.settled', data: { ref: input.ref, ok: false, reason: String(error) } } })
          return
        }
      }
      await acceptCommand(conn, gen, command)
    }
    finally { release?.() }
  }

  async function acceptCommand(conn: ClientConn, gen: number | null, command: Command): Promise<void> {
    if (command.type === 'compact.request' || command.type === 'compact.query' || command.type === 'compact.cancel') {
      const request = command
      const state = request.type === 'compact.query' ? await compactions.query(request.session, request.requestId)
        : request.type === 'compact.cancel' ? await compactions.cancel(request.session, request.requestId)
        : await compactions.request(request, async (signal, started) => {
          const release = sessions.admit(workRoot(request.session))
          try {
            signal.throwIfAborted()
            if (ctx.stopped) throw new Error('Engine 正在停止')
            const entries = await store.readEntriesBack(request.session, undefined, 1)
            if (entries.length === 0) return { requestId: request.requestId, state: 'no-material', reason: '没有可压缩材料' }
            const workspace = await memoryWorkspace(store, request.session, [])
            signal.throwIfAborted()
            const previous = lastRuns.get(request.session)
            let executor = ctx.liveOf(request.session)
            if (executor?.run.stopping || executor === undefined && previous !== undefined && (previous.ended === undefined || previous.reclaimPending || previous.reclaimNote !== undefined)) throw new Error('上一代工作责任尚未核销，未执行压缩')
            executor ??= ctx.spawn({ session: request.session, explicit: true, cwd: workspace[0] ?? conn.cwd, environment: conn.environment })
            if (executor === undefined) throw new Error('无法取得压缩执行责任')
            for (const watcher of clients.values()) if (watcher.selectedSession === request.session && watcher.target !== executor) connections.bind(watcher, executor)
            return await control.compact(executor, request, signal, started)
          } finally { release() }
        })
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: request.session, kind: 'compact.state', data: state } })
      return
    }
    if (command.type === 'session.references') {
      const data = await readReferenceSessions(store, command).catch(error => ({ requestId: command.requestId, query: command.query, offset: command.offset ?? 0, rows: [], error: String(error) }))
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: conn.selectedSession ?? '', kind: 'session.references', data } })
      return
    }
    if (command.type === 'memory.read') {
      const data = await (async () => readMemory(store, command.session, await memoryWorkspace(store, command.session, command.session === undefined ? workspaceOf(loadConfig({ magic: options.magic }), conn.cwd).roots() : []), command))().catch(error => ({ ...(command.session === undefined ? {} : { session: command.session }), workspace: [], error: String(error) }))
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: command.session ?? '', kind: 'memory.state', data: { requestId: command.requestId, ...data } } })
      return
    }
    if (command.type === 'memory.source') {
      const result = await (async () => {
        const workspace = await memoryWorkspace(store, command.session, command.session === undefined ? workspaceOf(loadConfig({ magic: options.magic }), conn.cwd).roots() : [])
        return readMemorySource(store.forWorkspace(workspace), command)
      })().then(page => ({ page }), error => ({ error: String(error) }))
      if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: command.session ?? '', kind: 'memory.source', data: { requestId: command.requestId, ...(command.session === undefined ? {} : { session: command.session }), ...result } } })
      return
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
      return
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
      return
    }
    if (command.type === 'background.list' || command.type === 'background.stop') { ctx.backgroundCommand(conn, command); return }
    if (command.type === 'history.read') {
      const session = command.session ?? conn.selectedSession
      if (session !== null && session !== undefined) void readHistory(conn, session)
      return
    }
    if (command.type === 'session.list') { void catalog(conn, command.archived ?? false); return }
    if (command.type === 'session.archive' || command.type === 'session.restore' || command.type === 'session.rename') {
      const result = manageSession({ session: command.session, action: command.type === 'session.archive' ? 'archive' : command.type === 'session.restore' ? 'restore' : 'rename', ...('title' in command ? { title: command.title } : {}) })
      conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: result.session, kind: 'session.managed', data: result } })
      return
    }
    // 界面偏好只写配置，不依附一代任务执行者，也不创建会话。
    if (command.type === 'prefs.set') {
      try {
        const loaded = loadConfig({ magic: options.magic })
        const outcome = await setPrefs({ path: loaded.path, expectedStamp: loaded.stamp, request: command })
        if (outcome.ok) ctx.publishPreferences(conn)
        const config = outcome.ok ? loadConfig({ magic: options.magic }).config : loaded.config
        const changed = [command.statusLine === undefined ? '' : '状态行', command.reducedMotion === undefined ? '' : '动效', command.turnDuration === undefined ? '' : '本轮耗时', command.voice === undefined ? '' : '语音输入'].filter(Boolean).join(' · ')
        conn.link.send({
          t: 'ev', gen: null, event: {
            id: 0, turn: null, at: now(), session: conn.selectedSession ?? '', kind: 'prefs.state', data: {
              ...(config.statusLine === undefined ? {} : { statusLine: config.statusLine }),
              turnDuration: config.turnDuration ?? 'elapsed', reducedMotion: config.motion?.reduced === true,
              voice: config.experimental?.voice === true,
              note: outcome.ok ? `已更新：${changed}` : `${changed}没改成——${outcome.reason}`,
            }
          }
        })
      } catch (error) { conn.link.send({ t: 'line', text: `界面设置没改成：${error instanceof Error ? error.message : String(error)}` }) }
      return
    }

    if (conn.target === undefined && ['model.list', 'provider.list', 'skills.list', 'paths.list', 'mcp.list'].includes(command.type)) {
      const session = conn.selectedSession
      void observe(command, {
        magic: options.magic, cwd: conn.cwd, store, session, mcp: mcpCatalog, now,
        ...(conn.switch === undefined ? {} : { switch: conn.switch }),
      }).then((event) => {
        if (event !== undefined && !conn.link.closed && conn.selectedSession === session) conn.link.send({ t: 'ev', gen: null, event })
      }).catch((error) => { if (!conn.link.closed) conn.link.send({ t: 'line', text: `读取失败：${String(error)}` }) })
      return
    }
    const originSession = conn.selectedSession
    const activeCollaboration = originSession == null ? undefined : store.collaboration.collaborationForSession(originSession)
    if (gen !== null && (conn.target === undefined || gen !== conn.target.gen)) {
      conn.link.send({
        t: 'line',
        text:
          conn.target === undefined
            ? '这一代已经不在了——它那条命令没生效（接着敲就是，会给你起新的一代）'
            : `这一代已经过去了（那是第 ${gen} 代，现在是第 ${conn.target.gen} 代）——它那条命令没生效`,
      })
      return
    }

    const localInput = command.type === 'input.submit' && command.local === true ? command : command.type === 'collaboration.input' && command.input.local === true ? command.input : undefined
    if (localInput !== undefined) {
      const origin = conn.selectedSession
      const work = origin === null ? undefined : store.collaboration.collaborationForSession(origin)
      const member = command.type === 'collaboration.input' ? command.member : undefined
      const session = member === undefined ? origin : work === undefined ? undefined : store.collaboration.listMembers(work.collaborationId).find(one => one.agentId === member)?.sessionId
      if (session != null) { const records = store.serviceFor(session); records.appendEvent({ session, id: records.nextId(), turn: null, at: now(), kind: 'input.local', data: { text: localInput.text, refs: localInput.refs ?? [], ref: localInput.ref ?? crypto.randomUUID() } }) }
      return
    }

    if (command.type.startsWith('collaboration.')) {
      if (conn.selectedSession !== null && (command.type === 'collaboration.resume' || command.type === 'collaboration.input') && ctx.environmentFor(conn.selectedSession) === undefined) environments.set(workRoot(conn.selectedSession), createWorkEnvironment(conn.environment))
      await collaborationCommand(conn, command as CollaborationCommand)
      return
    }
    if (command.type === 'session.new') connections.selectMember(conn, undefined)

    if (command.type === 'input.manage') {
      const origin = conn.selectedSession
      const work = origin === null ? undefined : store.collaboration.collaborationForSession(origin)
      const member = command.member === undefined ? undefined : work === undefined ? undefined : store.collaboration.listMembers(work.collaborationId).find(one => one.agentId === command.member)
      const session = command.member === undefined ? origin : member?.sessionId
      if (session == null) { conn.link.send({ t: 'line', text: '当前输入目标不存在，未修改' }); return }
      if (member?.purpose === 'consultation' && command.action !== 'list') { conn.link.send({ t: 'line', text: '咨询详情只供查看；相关纠正请补充给原工作' }); return }
      const inputs = store.serviceFor(session).inputs
      let note: string | undefined
      if (command.action === 'edit') {
        try {
          const input = await bindSessionReferences(command.input, store)
          for (const ref of input.refs ?? []) {
            if (ref.kind === 'memory' && ref.scope.kind === 'session') throw new Error('旧事项引用已退出使用')
            if (ref.kind !== 'note') continue
            if (ref.session !== session) throw new Error('纠正对象与发送目标不一致')
            if (!(await readMemory(store, session, [], { path: ref.source })).notes?.page) throw new Error('所选笔记已不可读取；原稿保留')
          }
          note = inputs.edit(command.ref, command.revision, input) ? '已保存未消费输入' : '输入已消费或已改变，未修改'
        } catch (error) { note = `未修改输入：${String(error)}` }
      }
      if (command.action === 'withdraw') note = inputs.withdraw(command.ref, command.revision) ? '已撤回未消费输入' : '输入已消费或已改变，未撤回'
      if (command.action === 'continue') {
        const row = inputs.get(command.ref)
        if (row?.state !== 'pending' || row.revision !== command.revision) note = '输入已消费或已改变，未继续'
        else if (work?.state === 'stopped') note = '这份工作已停止，请先明确继续工作'
        else {
          const executor = ctx.liveOf(session) ?? ctx.spawn({ session, explicit: true, cwd: member?.workspace[0] ?? conn.cwd, environment: conn.environment })
          if (executor === undefined) note = '当前执行者不可用，输入保留'
          else {
            if (member === undefined) connections.bind(conn, executor)
            else collaborationInputs.set(row.ref, { conn, session: origin!, target: session, ref: row.ref })
            ctx.deliver(executor, command)
          }
        }
      }
      conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session, kind: 'input.pending', data: { inputs: inputs.list(), ...(note === undefined ? {} : { note }) } } })
      return
    }
    // 当前会话是子会话时，输入只发给这条子会话；入口会话默认只给入口自己（不再广播给成员）。
    const currentAgent = originSession == null ? undefined : store.collaboration.agentForSession(originSession)
    const subSession = activeCollaboration === undefined || currentAgent === undefined
      || currentAgent.agentId === activeCollaboration.coordinatorId ? undefined : currentAgent
    if (activeCollaboration !== undefined && command.type === 'input.submit') {
      if (subSession !== undefined) await collaborationCommand(conn, { type: 'collaboration.input', member: subSession.agentId, input: command })
      else await collaborationCommand(conn, { type: 'collaboration.input', input: command })
      return
    }
    if (activeCollaboration !== undefined && command.type === 'turn.interrupt') {
      // 子会话的停止范围是这份委派及其派生闭包；入口仍是整件工作。
      const delegation = subSession === undefined ? undefined
        : store.collaboration.listDelegations(activeCollaboration.collaborationId).find(d => d.assigneeId === subSession.agentId && d.state === 'accepted')?.delegationId
      if (subSession === undefined) void collaborationCommand(conn, { type: 'collaboration.stop' })
      else if (delegation === undefined) conn.link.send({ t: 'line', text: '此成员没有当前委派，无法推断停止范围' })
      else void collaborationCommand(conn, { type: 'collaboration.stop', delegation })
      return
    }
    if (activeCollaboration !== undefined && subSession !== undefined && command.type === 'model.switch') {
      // 复用现有会话模型入口，但落点只在这个成员：持久写回成员身份并配置它的执行者。
      await collaborationCommand(conn, { type: 'collaboration.configure', member: subSession.agentId, model: command })
      return
    }

    // 已完成工作的短暂收缩余量不属于执行责任；下一次明确输入先收妥旧实例，
    // 再按发起终端的环境建立下一代。后台工具、队列及协作责任仍沿用原环境。
    const previous = conn.target
    if (command.type === 'input.submit' && previous?.run.session != null && activeCollaboration === undefined &&
      previous.run.lastTurn !== undefined && !previous.run.busy && !previous.run.turnActive &&
      !compactions.active(previous.run.session) &&
      backgroundOf(previous.run) === 0 &&
      !store.serviceFor(previous.run.session).inputs.list().some(input => input.state === 'pending')) {
      const selected = conn.selectedSession
      // 该输入由管理者等待接续，不属于旧 Agent；旧实例释放不能给它发送拒收回执。
      connections.unbind(conn)
      const closed = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 15000)
        previous.spawned.onExit(() => { clearTimeout(timer); resolve(true) })
      })
      send(previous, { t: 'bye', why: '已完成工作，释放旧环境后继续' })
      if (!await closed || ctx.stopped || conn.selectedSession !== selected) {
        conn.link.send({
          t: 'ev', gen: null, event: {
            id: 0, session: selected ?? '', turn: null, at: now(),
            kind: 'input.settled', data: { ok: false, ref: command.ref, reason: '旧工作收尾未确认或入口已改变，未受理新输入' }
          }
        })
        return
      }
      await onCommand(conn, null, command)
      return
    }

    // **换目标的只有这两条**（见文件头注）
    if (command.type === 'session.open' || command.type === 'session.new') {
      if (command.type === 'session.open' && conn.target !== undefined && conn.target.run.busy) {
        // 同一份协作里的入口与子会话各有执行者：换的是窗口看哪一条，不停正在跑的那一代。
        const from = conn.target.run.session
        const sameWork = from !== null
          && store.collaboration.collaborationForSession(from)?.collaborationId !== undefined
          && store.collaboration.collaborationForSession(from)?.collaborationId === store.collaboration.collaborationForSession(command.session)?.collaborationId
        if (sameWork) { ctx.retarget(conn, command.session); return }
        ctx.deliver(conn.target, command)
        return
      }

      if (command.type === 'session.open') {
        ctx.retarget(conn, command.session)
        return
      }

      // 新对话只是清空连接目标；首条明确输入才启动执行者并创建持久会话。
      connections.selectSession(conn, null)
      void catalog(conn)
      return
    }

    if (conn.target === undefined && conn.selectedSession !== null) {
      // **用户明确继续 ⇒ 建立下一次运行**（同上面那句设计原文）——走到这一支的就是**一条真交代**：
      // 观察类命令在上面 `history.read` / `session.list` 那两处已经返回，到不了这儿。
      const session = conn.selectedSession
      const held = lastRuns.get(session)
      if (held !== undefined && held.ended === undefined) {
        conn.link.send({
          t: 'line',
          text:
            `没接上 ${session}：上一次那条执行者还没有证实结束（它可能正在收尾）` +
            '——同一个会话不能同时起两个。/resume 里那一行标着「状态待确认」',
        })
        return
      }

      // 这一支的前提就是「没有目标」（上面那个 if），故没有可复用的当下那一代——
      // main 的 `retarget` 里有这一段是因为它那儿 `current` 可能还在。
      const carried = command.type === 'input.submit' ? command.model : undefined
      const choice = carried ?? conn.switch
      const spawned = ctx.spawn({
        session,
        explicit: true,
        cwd: conn.cwd, environment: conn.environment,
        ...(choice === undefined ? {} : { switch: choice }),
      })
      if (spawned === undefined) {
        conn.link.send({ t: 'line', text: `起不了执行者——没接上 ${session}` })
        return
      }
      connections.bind(conn, spawned)
      ctx.deliver(spawned, command)
      // ⚠️ **这一条不能省**（main 的 `retarget` 新起一代那一支末尾也有它）：为这条会话新起的
      // 那一代是**带着会话号装配**的，`switchTo` 判「已经在的那条 ＝ 无事」——`session.open`
      // 过去一声不响，窗口就此停在旧那一页上。`session.list` 一定会报一次状态，窗口据此重画。
      ctx.deliver(spawned, { type: 'session.list' })
      return
    }

    const target = conn.target ?? ctx.spawnFresh(conn, command.type === 'input.submit' ? command.model : undefined)
    if (target === undefined) {
      conn.link.send({ t: 'line', text: '起不了执行者——这条命令没能送到' })
      return
    }

    ctx.deliver(target, command)
  }

  async function collaborationCommand(conn: ClientConn, command: CollaborationCommand): Promise<void> {
    const session = conn.selectedSession
    if (session === undefined || session === null) return
    let submitted = command
    if (command.type === 'collaboration.read') {
      // 当前会话自身不再作为「查看成员」——选择一并清掉，回执仍按这一份请求发回。
      const member = ctx.viewingSelfGuard(conn, command.member)
      connections.selectMember(conn, member)
      submitted = { type: 'collaboration.read', ...(member === undefined ? {} : { member }) }
    }
    let inputKey: string | undefined
    if (command.type === 'collaboration.input') {
      inputKey = command.input.ref ?? crypto.randomUUID()
      const work = store.collaboration.collaborationForSession(session)
      const target = command.shared === true || command.member === undefined ? work?.originSessionId
        : store.collaboration.getAgent(command.member)?.sessionId
      collaborationInputs.set(inputKey, { conn, session, target: target ?? session, ...(command.input.ref === undefined ? {} : { ref: command.input.ref }) })
      submitted = { ...command, input: { ...command.input, ref: inputKey } }
    }
    try {
      const view = await collaboration.command(session, submitted)
      if (submitted.type === 'collaboration.read' && submitted.member !== conn.collaborationMember) return
      if (command.type === 'collaboration.resume') {
        const live = ctx.liveOf(view.originSession)
        if (live !== undefined && conn.target !== live) connections.bind(conn, live)
      }
      ctx.collaborationEvent(conn, view)
    }
    catch (error) {
      if (command.type === 'collaboration.input') {
        if (inputKey !== undefined) collaborationInputs.delete(inputKey)
        conn.link.send({
          t: 'ev', gen: conn.target?.gen ?? null, event: {
            kind: 'input.settled', data: { ok: false, ...(command.input.ref === undefined ? {} : { ref: command.input.ref }), reason: String(error) },
            session, id: store.serviceFor(session).nextId(), at: now(), turn: null,
          }
        })
      }
      ctx.collaborationEvent(conn, await collaboration.view(session, conn.collaborationMember, String(error)))
    }
  }

  function stopRun(conn: Pick<ClientConn, 'id'>, session: string, scope: StopScope): void {
    const work = store.collaboration.collaborationForSession(session)
    if (work !== undefined) {
      const agent = store.collaboration.agentForSession(session)
      const delegation = agent?.agentId === work.coordinatorId ? undefined : store.collaboration.listDelegations(work.collaborationId).find(d => d.assigneeId === agent?.agentId && d.state === 'accepted')?.delegationId
      if (agent?.agentId !== work.coordinatorId && delegation === undefined) {
        ctx.reportStop(conn.id, session, scope, 'unconfirmed', '此成员没有当前委派，无法推断停止范围')
        return
      }
      store.attention.clear(workRoot(session))
      ctx.reportStop(conn.id, session, scope, 'accepted')
      void collaboration.command(work.originSessionId, { type: 'collaboration.stop', ...(delegation === undefined ? {} : { delegation }) }).then(
        () => ctx.reportStop(conn.id, session, scope, 'done'),
        error => ctx.reportStop(conn.id, session, scope, 'unconfirmed', String(error)),
      )
      return
    }
    ctx.runStops.stopExecution(conn, session, scope)
  }

  /** 一个窗口走了：把它占着、而再没人看着的 sudo 认证收掉。 */
  function dropConnection(id: number): void {
    connections.dropClient(id)
    for (const [requestId, request] of sudoRequests) {
      if (connections.watching(request.executor).length === 0) cancelSudo(requestId, request.executor)
    }
  }

  /** sudo 认证落定：转给执行者，并让其余窗口撤掉组件。密码不在这里留痕。 */
  function answerSudo(conn: ClientConn, message: Extract<ClientToManager, { t: 'sudo.answer' }>): void {
    const request = sudoRequests.get(message.requestId)
    if (request === undefined || conn.target !== request.executor) return
    const executor = request.executor
    sudoRequests.delete(message.requestId)
    send(executor, message.cancelled === true
      ? { t: 'sudo.answer', requestId: message.requestId, cancelled: true }
      : { t: 'sudo.answer', requestId: message.requestId, password: message.password ?? '' })
    for (const watcher of connections.watching(executor)) {
      watcher.link.send({ t: 'sudo.settled', requestId: message.requestId })
    }
  }

  function cancelSudo(requestId: string, executor: Executor): void {
    if (!sudoRequests.delete(requestId)) return
    send(executor, { t: 'sudo.answer', requestId, cancelled: true })
    for (const watcher of connections.watching(executor)) {
      watcher.link.send({ t: 'sudo.settled', requestId })
    }
  }

  ctx.accept = accept
  ctx.catalog = catalog
  ctx.readHistory = readHistory
  ctx.onCommand = onCommand
  ctx.acceptCommand = acceptCommand
  ctx.collaborationCommand = collaborationCommand
  ctx.stopRun = stopRun
  ctx.dropConnection = dropConnection
  ctx.answerSudo = answerSudo
  ctx.cancelSudo = cancelSudo
}
