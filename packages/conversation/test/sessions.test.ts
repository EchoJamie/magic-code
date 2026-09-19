/**
 * U16 · **会话主面**（`createConversationService`）——列表 / 新建 / 切换 / 改名 · 单活跃。
 *
 * 这一层只管**编排**：开哪条、切到哪条、目录长什么样、忙时怎么办。
 * 「装载上下文」不在这一层——上下文每轮由条目重建（`context.ts`），换一条会话的实例
 * 就是把 `session` / 铸造器 / 记录实例一并换掉（那一跳归装配的 `open` 工厂）。
 *
 * 故本文件的替身是**记账式**的：`open` 每次调用留痕、每条会话的实例各记各的调用，
 * 「切过去之后 submit 落在谁身上」一眼可断。
 *
 * 记录域替身**自持一份**（`@magic/faux` 的记录桩是**单会话**的——`readEntries` 不分束，
 * 而本单元要验的正是按会话分束；域内测试自持替身，同 U04 对条目载荷的做法）。
 */

import { describe, expect, test } from 'bun:test'
import type {
  Entry,
  EventDataOf,
  EventKind,
  KernelEvent,
  RecordsService,
  SessionId,
  SessionSummary,
  Timestamp,
} from '@magic/contracts'
import { DEFAULT_TEST_SESSION, makeFauxSink } from '@magic/faux'
import type { FauxSink } from '@magic/faux'
import type { ConversationSession, RebuildReport } from '../src/service.ts'
import type { SessionInstance } from '../src/sessions.ts'
import { HISTORY_CHUNK, TITLE_LIMIT, createConversationService } from '../src/sessions.ts'

const T0 = 1_700_000_000_000
const A = 's-alpha'
const B = 's-beta'

// ══ 记录域替身（多会话 · 按会话分束）══════════════════════════════════

type LedgerRow = {
  readonly id: SessionId
  readonly at: Timestamp
  /** 存下来的标题（改过的）。 */
  readonly title?: string
  /** 首条用户消息的正文——默认标题的取材物。 */
  readonly first?: string
}

type Ledger = {
  readonly records: RecordsService
  /** 改名落点——装配在真库里接 `RecordsStore.setSessionTitle`。 */
  readonly renames: readonly { readonly session: SessionId; readonly title: string }[]
  setTitle(session: SessionId, title: string, at: Timestamp): void
}

function makeLedger(rows: readonly LedgerRow[]): Ledger {
  const titles = new Map<SessionId, string>()
  const times = new Map<SessionId, Timestamp>()
  const renames: { session: SessionId; title: string }[] = []

  for (const row of rows) {
    times.set(row.id, row.at)
    if (row.title !== undefined) titles.set(row.id, row.title)
  }

  const records: RecordsService = {
    nextId: () => 1,
    appendEntry: () => 1,
    appendEvent: () => undefined,
    readEntries: (sessionId: SessionId): AsyncIterable<Entry> =>
      (async function* (): AsyncIterable<Entry> {
        const row = rows.find((candidate) => candidate.id === sessionId)
        if (row?.first === undefined) return
        yield { id: 1, kind: 'user', content: { text: row.first }, at: row.at + 1 }
      })(),
    readEvents: (): AsyncIterable<KernelEvent> => (async function* (): AsyncIterable<KernelEvent> {})(),
    // 在途识别（恢复 ① · U25）——本文件的用例不验扫描，一律「干净会话」
    scanInFlight: async (session: SessionId) => ({ session, openTurn: null, lastTurn: null, calls: [] }),
    listSessions: async (): Promise<readonly SessionSummary[]> =>
      [...titles.keys(), ...times.keys()]
        .filter((id, index, all) => all.indexOf(id) === index)
        .map((id) => ({
          id,
          at: times.get(id) ?? T0,
          ...(titles.has(id) ? { title: titles.get(id) as string } : {}),
        }))
        .sort((left, right) => right.at - left.at || (left.id < right.id ? -1 : 1)),
    blobs: {
      put: async () => 'blob_1',
      get: async () => new Uint8Array(),
    },
  }

  return {
    records,
    get renames(): readonly { readonly session: SessionId; readonly title: string }[] {
      return renames
    },
    setTitle(session, title, at) {
      titles.set(session, title)
      if (!times.has(session)) times.set(session, at)
      renames.push({ session, title })
    },
  }
}

