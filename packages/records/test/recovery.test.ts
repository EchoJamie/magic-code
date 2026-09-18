/**
 * U15 · 记录域 —— **恢复查询面**（在途识别）。
 *
 * 技术方案 · 记录 ·「恢复（阶段 2 · 细部）」①：在途识别＝有 `tool.call` 无 `tool.result`；
 * 领域划分：「恢复的查询面（在途识别）由记录域提供」。
 *
 * 三条判据：
 * ① **在途识别**——有 `tool.call` 无 `tool.result` 的那些调用（字段齐：链引用 / 条目配对 /
 *    裁决轨迹）；② **中断的轮**——有 `turn.start` 无 `turn.end`（③「记中止」的落点）
 *    与**轮号水位**（轮号续跑）；③ **扫描只读不判 + 了结后不复现**（恢复跑第二遍不再处置）。
 *
 * 前两条走**真库**（落进去、读回来——U02 判据 5 的姿势：断言的是落盘事实）；
 * 配对与边界几条直取纯函数（`scanForRecovery`）——它们要的是**手造的**事件 / 条目形态，
 * 而真库的写入侧硬闸不允许造出坏形态。
 */

import { describe, expect, test } from 'bun:test'
import type {
  Entry,
  EventDataOf,
  EventEnvelope,
  EventKind,
  KernelEvent,
  NewEntry,
  RecordId,
  RecordsService,
} from '@magic/contracts'
import { createRecordsStore, scanForRecovery } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

/** 工作区根（U26 起 `createRecordsStore` 必给）——本文件与归属无关，取一件固定的即可。 */
const ROOTS = ['/work/alpha']

const SESSION = 's-recovery'
const T0 = 1_700_000_000_000

/** 事件铸造——id 取自会话实例（信封归产出方铸，测试扮产出方）。 */
function makeStamper(records: RecordsService): {
  stamp: <K extends EventKind>(
    kind: K,
    data: EventDataOf[K],
    turn?: number | null,
  ) => EventEnvelope<K>
} {
  let clock = T0
  return {
    stamp: <K extends EventKind>(kind: K, data: EventDataOf[K], turn: number | null = null) => {
      clock += 1
      return { id: records.nextId(), session: SESSION, turn, at: clock, kind, data }
    },
  }
}

/** 落一条工具调用（事件 ＋ 条目）——「一次调用的两处留痕」，正是崩溃前那一刻的样子。 */
function startCall(
  records: RecordsService,
  stamp: ReturnType<typeof makeStamper>['stamp'],
  input: { readonly cmd: string; readonly turn?: number | null },
): { readonly callRef: RecordId; readonly entry: RecordId } {
  const entry = records.appendEntry({
    kind: 'tool-call',
    content: { text: '' },
    payload: { name: 'exec', args: { cmd: input.cmd } },
    at: T0,
  })

  const event = stamp('tool.call', { name: 'exec', args: { cmd: input.cmd } }, input.turn ?? 1)
  records.appendEvent(event)

  return { callRef: event.id, entry }
}

