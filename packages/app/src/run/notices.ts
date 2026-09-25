/**
 * **通知的判定与留存**（U50）——什么算一类转换、去重键怎么取、留多少条。
 *
 * 设计（会话与运行管理 · 通知）：
 *
 * > 只在**完成、失败、需要用户**三类转换时通知，**单一事实跨窗口去重**。协作中的普通
 * > 成员回报先送协调者，不每位成员结束都向用户弹一次；整合结果或需要用户的事项回原入口，
 * > 注明相关成员。通知定位会话和具体事项，**不自动答复或重跑**；**无人连接时**可使用
 * > 本机系统通知，**权限未授予不影响持久结果**，**下一次打开汇总未读事项**。
 * > **不持续播报「还在跑」**。
 *
 * 分工：**判定与留存**在这一份（什么算转换、去重、封顶、落盘形）；**什么时候说话**归
 * 管理者（`manager.ts` 那几处调用点——「跑完了」与「需要你」两档在那儿按「这条会话有没有
 * 窗口正看着它」判，**正看着就一个字都不说**，见那一处的注）；**那句话怎么说**归外壳
 * （`tui` 的 `noticeReceiptOf`——只有它认得出那条会话的标题）。
 *
 * ⚠️ **两类转换落到屏上的那句话没有了**（U74「跑完了」/ U79「需要你」，都是用户定的）——
 * `noticeReceiptOf` 对这两类**都不再产出**任何一行，管理者那一头也不再把它们送给窗口。
 * 留着的**回执**只剩「出错了」那一条。
 *
 * ⚠️ **下面那张表说的是「哪几类转换要通知」，不是「哪几类要印一行」**——两件事别混：
 * 「跑完了」「需要你」照旧各留一条通知（**系统通知 ＋ 未读**那两条路要靠它），
 * 只是它们**不再印到任何一页上**。
 *
 * ## 三条说、三条不说
 *
 * | 说 | 不说 |
 * | --- | --- |
 * | 一轮**正常跑完**了 | 还在跑（进展 / 输出 / 心跳） |
 * | 这一轮**出错**了 · 那一代**异常退出**了 | 用户自己按的停止（他刚做的，他知道） |
 * | **有人在等你**（审批 / 提问） | 空了、闲了、切了会话 |
 */

import type { NoticeKind, RunNotice, SessionId } from '@magic/contracts'

/**
 * **去重键**——一条事实一个号。
 *
 * `fact` 给的是**那件事自己的号**（`turn.end` / `tool.decision.request` 用事件 id，
 * 异常退出用代次 ＋ 时刻）：同一条事实在几个窗口之间**只算一件**（设计：「单一事实
 * **跨窗口**去重」），重放过同一批事件也不会说第二遍。
 */
export function noticeKey(session: SessionId, kind: NoticeKind, fact: string | number): string {
  return `${session}:${kind}:${String(fact)}`
}

/**
 * 留住多少条——**这是便条不是账本**。
 *
 * 留着它的用处只有一个：用户下次打开时告诉他「离开期间有哪几件」。三十二条足够覆盖
 * 「离开一会儿」的量级；再多就该去 `/resume` 里看会话本身了（那儿才是权威）。
 */
export const NOTICES_LIMIT = 32

/** 落盘那一份的形制版本——将来加字段时读的人据此判。 */
export const NOTICES_VERSION = 1

export type StoredNotices = {
  readonly v: number
  readonly at: number
  readonly notices: readonly RunNotice[]
}

/**
 * 把落盘里那一条**校验回来**——读不懂的丢掉。
 *
 * 判据与 `runs.json` 同：这是便条，坏了一条不该拦住启动；但读进来的每一条都得像样，
 * 否则「汇总未读」会拿着半截记录说出点名堂不对的话。缺 `unread` 的按**未读**算
 * （宁可多提一次，不可漏提）。
 */
export function noticeOf(raw: unknown): RunNotice | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const one = raw as Partial<RunNotice>
  if (typeof one.id !== 'string' || one.id === '') return undefined
  if (typeof one.session !== 'string' || one.session === '') return undefined
  if (one.kind !== 'done' && one.kind !== 'failed' && one.kind !== 'needs-you') return undefined
  if (typeof one.at !== 'number') return undefined

  return {
    id: one.id,
    session: one.session,
    kind: one.kind,
    at: one.at,
    ...(typeof one.detail === 'string' ? { detail: one.detail } : {}),
    unread: one.unread !== false,
  }
}