// ══ 会话实例替身（每条会话一份 · 记账）════════════════════════════════

type FakeInstance = SessionInstance & {
  readonly calls: readonly string[]
  /** 置真＝这条会话正在干活（忙碌位——`newSession` / `openSession` 的拒绝依据）。 */
  busy: boolean
}

function makeInstance(session: SessionId): FakeInstance {
  const calls: string[] = []
  const instance: FakeInstance = {
    session,
    busy: false,
    calls,
    stamper: {
      // 泛型 `K` 与 `data` 的对应关系 JS 侧无法自证（构造面的固有限制）——故有一次断言
      // （生产面同法：`app/src/assembly.ts` 的 `createStamper` 与 faux 的 `makeTestStamper`）
      stamp: <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent =>
        ({ id: 1, session, turn: null, at: T0, kind, data }) as KernelEvent,
      beginTurn: () => undefined,
    },
    service: {
      submit: (input) => {
        calls.push(`submit:${input.text}`)
      },
      interrupt: () => {
        calls.push('interrupt')
      },
      rebuild: (handoff): RebuildReport => {
        calls.push(`rebuild:${String(handoff.lastTurn)}:${String(handoff.announced)}`)
        return { session, lastTurn: handoff.lastTurn }
      },
      busy: () => instance.busy,
    } satisfies ConversationSession,
  }

  return instance
}

// ══ 装配一束（记账式）════════════════════════════════════════════════

type Bench = {
  readonly host: ReturnType<typeof createConversationService>
  readonly sink: FauxSink
  readonly instances: readonly FakeInstance[]
  readonly opened: readonly SessionId[]
  instanceOf(session: SessionId): FakeInstance | undefined
  /** 最后一次 `session.state` 的载荷。 */
  lastState(): EventDataOf['session.state'] | undefined
}

function makeBench(options: {
  readonly session?: SessionId
  readonly rows: readonly LedgerRow[]
}): Bench {
  const sink = makeFauxSink()
  const ledger = makeLedger(options.rows)
  const instances: FakeInstance[] = []
  const opened: SessionId[] = []

  const host = createConversationService({
    session: options.session ?? DEFAULT_TEST_SESSION,
    open: (session) => {
      opened.push(session)
      const instance = makeInstance(session)
      instances.push(instance)
      return instance
    },
    records: ledger.records,
    setTitle: ledger.setTitle,
    sink,
    now: () => T0,
  })

  return {
    host,
    sink,
    get instances(): readonly FakeInstance[] {
      return instances
    },
    get opened(): readonly SessionId[] {
      return opened
    },
    instanceOf: (session) => instances.filter((instance) => instance.session === session).at(-1),
    lastState: () => sink.byKind('session.state').at(-1)?.data,
  }
}

/** 事件流里的 `session.state` 载荷——按到达序。 */
function statesOf(sink: FauxSink): EventDataOf['session.state'][] {
  return sink.byKind('session.state').map((event) => event.data)
}

// ══ 判据 ══════════════════════════════════════════════════════════════

