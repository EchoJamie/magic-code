import type { NativeWork, RunRow } from '@magic/contracts'
import { readSessionCatalog } from '@magic/conversation'
import type { RecordsStore } from '@magic/records'

export type ProjectionOptions = {
  readonly candidates: readonly string[]
  readonly terminalOpen: (session: string) => boolean
  readonly canArchive: (session: string) => boolean
}

/** 先按 Engine 候选筛元数据，再读摘要；目录预览不会制造交互入口。 */
export async function projectWorks(
  store: RecordsStore,
  runs: readonly RunRow[],
  generation: (session: string) => number | null,
  options?: ProjectionOptions,
): Promise<readonly NativeWork[]> {
  const candidates = options?.candidates ?? runs.map(run => run.session)
  const bySession = new Map(runs.map(run => [run.session, run]))
  // 与运行事实同拍取得身份和资格，不能在异步读摘要后给旧运行换上新代次。
  const facts = new Map(candidates.map(session => [session, {
    gen: generation(session),
    terminalOpen: options?.terminalOpen(session) ?? false,
    canArchive: options?.canArchive(session) ?? false,
  }]))
  const notices = new Map(store.attention.list({ sessions: candidates }).map(notice => [notice.session, notice]))
  const sessions = await readSessionCatalog(store, undefined, { ids: candidates, archived: false })
  return sessions.map((session): NativeWork => {
    const run = bySession.get(session.id)
    const state = facts.get(session.id)!
    const notice = notices.get(session.id)
    return {
      session: session.id,
      background: run?.backgroundUnknown ? undefined : run?.background ?? 0,
      title: session.title || '未命名工作',
      workspace: session.workspace ?? run?.workspace ?? [],
      state: run?.state ?? 'idle',
      since: run?.since ?? session.at,
      ...state,
      archived: session.archived,
      affected: run !== undefined && (['running', 'waiting', 'stopping', 'unknown'].includes(run.state) || (run.background ?? 0) > 0),
      ...(run?.backgroundWaiting ? { action: '等待后台结果' } : run?.action === undefined ? {} : { action: run.action }),
      ...(run?.reason === undefined ? {} : { reason: run.reason }),
      ...(notice === undefined ? {} : { currentNotice: notice }),
    }
  })
}
