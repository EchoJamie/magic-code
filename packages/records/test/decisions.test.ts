/**
 * U28 · 记录域 —— **裁决的历史累计**（放行区那笔账的**跨会话**面）。
 *
 * 出处：`交接/进度台账.md` · 随批小修 12（`U22` 待决 1 · 规划侧裁：**要**）——
 * 「未配规则的调用占比」要有**历史累计**：本会话那个数（权限域的 `GateTally`）只够看
 * 「**这一趟**顺不顺」；**看「这个项目值不值得配规则」得跨会话**。
 *
 * 落点＝**记录域的读面**（`tool.decision` 事件本就在库里）：裁者在事件上，`decider`
 * 分得开两类——`auto` ＝**没问就放行**（规则或授权命中、判定为轻）· `user` ＝**问了你**。
 *
 * 三面：
 * ① **跨会话**——同一工作区的几条会话一起数（这正是「历史」二字）；
 * ② **按工作区**分——库里住着不止一个项目，别的项目那些会话不进来；
 * ③ 库是空的（或一条裁决都没走过）⇒ 两个 0——**不是没有回答**。
 *
 * ⚠️ **只有两类，不是本会话那三格**：库里那条事件记不下「命中规则却被必闸禁区否决」
 * （`vetoed`）——故历史里「还得你点」是本会话 `uncovered + vetoed` 的**并**，
 * 见契约 `DecisionHistory` 那条注。
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

      expect(store.decisionHistory()).toEqual({ total: 4, auto: 2 })
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
      expect(again.decisionHistory()).toEqual({ total: 2, auto: 1 })
      again.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('空库 ⇒ 两个 0（不是没有回答：问得出来，答的是「还没有」）', () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      expect(store.decisionHistory()).toEqual({ total: 0, auto: 0 })
      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})