describe('列表（标题＝首条消息摘要 · 改过的取存值）', () => {
  test('三种来源各就各位：存值 · 现算 · 缺席', async () => {
    const bench = makeBench({
      session: A,
      rows: [
        { id: A, at: T0 + 2000, title: '改过的标题', first: '首条消息' },
        { id: B, at: T0 + 1000, first: '看看工作区里有什么' },
        { id: 's-gamma', at: T0 },
      ],
    })

    const listed = await bench.host.listSessions()

    expect(listed.map((row) => [row.id, row.title])).toEqual([
      [A, '改过的标题'], // 改过的——存值说了算（不拿首条消息盖回去）
      [B, '看看工作区里有什么'], // 没改过——按首条用户消息现算
      ['s-gamma', undefined], // 派生不出（没有用户消息）——**缺席**，不填空串
    ])
  })

  test('现算的要裁：首行 · 折叠空白 · 超长截断', async () => {
    const bench = makeBench({
      session: A,
      rows: [{ id: A, at: T0, first: `第一行\n\n第二行${'字'.repeat(80)}` }],
    })

    const [row] = await bench.host.listSessions()
    expect(row?.title?.startsWith('第一行 第二行')).toBe(true)
    expect(row?.title?.endsWith('…')).toBe(true)
    expect((row?.title ?? '').length).toBeLessThanOrEqual(TITLE_LIMIT + 1)
    expect(row?.title).not.toContain('\n')
  })

  test('目录**只列落过账的**——没落账的当前会话不在里头（第 19 轮 · D5）', async () => {
    const bench = makeBench({ session: A, rows: [{ id: B, at: T0, first: '别人的事' }] })

    const listed = await bench.host.listSessions()

    // A 是当下的会话但它一条都没写过 ⇒ 不列（先前它被前置进目录——那正是「空壳塞满列表」）
    expect(listed.map((row) => row.id)).toEqual([B])
    expect(bench.host.active()).toBe(A) // 当下还是它——只是还没落账
  })
})

describe('转发（单活跃——submit / interrupt / rebuild 都落在活跃实例上）', () => {
  test('开工前是开局会话；切过去之后跟着换', async () => {
    const bench = makeBench({
      session: A,
      rows: [
        { id: A, at: T0 + 1000, first: '甲的事' },
        { id: B, at: T0, first: '乙的事' },
      ],
    })
    const handoff = { lastTurn: null, announced: false }

    bench.host.submit({ text: '问甲' })
    await bench.host.rebuild(A, handoff)
    bench.host.interrupt()
    expect(bench.instanceOf(A)?.calls).toEqual(['submit:问甲', 'rebuild:null:false', 'interrupt'])
    expect(bench.instanceOf(B)).toBeUndefined()

    await bench.host.openSession(B)
    bench.host.submit({ text: '问乙' })
    expect(bench.instanceOf(B)?.calls).toEqual(['submit:问乙'])
    // 甲那边不再收——同一时刻只有一个活跃会话
    expect(bench.instanceOf(A)?.calls).toEqual(['submit:问甲', 'rebuild:null:false', 'interrupt'])
  })
})

describe('新建（session.new）', () => {
  test('开一条新会话、切过去、报当前与目录', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '甲的事' }] })
    const before = bench.host.active()

    await bench.host.handle({ type: 'session.new' })

    const after = bench.host.active()
    expect(after).not.toBe(before)
    if (after === undefined) throw new Error('新建之后该有会话了')
    expect(bench.opened).toEqual([A, after]) // 开局那条 ＋ 新开的这条
    expect(bench.lastState()?.active).toBe(after)
    // **空壳不入目录**（第 19 轮 · D5）：还没落过账的会话不列——它只在 `active` 位上示人。
    // （先前这里断言「当前会话总在目录里」，为的是 `/session` 刚建完看得见自己；
    //   用户亲跑后裁决：空壳不该把列表塞满。）
    expect(bench.lastState()?.sessions.map((row) => row.id)).toEqual([A])
    expect(bench.lastState()?.note).toBeUndefined() // 顺顺当当＝不必赘述
  })
})