describe('判据 ① · 在途识别（真库）', () => {
  test('有 call 无 result＝在途：字段齐（链引用 / 条目配对 / 轮）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const { stamp } = makeStamper(records)

      records.appendEvent(stamp('turn.start', {}, 1))
      const started = startCall(records, stamp, { cmd: 'mkdir -p src/new' })

      const scan = await store.recoveryScan(SESSION)

      expect(scan.session).toBe(SESSION)
      expect(scan.openTurn).toBe(1)
      expect(scan.lastTurn).toBe(1)
      expect(scan.calls).toHaveLength(1)

      const call = scan.calls[0]
      expect(call?.call).toBe(started.callRef) // 链引用＝该次 tool.call 事件的 id
      expect(call?.entry).toBe(started.entry) // 条目配对键＝该次 tool-call 条目的 id
      expect(call?.name).toBe('exec')
      expect(call?.args).toEqual({ cmd: 'mkdir -p src/new' })
      expect(call?.turn).toBe(1)
      expect(call?.requested).toBe(false) // 没问过闸门
      expect(call?.decision).toBe(null) // 无从谈「未答复」——压根没问

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('了结之后不再是「在途」——恢复跑第二遍不会重复处置', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const { stamp } = makeStamper(records)

      records.appendEvent(stamp('turn.start', {}, 1))
      const started = startCall(records, stamp, { cmd: 'ls' })

      expect((await store.recoveryScan(SESSION)).calls).toHaveLength(1)

      // 恢复的落法：补一条结果条目 ＋ 一条 tool.result 事件（链引用指回原笔）
      records.appendEntry({
        kind: 'tool-result',
        content: { text: 'a.txt\n' },
        payload: { ok: true, output: { text: 'a.txt\n' } },
        at: T0,
      })
      records.appendEvent(
        stamp('tool.result', { call: started.callRef, ok: true, output: { text: 'a.txt\n' } }, 1),
      )

      const again = await store.recoveryScan(SESSION)
      expect(again.calls).toEqual([])
      expect(again.openTurn).toBe(1) // 轮还没闭合——那是恢复的另一件事（记中止）

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('已了结的调用**不报**——只报还在途的那笔（别把历史全倒出来）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const { stamp } = makeStamper(records)

      records.appendEvent(stamp('turn.start', {}, 1))
      const done = startCall(records, stamp, { cmd: 'ls' })
      records.appendEntry({
        kind: 'tool-result',
        content: { text: 'a.txt\n' },
        payload: { ok: true, output: { text: 'a.txt\n' } },
        at: T0,
      })
      records.appendEvent(
        stamp('tool.result', { call: done.callRef, ok: true, output: { text: 'a.txt\n' } }, 1),
      )

      const pending = startCall(records, stamp, { cmd: 'pwd' })

      const scan = await store.recoveryScan(SESSION)

      expect(scan.calls).toHaveLength(1)
      expect(scan.calls[0]?.call).toBe(pending.callRef)
      expect(scan.calls[0]?.args).toEqual({ cmd: 'pwd' })

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('顺带在途的两笔各自成行（同轮多工具按序）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const { stamp } = makeStamper(records)

      records.appendEvent(stamp('turn.start', {}, 1))
      startCall(records, stamp, { cmd: 'ls' })
      const second = startCall(records, stamp, { cmd: 'pwd' })

      const scan = await store.recoveryScan(SESSION)

      expect(scan.calls.map((call) => call.args['cmd'])).toEqual(['ls', 'pwd'])
      expect(scan.calls[1]?.call).toBe(second.callRef)

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})

describe('判据 ② · 裁决轨迹（真库）', () => {
  test('问了已答（批准 / 拒绝）——结论与裁者都在', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const { stamp } = makeStamper(records)

      records.appendEvent(stamp('turn.start', {}, 1))

      const approved = startCall(records, stamp, { cmd: 'mkdir src' })
      const requestId = stamp(
        'tool.decision.request',
        { call: approved.callRef, name: 'exec', material: '命令分解（1 段）', weight: 'heavy' },
        1,
      )
      records.appendEvent(requestId)
      records.appendEvent(
        stamp(
          'tool.decision',
          { call: approved.callRef, decision: 'approve', decider: 'user', elapsedMs: 1200 },
          1,
        ),
      )

      const rejected = startCall(records, stamp, { cmd: 'rm -rf build' })
      records.appendEvent(
        stamp(
          'tool.decision',
          { call: rejected.callRef, decision: 'reject', decider: 'user', elapsedMs: 800 },
          1,
        ),
      )

      const scan = await store.recoveryScan(SESSION)

      expect(scan.calls.map((call) => [call.args['cmd'], call.requested, call.decision, call.decider])).toEqual([
        ['mkdir src', true, 'approve', 'user'],
        ['rm -rf build', false, 'reject', 'user'],
      ])

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('问了**未答**——decision 留 null（④按「拒绝」落账的判据）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const { stamp } = makeStamper(records)

      records.appendEvent(stamp('turn.start', {}, 1))
      const started = startCall(records, stamp, { cmd: 'cat /etc/hosts' })
      records.appendEvent(
        stamp(
          'tool.decision.request',
          { call: started.callRef, name: 'exec', material: '读（根外）', weight: 'light' },
          1,
        ),
      )

      const scan = await store.recoveryScan(SESSION)

      expect(scan.calls[0]?.requested).toBe(true)
      expect(scan.calls[0]?.decision).toBe(null)

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})

describe('判据 ② · 中断的轮与轮号水位（真库）', () => {
  test('有 turn.start 无 turn.end＝中断的轮；闭合的轮不算', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const { stamp } = makeStamper(records)

      records.appendEvent(stamp('turn.start', {}, 1))
      records.appendEvent(stamp('turn.end', { reason: 'settled' }, 1))
      records.appendEvent(stamp('turn.start', {}, 2))

      const scan = await store.recoveryScan(SESSION)

      expect(scan.openTurn).toBe(2)
      expect(scan.lastTurn).toBe(2) // 轮号水位取最大的那个（含已闭合的）

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('全程闭合 ＋ 空会话——都没有中断的轮', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const { stamp } = makeStamper(records)

      const empty = await store.recoveryScan('s-never-written')
      expect(empty.openTurn).toBe(null)
      expect(empty.lastTurn).toBe(null)
      expect(empty.calls).toEqual([])

      records.appendEvent(stamp('turn.start', {}, 1))
      records.appendEvent(stamp('turn.end', { reason: 'settled' }, 1))

      const closed = await store.recoveryScan(SESSION)
      expect(closed.openTurn).toBe(null)
      expect(closed.lastTurn).toBe(1) // 水位照记——续跑的轮号接着 1 走

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})

describe('判据 ③ · 两侧配对与半笔（纯函数）', () => {
  function entryOf(id: RecordId, args: Readonly<Record<string, unknown>>): Entry {
    return {
      id,
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args },
      at: T0,
    }
  }

  function eventOf(id: RecordId, args: Readonly<Record<string, unknown>>): KernelEvent {
    return {
      id,
      session: SESSION,
      turn: 1,
      at: T0,
      kind: 'tool.call',
      data: { name: 'exec', args },
    } as KernelEvent
  }

  test('配对按「名 ＋ 参数」——键序不同也配得上（两边都经 JSON 往返）', () => {
    const scan = scanForRecovery({
      session: SESSION,
      events: [eventOf(3, { cmd: 'ls', cwd: '/w' })],
      entries: [entryOf(2, { cwd: '/w', cmd: 'ls' })],
    })

    expect(scan.calls).toHaveLength(1)
    expect(scan.calls[0]?.call).toBe(3)
    expect(scan.calls[0]?.entry).toBe(2)
    expect(scan.calls[0]?.args).toEqual({ cwd: '/w', cmd: 'ls' })
  })

  test('只有条目（崩在铸事件之前）/ 只有事件（崩在落条目之前）——半笔如实报', () => {
    const onlyEntry = scanForRecovery({
      session: SESSION,
      events: [],
      entries: [entryOf(2, { cmd: 'ls' })],
    })
    expect(onlyEntry.calls).toEqual([
      { call: null, entry: 2, name: 'exec', args: { cmd: 'ls' }, turn: null, requested: false, decision: null, decider: null },
    ])

    const onlyEvent = scanForRecovery({
      session: SESSION,
      events: [eventOf(3, { cmd: 'pwd' })],
      entries: [],
    })
    expect(onlyEvent.calls).toEqual([
      { call: 3, entry: null, name: 'exec', args: { cmd: 'pwd' }, turn: 1, requested: false, decision: null, decider: null },
    ])
  })

  test('两笔同名同参各自成行（按出现序，不并成一条）', () => {
    const scan = scanForRecovery({
      session: SESSION,
      events: [eventOf(3, { cmd: 'ls' }), eventOf(5, { cmd: 'ls' })],
      entries: [entryOf(2, { cmd: 'ls' }), entryOf(4, { cmd: 'ls' })],
    })

    expect(scan.calls.map((call) => [call.entry, call.call])).toEqual([
      [2, 3],
      [4, 5],
    ])
  })

  test('条目侧按**顺序**配对（第 i 个调用配第 i 个结果）——不要求紧邻', () => {
    const result = (id: RecordId): Entry => ({
      id,
      kind: 'tool-result',
      content: { text: 'x' },
      payload: { ok: true, output: { text: 'x' } },
      at: T0,
    })
    const user = (id: RecordId): Entry => ({ id, kind: 'user', content: { text: '接着说' }, at: T0 })

    // 平账（一笔调用一笔结果，只是中间夹了别的东西）——不是落单
    const balanced = scanForRecovery({
      session: SESSION,
      events: [],
      entries: [entryOf(2, { cmd: 'ls' }), user(3), result(4)],
    })
    expect(balanced.calls).toEqual([])

    // 欠账（只有调用）——落单
    const owed = scanForRecovery({ session: SESSION, events: [], entries: [entryOf(2, { cmd: 'ls' }), user(3)] })
    expect(owed.calls.map((call) => call.entry)).toEqual([2])
  })

  test('两笔落单同时存在时，恢复补记后账即平（顺序配对的意义所在）', () => {
    // 恢复的结果条目**只能追加**在尾部——两笔落单时第 1 笔永远等不到紧邻的结果
    const recovered: Entry[] = [
      entryOf(2, { cmd: 'ls' }),
      entryOf(3, { cmd: 'pwd' }),
      { id: 4, kind: 'tool-result', content: { text: 'a' }, payload: { ok: true, output: { text: 'a' } }, at: T0 },
      { id: 5, kind: 'tool-result', content: { text: 'b' }, payload: { ok: true, output: { text: 'b' } }, at: T0 },
    ]

    expect(scanForRecovery({ session: SESSION, events: [], entries: recovered }).calls).toEqual([])
  })

  test('条目形态不符（非工具条目混进 tool-call）——不当在途报出来', () => {
    const broken: NewEntry = { kind: 'tool-call', content: { text: '' }, at: T0 } // 无载荷
    const scan = scanForRecovery({
      session: SESSION,
      events: [],
      entries: [{ ...broken, id: 7 } as Entry],
    })

    expect(scan.calls).toEqual([])
  })
})
