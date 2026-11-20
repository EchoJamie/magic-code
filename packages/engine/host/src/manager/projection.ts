import { captureCollaborationNative, mergeCollaborationNative, projectWorks, runRowOf, storedRunOf } from '@magic/host'
import { STORED_RUNS_LIMIT } from '@magic/host'
import { readSessionCatalog } from '@magic/conversation'
import { loadConfig } from '@magic/state'
import type { StoredRun } from '@magic/host'
import type { RunRow } from '@magic/contracts'
import type { NativeSession, NativeWork } from '@magic/contracts'
import type { ClientConn } from '../connections.ts'
import { writeRuns } from '../run-store.ts'
import { RUNS_PUSH_MS, RUNS_SAVE_MS, type ManagerContext, type NativeSessionsQuery } from './context.ts'

/** 运行事实、会话目录与界面偏好——同一份数据既推给窗口也落盘。 */
export function installProjection(ctx: ManagerContext): void {
  const { options, paths, now, store, executors, lastRuns, connections, sessions, diagnosticLog, identity } = ctx
  const { clients } = connections
  const { workRoot, isArchived, canArchive } = sessions

  function rows(): readonly RunRow[] {
    const out: RunRow[] = []
    const live = new Set<string>()

    const known = (session: string): boolean =>
      ctx.storeClosed ? true : store.hasSession(session)

    for (const executor of executors) {
      const session = executor.run.session
      if (session === null || !known(session)) continue
      live.add(session)
      out.push(runRowOf(executor.run))
    }

    for (const [session, run] of lastRuns) {
      if (live.has(session) || !known(session)) continue
      out.push(runRowOf(run))
    }

    return out
  }

  function pushRuns(immediate = false): void {
    if (ctx.pushTimer !== undefined) {
      if (!immediate) return
      clearTimeout(ctx.pushTimer)
      ctx.pushTimer = undefined
    }
    if (ctx.stopped) return

    if (!immediate) {
      ctx.pushTimer = setTimeout(() => {
        ctx.pushTimer = undefined
        pushRuns(true)
      }, RUNS_PUSH_MS)
      ctx.pushTimer.unref?.()
      return
    }

    ctx.native.changed()
    for (const conn of clients.values()) ctx.publishBackground(conn)
    const payload = rows()
    for (const conn of clients.values()) conn.link.send({ t: 'runs', rows: payload })
  }

  function saveRuns(immediate = false): void {
    if (ctx.saveTimer !== undefined) {
      if (!immediate) return
      clearTimeout(ctx.saveTimer)
      ctx.saveTimer = undefined
    }

    if (!immediate) {
      ctx.saveTimer = setTimeout(() => {
        ctx.saveTimer = undefined
        try { saveRuns(true) } catch (error) { options.log?.(`运行状态保存失败：${String(error)}`); diagnosticLog.write('error', 'runs.save.failed', identity) }
      }, RUNS_SAVE_MS)
      ctx.saveTimer.unref?.()
      return
    }

    // 最近历史有界；尚未核销的责任与活执行者必须全部保留。
    const history: StoredRun[] = []
    const outstanding: StoredRun[] = []
    for (const run of lastRuns.values()) {
      const one = storedRunOf(run)
      if (one !== undefined) (run.ended === undefined || run.reclaimPending || run.reclaimNote !== undefined ? outstanding : history).push(one)
    }
    for (const executor of executors) {
      const one = storedRunOf(executor.run)
      if (one !== undefined) outstanding.push(one)
    }
    writeRuns(paths, [...history.slice(-STORED_RUNS_LIMIT), ...outstanding], now())
  }

  function publishPreferences(except?: ClientConn): void {
    const config = loadConfig({ magic: options.magic }).config
    for (const conn of clients.values()) if (conn !== except) conn.link.send({
      t: 'ev', gen: null, event: {
        id: 0, turn: null, at: now(), session: conn.selectedSession ?? '', kind: 'prefs.state', data: {
          ...(config.statusLine === undefined ? {} : { statusLine: config.statusLine }), turnDuration: config.turnDuration ?? 'elapsed', reducedMotion: config.motion?.reduced === true, voice: config.experimental?.voice === true,
        }
      }
    })
  }

  /** 连接真源仍是 clients；执行者结束不影响正在查看该会话的终端。 */
  function terminalClients(session: string): ClientConn[] {
    const origin = store.collaboration.collaborationForSession(session)?.originSessionId ?? session
    return [...clients.values()].filter(conn => !conn.link.closed &&
      (conn.selectedSession !== null && workRoot(conn.selectedSession) === origin))
  }

  async function nativeWorks(): Promise<readonly NativeWork[]> {
    const metadata = await store.listSessions({ archived: false })
    const allGroups = captureCollaborationNative(store.collaboration, metadata.map(session => session.id))
    for (const notice of store.attention.list()) ctx.reconcileNotice(notice.session)
    const runs = rows()
    const candidates = [...new Set([
      ...runs.filter(run => run.holds).map(run => run.session),
      ...mergeCollaborationNative([], allGroups).filter(work => work.affected).map(work => work.session),
      ...store.attention.list({ unread: true }).map(notice => notice.session),
      ...[...clients.values()].flatMap(conn => conn.link.closed || conn.selectedSession === null ? [] : [conn.selectedSession]),
    ])]
    const snapshot = captureCollaborationNative(store.collaboration, candidates)
    const generations = new Map(snapshot.sessions.map(session => [session, ctx.workStopGeneration(workRoot(session))]))
    const works = await projectWorks(store, runs, session => generations.get(session) ?? null, {
      candidates: snapshot.sessions, terminalOpen: session => terminalClients(session).length > 0, canArchive,
    })
    const affected = await (options.lifecycle?.affected() ?? Promise.resolve([]))
    return [...mergeCollaborationNative(works, snapshot).map(work => ({
      ...work,
      archived: isArchived(work.session), canArchive: canArchive(work.session), terminalOpen: terminalClients(work.session).length > 0,
      gen: generations.get(work.session) ?? null,
    })).filter(work => !work.archived && (work.affected || work.terminalOpen || work.currentNotice?.unread)), ...affected]
  }

  async function nativeSessions(query: NativeSessionsQuery): Promise<readonly NativeSession[]> {
    const metadata = await store.listSessions({ archived: query.archived ?? false, ...(query.ids === undefined ? {} : { ids: query.ids }), ...(query.workspace === undefined ? {} : { workspace: query.workspace }) })
    const roots = metadata.filter(session => workRoot(session.id) === session.id).map(session => session.id)
    const catalog = await readSessionCatalog(store, undefined, { ids: roots })
    const runs = rows()
    const snapshot = captureCollaborationNative(store.collaboration, catalog.map(s => s.id))
    const summaries = new Map(catalog.map(session => [session.id, session]))
    const raw: NativeWork[] = snapshot.sessions.map(session => {
      const s = summaries.get(session)
      const run = runs.find(r => r.session === session)
      return {
        session, title: s?.title ?? '未命名工作', workspace: s?.workspace ?? run?.workspace ?? [], archived: isArchived(session),
        canArchive: canArchive(session), terminalOpen: terminalClients(session).length > 0,
        background: run?.backgroundUnknown ? undefined : run?.background ?? 0,
        state: run?.state ?? 'idle', since: run?.since ?? s?.at ?? 0, gen: null, affected: run?.holds ?? false,
        ...(run?.reason === undefined ? {} : { reason: run.reason }),
      }
    })
    const states = new Map(mergeCollaborationNative(raw, snapshot).map(w => [w.session, w]))
    const attention = new Set(query.archived ? [] : catalog.filter(session => states.get(session.id)?.affected || terminalClients(session.id).length > 0 || ctx.reconcileNotice(session.id)?.unread).map(session => session.id))
    return catalog.filter(s => workRoot(s.id) === s.id && (!query.search || (s.title ?? '').toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))).map(s => {
      const work = states.get(s.id)!
      return { ...s, background: work.background, state: work.state, canArchive: canArchive(s.id), terminalOpen: terminalClients(s.id).length > 0, ...(work.reason === undefined ? {} : { reason: work.reason }) }
    }).sort((left, right) => {
      const priority = Number(attention.has(right.id)) - Number(attention.has(left.id))
      return priority || right.at - left.at || left.id.localeCompare(right.id)
    })
  }

  ctx.rows = rows
  ctx.pushRuns = pushRuns
  ctx.saveRuns = saveRuns
  ctx.publishPreferences = publishPreferences
  ctx.terminalClients = terminalClients
  ctx.nativeWorks = nativeWorks
  ctx.nativeSessions = nativeSessions
}