describe('切换（session.open——只是装载）', () => {
  test('切到目标会话：装载它的实例、报当前', async () => {
    const bench = makeBench({
      session: A,
      rows: [
        { id: A, at: T0 + 1000, first: '甲的事' },
        { id: B, at: T0, first: '乙的事' },
      ],
    })

    await bench.host.handle({ type: 'session.open', session: B })

    expect(bench.host.active()).toBe(B)
    expect(bench.lastState()?.active).toBe(B)
    expect(bench.lastState()?.sessions.map((row) => row.title)).toEqual(['甲的事', '乙的事'])
  })

  test('切到当前会话＝无事：不重建实例、不发事件', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '甲的事' }] })
    const openedAtStart = bench.opened.length

    await bench.host.handle({ type: 'session.open', session: A })

    expect(bench.opened.length).toBe(openedAtStart)
    expect(statesOf(bench.sink).length).toBe(0)
  })

  test('切到目录里没有的 id＝开一条空的（id 是分束键，不是内容）', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '甲的事' }] })

    await bench.host.handle({ type: 'session.open', session: 's-没见过的' })

    expect(bench.host.active()).toBe('s-没见过的')
    // 它还没落过账 ⇒ **不在目录里**（目录只列库里的；`active` 另说——D5）
    expect(bench.lastState()?.sessions.map((row) => row.id)).toEqual([A])
  })
})

describe('忙时切不动（单活跃的结构保证）', () => {
  test('干活中：新建 / 切换都不动——原样留在当前会话，出声说明', async () => {
    const bench = makeBench({
      session: A,
      rows: [
        { id: A, at: T0 + 1000, first: '甲的事' },
        { id: B, at: T0, first: '乙的事' },
      ],
    })
    const instance = bench.instanceOf(A)
    if (instance === undefined) throw new Error('开局实例没建起来')
    instance.busy = true

    await bench.host.handle({ type: 'session.new' })
    await bench.host.handle({ type: 'session.open', session: B })

    // 原地不动——**不半途改**（半途改＝一轮的事记到两条会话上）
    expect(bench.host.active()).toBe(A)
    expect(bench.instanceOf(B)).toBeUndefined()
    expect(bench.lastState()?.active).toBe(A)
    expect(bench.lastState()?.note).toContain('正在跑')
  })

  test('忙时列表照问（只读的事不必等）', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '甲的事' }] })
    const instance = bench.instanceOf(A)
    if (instance === undefined) throw new Error('开局实例没建起来')
    instance.busy = true

    await bench.host.handle({ type: 'session.list' })

    expect(bench.lastState()?.sessions.map((row) => row.id)).toEqual([A])
    expect(bench.lastState()?.note).toBeUndefined()
  })
})

describe('改名（session.rename）', () => {
  test('落定 ＋ 目录随即带出新标题', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '原来那条' }] })

    await bench.host.handle({ type: 'session.rename', session: A, title: '换了个名字' })

    expect(bench.lastState()?.sessions.map((row) => row.title)).toEqual(['换了个名字'])
    expect(bench.lastState()?.note).toBeUndefined()
  })

  test('先裁后存——用户给的原文里带换行也存得下（存的是裁过的）', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '原来那条' }] })

    await bench.host.handle({ type: 'session.rename', session: A, title: `  两个\n行  ` })

    expect(bench.lastState()?.sessions.map((row) => row.title)).toEqual(['两个 行'])
  })

  test('空标题＝不认（目录里的名字不归它腾空）', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '原来那条' }] })

    await bench.host.handle({ type: 'session.rename', session: A, title: '   ' })

    expect(bench.lastState()?.sessions.map((row) => row.title)).toEqual(['原来那条'])
    expect(bench.lastState()?.note).toContain('空')
  })

  test('改别人的标题不影响当前会话（标题是会话的属性，不是活跃位的）', async () => {
    const bench = makeBench({
      session: A,
      rows: [
        { id: A, at: T0 + 1000, first: '甲的事' },
        { id: B, at: T0, first: '乙的事' },
      ],
    })

    await bench.host.handle({ type: 'session.rename', session: B, title: '给乙改的' })

    expect(bench.host.active()).toBe(A)
    expect(bench.lastState()?.sessions.map((row) => row.title)).toEqual(['甲的事', '给乙改的'])
  })
})

