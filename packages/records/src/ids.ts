/**
 * 条目、事件、协作消息共用 records_meta 的唯一取号口。
 *
 * 协作事务会向多个成员 Session 追加引用，旧的进程内块预留会让后写的本地条目
 * 倒退到另一进程已经消费过的 id 之前。撤掉内存窗口，取号直接由一条 SQLite
 * 语句裁决；事务回滚时也没有需要同步回退的进程缓存。
 *
 * 瞬时事件在事务外取号后即持久推进水位；事务内未受理的号随事务回滚，未对外发布。
 * 编号不承担跨发送方投递顺序，收件仍由持久 position 排序。
 */
import type { Database } from 'bun:sqlite'
import type { RecordId } from '@magic/contracts'
import { META_TABLE, NEXT_ID_KEY } from './schema.ts'

export type IdSpace = { next(): RecordId }

export function createIdSpace(db: Database): IdSpace {
  const next = db.query<{ value: string }, [string]>(
    `INSERT INTO ${META_TABLE}(key,value) VALUES (?, '2')
     ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value`,
  )
  return {
    next(): RecordId {
      const row = next.get(NEXT_ID_KEY)
      if (row === null) throw new Error('记录编号未返回水位')
      return Number(row.value) - 1
    },
  }
}
