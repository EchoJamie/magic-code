import type { EventDataOf, SessionManagement, SessionManagementResult } from '@magic/contracts'
import { summarize } from '@magic/conversation'
import type { RecordsStore } from '@magic/records'
import { captureCollaborationNative } from './collaboration-native.ts'
import { canArchiveRun, type RunRecord } from './facts.ts'

export const ARCHIVED_NOTE = '会话已归档，请在会话管理或 /resume 的已归档列表中恢复'

/** 独占输入准入计数；运行事实只读借用原对象，不建立另一份运行状态。
 * 资格判断和持久提交之间不让出事件循环。
 */
export function createSessionManagement(input: {
  store: RecordsStore
  now: () => number
  liveOf: (session: string) => {
    readonly run: Readonly<RunRecord>
    readonly queued: readonly unknown[]
  } | undefined
  lastRuns: ReadonlyMap<string, Readonly<RunRecord>>
  accepting: () => boolean
  terminalOpen: (session: string) => boolean
  onArchived: (session: string) => void
  changed: (data: EventDataOf['session.changed']) => void
}) {
  const { store, now, liveOf, lastRuns, accepting, terminalOpen, onArchived, changed } = input
  const workRoot = (session: string): string => store.collaboration.collaborationForSession(session)?.originSessionId ?? session
  const admissions = new Map<string, number>()
  const isArchived = (session: string): boolean => store.isSessionArchived(workRoot(session))
  function canArchive(session: string): boolean {
    const root = workRoot(session)
    if (!store.hasSession(root) || isArchived(root) || (admissions.get(root) ?? 0) > 0) return false
    const group = captureCollaborationNative(store.collaboration, [root]).groups[0]
    const members = new Set([root, ...(group?.members.map(member => member.sessionId) ?? [])])
    for (const member of members) {
      const executor = liveOf(member)
      const run = executor?.run ?? lastRuns.get(member)
      if (run !== undefined && !canArchiveRun(run)) return false
      if (executor !== undefined && (executor.queued.length > 0 || store.serviceFor(member).inputs.list().some(
        input => input.state === 'pending' && input.reason === undefined,
      ))) return false
    }
    if (group !== undefined) {
      if (group.executions.some(e => e.state !== 'finished')) return false
      if (group.collaboration.state === 'open' || group.collaboration.state === 'closing') {
        if (group.collaboration.state === 'closing' || group.members.some(m => m.reachability === 'suspended') || group.waits.some(w => w.state === 'waiting')) return false
        if (group.delegations.some(d => !['received', 'rejected', 'cancelled'].includes(d.state) || (d.deliveryMessageId !== undefined && d.receivedAt === undefined))) return false
        if (group.members.some(member => store.collaboration.inbox(member.agentId).some(
          item => item.state === 'pending' && store.collaboration.readMessage(member.agentId, item.messageId)?.purpose !== 'receipt',
        ))) return false
      }
    }
    return true
  }
  function manageSession(item: SessionManagement): SessionManagementResult {
    const session = workRoot(item.session)
    try {
      if (!accepting()) throw new Error('Engine 正在停止，请稍后重试')
      if (!store.hasSession(item.session) || !store.hasSession(session)) throw new Error('会话已不可达')
      if (item.action === 'rename') {
        if (isArchived(session)) throw new Error('会话已归档，请先恢复后再改名')
        const title = summarize(item.title ?? '')
        if (title === undefined) throw new Error('会话名称不能为空')
        store.setSessionTitle(session, title, now())
      } else {
        const archived = item.action === 'archive'
        if (isArchived(session) !== archived) {
          if (archived && !canArchive(session)) throw new Error('工作仍在执行、等待输入消费或资源状态待确认，暂不能归档')
          // 资格核定到持久提交不让出事件循环，与输入受理共用 Engine 顺序。
          store.setSessionArchived(session, archived)
          if (archived) {
            store.attention.clear(session)
            onArchived(session)
          }
        }
      }
      const data = { session, archived: isArchived(session), canArchive: canArchive(session), terminalOpen: terminalOpen(session) }
      changed(data)
      return { ...item, session, ok: true, archived: data.archived }
    } catch (error) { return { ...item, session, ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  return {
    workRoot, isArchived, canArchive, manageSession,
    admit(root: string): () => void {
      admissions.set(root, (admissions.get(root) ?? 0) + 1)
      return () => {
        const count = (admissions.get(root) ?? 1) - 1
        if (count === 0) admissions.delete(root)
        else admissions.set(root, count)
      }
    },
  }
}
