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
 *
 * **U47 · 块预留是记录域的短事务**（设计 · 会话与运行管理「多执行者共享数据的前置条件」
 * 第一条）：原先「读水位 → 加一块 → 写回」是三次分开的动作，两个执行者同时预留会
 * **读到同一个水位**、各自从同一个 base 发号 ⇒ **重号**。现在这三步合进**一条 SQL**
 * （`INSERT … ON CONFLICT DO UPDATE … RETURNING`）——SQLite 把单条语句当一次隐式事务
 * 执行，写锁一拿到底，故「读到的水位」与「写回的水位」之间没有缝。**交给数据库，
 * 而不是自己 `BEGIN`**：自己起事务在「已在别的事务里」时会炸，而这条语句没有那个形态。
 *
 * **单进程下的行为逐位不变**（收口不是加功能）：空库仍从 1 起（`INSERT` 那一支写
 * `1+BLOCK`、返回 `1+BLOCK`）、水位仍按块推、发出去的号与跳号位置一模一样——
 * 变的只是「这三步之间能不能插进另一个执行者」。设计里那两条跨会话的规矩（id 不代表全机
 * 先后 · 重连水位限定同一 Session/Run）不受影响：本文件只管发号，不管谁拿号。
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
  /**
   * **预留一块＝一条语句**（读改写同体，见文件头注「U47」）。
   *
   * 两支各写各的初值、`RETURNING` 统一给**推高之后**的水位：
   * - **空库**（无行）：`INSERT` 写 `1 + BLOCK`，返回它——`base` 反推回来正是 `1`；
   * - **既有库**：`DO UPDATE` 就地加一块，返回加完之后的值——`base` 反推正是原值。
   *
   * 值走 `CAST(… AS INTEGER)` 再加：水位列是 `TEXT`（`records_meta.value`），
   * 存进去时由列亲和性转回文本——与原先 `String(next)` 落盘的是同一个字面。
   */
  const reserveBlock = db.query<{ value: string }, []>(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (${quote(NEXT_ID_KEY)}, ${1 + RESERVE_BLOCK})
       ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ${RESERVE_BLOCK}
     RETURNING value`,
  )

  let cursor = 0 // 下一个可发的号
  let ceiling = 0 // 已预留区间的上界（不含）

  /** 预留一块——把水位推上去，号码落进内存窗口。重启后从水位续，绝不回头。 */
  const reserve = (): void => {
    const row = reserveBlock.get()
    // `DO UPDATE` 那一支必给一行（`DO NOTHING` 才会什么都不给）——给不出就是语句被改坏了。
    // 此处**不猜**：凭猜接着发号＝静默重号，那正是本单元要治的那件事。
    if (row === null) {
      throw new Error('块预留没拿回新水位（`RETURNING` 一行都没给）——拒绝凭猜发号')
    }
    const next = Number(row.value)
    cursor = next - RESERVE_BLOCK
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
