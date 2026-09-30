import type { Database } from 'bun:sqlite'
import type { AttentionItem } from '@magic/contracts'
import { ATTENTION_TABLE, type NamedParams } from './schema.ts'

/** 注意事项的持久事实；列表不消费未读，已读与系统投递分别确认。 */
export type AttentionStore = {
  /** 稳定 id 首次写入才返回 true；重放不改事实，也不覆盖已读或投递状态。 */
  put(item: AttentionItem): boolean
  /** 按 at 升序、同刻按 id 升序返回。 */
  list(): readonly AttentionItem[]
  /** 未知 id 忽略；确认已读不代表待答事项已经回答。 */
  markRead(ids: readonly string[]): void
  markDelivered(ids: readonly string[]): void
}

type AttentionRow = Omit<AttentionItem, 'detail' | 'unread' | 'delivered'> & {
  readonly detail: string | null
  readonly unread: number
  readonly delivered: number
}

/** 复用 records.db 的连接与事务；不持有第二份内存状态。 */
export function createAttentionStore(db: Database): AttentionStore {
  const insert = db.query<never, [NamedParams]>(
    `INSERT INTO ${ATTENTION_TABLE} (id, session, kind, fact, at, detail, unread, delivered)
     VALUES ($id, $session, $kind, $fact, $at, $detail, $unread, $delivered)
     ON CONFLICT(id) DO NOTHING`,
  )
  const select = db.query<AttentionRow, []>(
    `SELECT id, session, kind, fact, at, detail, unread, delivered
       FROM ${ATTENTION_TABLE} ORDER BY at ASC, id ASC`,
  )
  const read = db.query<never, [string]>(
    `UPDATE ${ATTENTION_TABLE} SET unread = 0 WHERE id = ? AND unread = 1`,
  )
  const delivered = db.query<never, [string]>(
    `UPDATE ${ATTENTION_TABLE} SET delivered = 1 WHERE id = ? AND delivered = 0`,
  )
  const markRead = db.transaction((ids: readonly string[]): void => {
    for (const id of ids) read.run(id)
  })
  const markDelivered = db.transaction((ids: readonly string[]): void => {
    for (const id of ids) delivered.run(id)
  })

  return {
    put(item) {
      return insert.run({
        $id: item.id,
        $session: item.session,
        $kind: item.kind,
        $fact: item.fact,
        $at: item.at,
        $detail: item.detail ?? null,
        $unread: Number(item.unread),
        $delivered: Number(item.delivered),
      }).changes === 1
    },
    list() {
      return select.all().map(({ detail, unread, delivered, ...fact }) => ({
        ...fact,
        ...(detail === null ? {} : { detail }),
        unread: unread === 1,
        delivered: delivered === 1,
      }))
    },
    markRead(ids) {
      if (ids.length > 0) markRead(ids)
    },
    markDelivered(ids) {
      if (ids.length > 0) markDelivered(ids)
    },
  }
}
