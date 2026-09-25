/**
 * U28 · 记录域 —— **裁决的历史累计**（放行区那笔账的**跨会话**面）。
 *
 * 出处：`交接/进度台账.md` · 随批小修 12（`U22` 待决 1 · 规划侧裁：**要**）——
 * 「未配规则的调用占比」要有**历史累计**：本会话那个数（权限域的 `GateTally`）只够看
 * 「**这一趟**顺不顺」；**看「这个项目值不值得配规则」得跨会话**。
 *
 * 落点＝**记录域的读面**（`tool.decision` 事件本就在库里）：裁者在事件上，`decider`
 * 分得开三类——`auto` ＝**没问就放行**（规则或授权命中、判定为轻）· `user` ＝**问了你** ·
 * `kernel` ＝**没问就拒**（内核按名单自己拒的；⚠️ **U77 补的这一格**）。
 *
 * 三面：
 * ① **跨会话**——同一工作区的几条会话一起数（这正是「历史」二字）；
 * ② **按工作区**分——库里住着不止一个项目，别的项目那些会话不进来；
 * ③ 库是空的（或一条裁决都没走过）⇒ 两个 0——**不是没有回答**。
 *
 * ⚠️ **按 `decider` 分，不是本会话那三格**：库里那条事件记不下「命中规则却被必闸禁区否决」
 * （`vetoed`）——故历史里「还得你点」是本会话 `uncovered + vetoed` 的**并**，
 * 见契约 `DecisionHistory` 那条注。
 *
 * ⚠️ **`kernel` 与 `auto` 分开数**（U77）：两者**都"没问"**，而这本账的口径正是
 * 「没问就怎样」——合成一格，被**拒**的那几笔会被读成**放行**（正好反着）。
 */

import { describe, expect, test } from 'bun:test'
import type { Decider, KernelEvent, RecordId, RecordsService, SessionId } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

const ROOTS = ['/work/alpha']
/** 同一个库里的**另一个项目**——`dataDir` 是全局的（`~/.magic`），工作区只隔归属。 */
const ELSEWHERE = ['/work/beta']

const A = 's-alpha'
const B = 's-beta'
const C = 's-other-project'
const T0 = 1_700_000_000_000

/** 一条 `tool.decision`——放行区那笔账的**原料**（裁者在事件上，这是历史唯一的取材处）。 */
function decision(
  records: RecordsService,
  session: SessionId,
  decider: Decider,
  call: RecordId,
  at: number,
): KernelEvent {
  return {
    id: records.nextId(),
    session,
    turn: null,
    at,
    kind: 'tool.decision',
    data: { call, decision: 'approve', decider, elapsedMs: 1 },
  }
}

/**
 * 一条 `tool.decision`——**内核直接拒**那一形（U77）：`decider: 'kernel'`，结论是 `reject`。
 *
 * 造得出来才咬得住：这一笔与"没问就放行"（`auto`）**都"没问"**，而那一本账的口径
 * 正是「没问就怎样」——合成一格就会把"拒"读成"放行"。
 */
function refusal(
  records: RecordsService,
  session: SessionId,
  call: RecordId,
  at: number,
): KernelEvent {
  return {
    id: records.nextId(),
    session,
    turn: null,
    at,
    kind: 'tool.decision',
    data: { call, decision: 'reject', decider: 'kernel', elapsedMs: 1 },
  }
}

describe('裁决的历史累计（跨会话的那笔账）', () => {
  test('同一工作区的几条会话**一起数**，按 `decider` 分成两类', () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const a = store.serviceFor(A)
      const b = store.serviceFor(B)

      a.appendEvent(decision(a, A, 'auto', 1, T0))
      a.appendEvent(decision(a, A, 'auto', 2, T0 + 1))
      a.appendEvent(decision(a, A, 'user', 3, T0 + 2))
      b.appendEvent(decision(b, B, 'user', 4, T0 + 3))
      // 别的 kind 不进这笔账——分母是**裁决**，不是「事件」（`vetoed` 那条注同理：
      // 问过闸门的每一次都落一条 `tool.decision`，一条不多一条不少）
      const noise: KernelEvent = {
        id: a.nextId(),
        session: A,
        turn: null,
        at: T0 + 4,
        kind: 'model.call.start',
        data: { model: 'alpha-1', provider: 'alpha' },
      }
      a.appendEvent(noise)

      expect(store.decisionHistory()).toEqual({ total: 4, auto: 2, kernel: 0 })
      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('**按工作区**分：别的项目那些会话不进来（同一个库，两个项目）', () => {
    const dir = tempDataDir()
    try {
      const mine = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const a = mine.serviceFor(A)
      a.appendEvent(decision(a, A, 'auto', 1, T0))
      a.appendEvent(decision(a, A, 'user', 2, T0 + 1))
      mine.close()

      // 另一个项目在同一张库里干活（真情形：`dataDir` 是全局的）
      const other = createRecordsStore({ dataDir: dir, workspace: ELSEWHERE })
      const c = other.serviceFor(C)
      c.appendEvent(decision(c, C, 'auto', 3, T0 + 2))
      c.appendEvent(decision(c, C, 'auto', 4, T0 + 3))
      other.close()

      // 换回来：**只有本项目那些**——跨会话是跨会话，跨项目不是
      const again = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      expect(again.decisionHistory()).toEqual({ total: 2, auto: 1, kernel: 0 })
      again.close()
    } finally {
      removeDataDir(dir)
    }
  })

  /**
   * ⚠️ **「没问就拒」与「没问就放行」必须分得开**（U77）——这本账的口径是「**没问**就怎样」，
   * 而 `auto` 那一格说的是「没问就**放行**」。合成一格，删除那一类（`decider: 'kernel'`）
   * 会被读成"自动放行"——**正好反着**（这就是这一格的回归点）。
   *
   * 三件一起咬：**各自数各自的** ＋ **`auto` 不把 `kernel` 算进去** ＋
   * **「还得你点」＝ 差里也没有它**（拒不是"替你点过了"）。
   */
  test('**没问就拒 ≠ 没问就放行**：`kernel` 自己一格，不混进 `auto`', () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const a = store.serviceFor(A)
      a.appendEvent(decision(a, A, 'auto', 1, T0)) // 判轻：没问就**放行**
      a.appendEvent(refusal(a, A, 2, T0 + 1)) // 删除：没问就**拒**
      a.appendEvent(decision(a, A, 'user', 3, T0 + 2)) // 人答的

      const history = store.decisionHistory()
      expect(history).toEqual({ total: 3, auto: 1, kernel: 1 })
      // 「还得你点」＝ 差：3 − 1 − 1 ＝ 1——**拒的那一笔没被算成"替你点过了"**
      expect(history.total - history.auto - history.kernel).toBe(1)
      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('空库 ⇒ 两个 0（不是没有回答：问得出来，答的是「还没有」）', () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      expect(store.decisionHistory()).toEqual({ total: 0, auto: 0, kernel: 0 })
      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})