describe('重建面（rebuild——恢复的第 ⑤ 步 · U25）', () => {
  test('落在目标会话上，水位与开工位原样交给实例，报告交回调用方', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '甲的事' }] })

    const report = await bench.host.rebuild(A, { lastTurn: 7, announced: true })

    expect(bench.instanceOf(A)?.calls).toEqual(['rebuild:7:true'])
    expect(report).toEqual({ session: A, lastTurn: 7 })
  })

  test('**外壳得知道自己落在哪条会话上**——重建报一条 `session.state`（界面重建展示的由头）', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '甲的事' }] })

    await bench.host.rebuild(A, { lastTurn: null, announced: false })

    // 接续一条旧会话时，状态行不能还写着「新会话」——`active` 就是外壳据以重开一屏的那一位
    expect(bench.lastState()?.active).toBe(A)
  })

  test('目标不是当下这条＝装载（换过去；单活跃）', async () => {
    const bench = makeBench({
      session: A,
      rows: [
        { id: A, at: T0 + 1000, first: '甲的事' },
        { id: B, at: T0, first: '乙的事' },
      ],
    })

    await bench.host.rebuild(B, { lastTurn: 3, announced: true })

    expect(bench.host.active()).toBe(B)
    expect(bench.instanceOf(B)?.calls).toEqual(['rebuild:3:true'])
  })

  test('忙时切不动——与 `session.open` 同一道闸（半途切＝一轮的事记到两条会话上）', async () => {
    const bench = makeBench({
      session: A,
      rows: [
        { id: A, at: T0 + 1000, first: '甲的事' },
        { id: B, at: T0, first: '乙的事' },
      ],
    })
    bench.instanceOf(A)!.busy = true

    await expect(bench.host.rebuild(B, { lastTurn: null, announced: false })).rejects.toThrow(
      '正在跑一轮',
    )
    expect(bench.host.active()).toBe(A)
  })
})

// ══ 第 19 轮补锚的判据（缺陷轮 I）════════════════════════════════════

describe('懒建立（D5）——首条消息才开张', () => {
  test('不给开局会话＝**一条都不开**：不铸 id、不开实例', () => {
    const sink = makeFauxSink()
    const opened: SessionId[] = []
    const host = createConversationService({
      // 不给 session——空手打开
      open: (session) => {
        opened.push(session)
        return makeInstance(session)
      },
      records: makeLedger([]).records,
      setTitle: () => undefined,
      sink,
      now: () => T0,
    })

    expect(host.active()).toBeUndefined()
    expect(opened).toEqual([]) // 一个实例都没开——更没铸 id
    expect(sink.events).toEqual([]) // 也一个事件都没发
  })

  test('首条消息按下回车——**这才开张**（铸 id ＋ 开实例）', () => {
    const sink = makeFauxSink()
    const opened: SessionId[] = []
    const host = createConversationService({
      open: (session) => {
        opened.push(session)
        return makeInstance(session)
      },
      records: makeLedger([]).records,
      setTitle: () => undefined,
      sink,
      now: () => T0,
    })

    host.submit({ text: '第一句' })

    expect(opened).toHaveLength(1)
    expect(host.active()).toBe(opened[0])
    expect(opened[0]).not.toBeUndefined()
  })

  test('没有会话时中断＝无事（不开张、不发声）', () => {
    const sink = makeFauxSink()
    const host = createConversationService({
      open: (session) => makeInstance(session),
      records: makeLedger([]).records,
      setTitle: () => undefined,
      sink,
      now: () => T0,
    })

    expect(() => host.interrupt()).not.toThrow()
    expect(host.active()).toBeUndefined()
    expect(sink.events).toEqual([]) // 一个事件都没发
  })

  test('重建面**照 id 装载**——空手也开得出来（「以会话为入口」的那条路）', async () => {
    const sink = makeFauxSink()
    const host = createConversationService({
      open: (session) => makeInstance(session),
      records: makeLedger([]).records,
      setTitle: () => undefined,
      sink,
      now: () => T0,
    })

    // 与「首条消息才开张」不冲突：这条路是**用户点名**了要哪条会话（`--session` / 接续），
    // 不是空手打开（D5 免的是后者：不开张、不占存储、不把列表塞满空壳）
    const report = await host.rebuild('s-picked', { lastTurn: null, announced: false })

    expect(report.session).toBe('s-picked')
    expect(host.active()).toBe('s-picked')
    expect(sink.byKind('session.state').at(-1)?.data.active).toBe('s-picked')
  })
})

