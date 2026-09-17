/**
 * id 空间——`RecordId`（条目 / 事件共用）的**唯一主人**（判据 1 · `nextId()`）。
 *
 * 出处：技术方案 · 领域划分（「信封的归属」）——id 空间归记录域；装配据 `nextId()`
 * 构造 `EventStamper`，各域产出方铸信封时不各自取号。
 *
 * 三条约束：
 * 1. **一张表、一条流**——条目与事件同取一个计数器，故 id 全局唯一、单调（排序权威）；
 * 2. **同步可取**——`nextId(): RecordId` 是端口上的同步签名；`bun:sqlite` 同步，
 *    故此处可同步落账；
 * 3. **重启不重用**——**块预留**：一次把 `[cursor, cursor+BLOCK)` 写进库，
 *    之后从内存发号。瞬时事件（`model.delta` 等不落库）也吃号，故计数器
 *    **不能**由 `max(表.id)` 反推——那会让重启后重发已发过的号。块预留的代价是
 *    **跳号**：库里看到的空档＝期间有瞬时事件消耗。单调性与唯一性不受影响。
 */

import type { Database } from 'bun:sqlite'
import type { RecordId } from '@magic/contracts'
import { META_TABLE, NEXT_ID_KEY } from './schema.ts'

/**
 * 一次预留多少个号。
 *
 * 发号在流式路径上（每个 `model.delta` 都铸信封）——逐号落库＝一轮几千次写，
 * 会把流式卡出抖动（R3：流式不卡）。512 把这个代价摊到可忽略，跳号上限也还好看。
 */
const RESERVE_BLOCK = 512

export type IdSpace = {
  next(): RecordId
}

export function createIdSpace(db: Database): IdSpace {
  const readWatermark = db.query<{ value: string }, []>(
    `SELECT value FROM ${META_TABLE} WHERE key = ${quote(NEXT_ID_KEY)}`,
  )
  const writeWatermark = db.query<never, [string]>(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (${quote(NEXT_ID_KEY)}, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )

  let cursor = 0 // 下一个可发的号
  let ceiling = 0 // 已预留区间的上界（不含）

  /** 预留一块——把水位推上去，号码落进内存窗口。重启后从水位续，绝不回头。 */
  const reserve = (): void => {
    const row = readWatermark.get() // 无行＝库还是新的（bun:sqlite 的 `.get()` 无行给 null）
    const base = row === null ? 1 : Number(row.value)
    const next = base + RESERVE_BLOCK
    writeWatermark.run(String(next))
    cursor = base
    ceiling = next
  }

  return {
    next(): RecordId {
      if (cursor >= ceiling) reserve()
      const id = cursor
      cursor += 1
      return id
    },
  }
}

/** SQL 字面量——常量拼进语句（`PRAGMA` / 键名不接受参数位）。 */
function quote(literal: string): string {
  return `'${literal.replaceAll("'", "''")}'`
}
