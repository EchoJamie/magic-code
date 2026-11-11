import type { NoticeKind, SessionId } from '@magic/contracts'

/** 同一记录事实使用稳定事项 id；持久投递/已读状态统一由 records 端口保存。 */
export function noticeKey(session: SessionId, kind: NoticeKind, fact: string | number): string {
  return `${session}:${kind}:${String(fact)}`
}