describe('标题上限（D2）——**生成时就截**，不是呈现时截', () => {
  test('现算那条：一行 · 到上限即止 · 带省略号', async () => {
    const long = '帮我看一下 src 下这几个文件为什么报错，另外把 README 也更新一下'
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: long }] })

    const [row] = await bench.host.listSessions()
    const title = row?.title ?? ''

    expect(title.length).toBeLessThanOrEqual(TITLE_LIMIT + 1) // 上限 ＋ 省略号那一个字符
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toContain('\n')
    expect(long.startsWith(title.slice(0, -1))).toBe(true) // 是**前缀**，不是随便截的
  })

  test('改名那条走**同一条**裁法（两处各裁一遍＝迟早不一样）', async () => {
    const bench = makeBench({ session: A, rows: [{ id: A, at: T0, first: '甲的事' }] })

    await bench.host.handle({ type: 'session.rename', session: A, title: '名'.repeat(60) })

    const stored = bench.lastState()?.sessions.find((row) => row.id === A)?.title ?? ''
    expect(stored.length).toBeLessThanOrEqual(TITLE_LIMIT + 1)
    expect(stored.endsWith('…')).toBe(true)
  })
})

describe('读面（history.read）——重建展示的条目块', () => {
  test('分块推：块块拼起来是全文，**末块 done**', async () => {
    const sink = makeFauxSink()
    const total = HISTORY_CHUNK + 3
    const host = createConversationService({
      session: A,
      open: (session) => makeInstance(session),
      records: {
        listSessions: async () => [],
        readEntries: (): AsyncIterable<Entry> =>
          (async function* (): AsyncIterable<Entry> {
            for (let index = 1; index <= total; index += 1) {
              yield { id: index, kind: 'user', content: { text: `第 ${index} 条` }, at: T0 + index }
            }
          })(),
        blobs: { put: async () => 'blob_1', get: async () => new Uint8Array() },
      },
      setTitle: () => undefined,
      sink,
      now: () => T0,
    })

    await host.readHistory()

    const blocks = sink.byKind('session.history').map((event) => event.data)
    expect(blocks.map((block) => block.done)).toEqual([false, true]) // 一块未完 ＋ 一块收尾
    expect(blocks.flatMap((block) => block.entries).length).toBe(total) // 一条不多一条不少
    expect(blocks.every((block) => block.session === A)).toBe(true)
  })

  test('空会话也收尾——**发一块空的 done**（不能只推空的就哑了）', async () => {
    const bench = makeBench({ session: A, rows: [] })

    await bench.host.readHistory()

    const blocks = bench.sink.byKind('session.history').map((event) => event.data)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ session: A, done: true })
    expect(blocks[0]?.entries).toEqual([])
  })

  test('没有会话＝不推（没得读，也不为它开一张）', async () => {
    const sink = makeFauxSink()
    const host = createConversationService({
      open: (session) => makeInstance(session),
      records: makeLedger([]).records,
      setTitle: () => undefined,
      sink,
      now: () => T0,
    })

    await host.readHistory()

    expect(sink.byKind('session.history')).toEqual([])
    expect(host.active()).toBeUndefined() // 读一下不该把会话开出来
  })
})
