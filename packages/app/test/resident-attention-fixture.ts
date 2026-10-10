import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type { AttentionItem } from '@magic/contracts'

/** 观察运行中的 Engine 数据库；不初始化 schema 或争抢写锁。 */
export function attentionFacts(dataDir: string, _workspace: string): readonly AttentionItem[] {
  const db = new Database(join(dataDir, 'records.db'), { readonly: true })
  try {
    return (db.query('SELECT * FROM attention_items ORDER BY at, id').all() as (Omit<AttentionItem, 'unread' | 'delivered' | 'detail'> & { unread: number; delivered: number; detail: string | null })[])
      .map(({ unread, delivered, detail, ...row }) => ({ ...row, unread: unread === 1, delivered: delivered === 1, ...(detail === null ? {} : { detail }) }))
  } finally { db.close() }
}
