import type { NativeWork, RunRow } from '@magic/contracts'
import { readSessionCatalog } from '@magic/conversation'
import type { RecordsStore } from '@magic/records'

/** 只从记录端口和管理者读数投影；查看历史不创建执行者。 */
export async function projectWorks(
  store: RecordsStore,
  runs: readonly RunRow[],
  generation: (session: string) => number | null,
): Promise<readonly NativeWork[]> {
  // 运行状态与停止代次同拍取值，异步目录读取不能把旧状态重新绑到后继代。
  const generations = new Map(runs.map((run) => [run.session, generation(run.session)]))
  const notices = store.attention.list()
  const sessions = await readSessionCatalog(store)
  return Promise.all(sessions.map(async (session): Promise<NativeWork> => {
    const run = runs.find((row) => row.session === session.id)
    return {
      session: session.id,
      title: session.title || '未命名工作',
      workspace: session.workspace ?? run?.workspace ?? [],
      state: run?.state ?? 'idle',
      since: run?.since ?? session.at,
      gen: generations.get(session.id) ?? null,
      affected: run !== undefined && ['running', 'waiting', 'stopping', 'unknown'].includes(run.state),
      ...(run?.action === undefined ? {} : { action: run.action }),
      ...(run?.reason === undefined ? {} : { reason: run.reason }),
      notices: notices.filter((notice) => notice.session === session.id),
    }
  }))
}
