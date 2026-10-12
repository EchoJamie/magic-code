import type { Database } from 'bun:sqlite'
import type { AttentionItem } from '@magic/contracts'
import { ATTENTION_TABLE, type NamedParams } from './schema.ts'

export type AttentionQuery = {
  readonly sessions?: readonly string[]
  readonly unread?: boolean
}

/** 每件工作只维护当前来源；投递与呈现回执必须匹配该来源。 */
export type AttentionStore = {
  put(item: AttentionItem): boolean
  list(query?: AttentionQuery): readonly AttentionItem[]
  clear(session: string): void
  markRead(ids: readonly string[]): void
  markDelivered(ids: readonly string[]): void
}

type AttentionRow = Omit<AttentionItem, 'detail' | 'source' | 'unread' | 'delivered'> & {
  readonly detail: string | null
  readonly source: string | null
  readonly unread: number
  readonly delivered: number
}

const columns = 'id, session, kind, fact, at, detail, source, unread, delivered'
const order = "at DESC, COALESCE(json_extract(source, '$.event'), json_extract(source, '$.entry'), 0) DESC, id DESC"

function itemOf({ detail, source, unread, delivered, ...fact }: AttentionRow): AttentionItem {
  return {
    ...fact,
    ...(detail === null ? {} : { detail }),
    ...(source === null ? {} : { source: JSON.parse(source) as NonNullable<AttentionItem['source']> }),
    unread: unread === 1,
    delivered: delivered === 1,
  }
}

export function createAttentionStore(db: Database): AttentionStore {
  const current = db.query<AttentionRow, [string]>(
    `SELECT ${columns} FROM ${ATTENTION_TABLE} WHERE session=? ORDER BY ${order} LIMIT 1`,
  )
  const insert = db.query<never, [NamedParams]>(
    `INSERT INTO ${ATTENTION_TABLE} (${columns})
     VALUES ($id, $session, $kind, $fact, $at, $detail, $source, $unread, $delivered)`,
  )
  const update = db.query<never, [NamedParams]>(
    `UPDATE ${ATTENTION_TABLE} SET id=$id, kind=$kind, fact=$fact, at=$at,
     detail=$detail, source=$source, unread=$unread, delivered=$delivered WHERE id=$previous AND session=$session`,
  )
  const exists = db.query<{ id: string }, [string]>(`SELECT id FROM ${ATTENTION_TABLE} WHERE id=?`)
  const put = db.transaction((item: AttentionItem): boolean => {
    if (exists.get(item.id) !== null) return false
    const previous = current.get(item.session)
    if (previous !== null) {
      const old = itemOf(previous)
      const sourceOrder = (one: AttentionItem) => one.source?.event ?? one.source?.entry ?? 0
      if (item.at < old.at || (item.at === old.at && sourceOrder(item) <= sourceOrder(old))) return false
    }
    const values: NamedParams = {
      $id: item.id, $session: item.session, $kind: item.kind, $fact: item.fact, $at: item.at,
      $detail: item.detail ?? null, $source: item.source === undefined ? null : JSON.stringify(item.source),
      $unread: Number(item.unread), $delivered: Number(item.delivered),
    }
    if (previous === null) insert.run(values)
    else update.run({ ...values, $previous: previous.id })
    return true
  })
  const acknowledge = (column: 'unread' | 'delivered', value: number) => {
    const statement = db.query<never, [number, string]>(
      `UPDATE ${ATTENTION_TABLE} SET ${column}=? WHERE id=? AND ${column}<>${value} AND id=(
       SELECT id FROM ${ATTENTION_TABLE} latest WHERE latest.session=${ATTENTION_TABLE}.session ORDER BY ${order} LIMIT 1)`,
    )
    return db.transaction((ids: readonly string[]) => {
      for (const id of ids) statement.run(value, id)
    })
  }
  const read = acknowledge('unread', 0)
  const delivered = acknowledge('delivered', 1)
  return {
    put: item => put.immediate(item),
    clear: session => { db.query(`DELETE FROM ${ATTENTION_TABLE} WHERE session=?`).run(session) },
    list(query = {}) {
      if (query.sessions?.length === 0) return []
      const params: NamedParams = {}
      const scope = query.sessions === undefined ? '' : `WHERE session IN (${query.sessions.map((session, index) => {
        const key = `$session${index}`
        params[key] = session
        return key
      }).join(',')})`
      const unread = query.unread === undefined ? '' : 'AND unread=$unread'
      if (query.unread !== undefined) params.$unread = Number(query.unread)
      // 先取当前来源，再筛未读；旧未读不能在新来源已读后重新出现。
      return db.query<AttentionRow, [NamedParams]>(
        `SELECT ${columns} FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY session ORDER BY ${order}) AS rank
         FROM ${ATTENTION_TABLE} ${scope}) WHERE rank=1 ${unread} ORDER BY at, id`,
      ).all(params).map(itemOf)
    },
    markRead: ids => { if (ids.length > 0) read.immediate(ids) },
    markDelivered: ids => { if (ids.length > 0) delivered.immediate(ids) },
  }
}
