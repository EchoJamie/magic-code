/**
 * U02 · 记录库 —— **判据 1（落取回环）· 判据 5（独立验证：直读库表断言）**。
 *
 * 判据 1：造 4 类条目（user / assistant / tool-call 含载荷 / tool-result 含 output）
 * ＋ 4 类事件 → 读回**逐字段相等**（连键集一起比——多一个字段同样是差异）。
 * 判据 5：断言**直读库表**——先关连接，再用裸 `bun:sqlite` 打开库文件，
 * 逐行逐列对账（不经 API 回读闭环，也不吃「内存里对」的假绿）。
 *
 * 端口姿势见 `@magic/contracts` · `RecordsService`。会话归属由**实例**承载
 * （`store.serviceFor(session)`）——条目形态不带 session 字段，写入侧的归属只能由实例给；
 * 事件则自带 `session` 信封，两者须一致（见 `src/store.ts` 头注）。
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type {
  AssistantPayload,
  Entry,
  EventDataOf,
  EventEnvelope,
  EventKind,
  KernelEvent,
  NewEntry,
  PlanNote,
  RecordId,
  SessionId,
  ToolResultPayload,
  TurnId,
  UserPayload,
} from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { databasePathOf, removeDataDir, tempDataDir } from './tmp.ts'

/** 工作区根（U26 起 `createRecordsStore` 必给）——本文件与归属无关，取一件固定的即可。 */
const ROOTS = ['/work/alpha']

const SESSION: SessionId = 's-0001'
const OTHER_SESSION: SessionId = 's-0002'
const T0 = 1_700_000_000_000

/** `{ id, ...条目 }`——把 `appendEntry` 返回的 id 补回，作为「逐字段相等」的对照物。 */
function withIds(entries: readonly NewEntry[], ids: readonly RecordId[]): Entry[] {
  return entries.map((entry, index) => {
    const id = ids[index]
    if (id === undefined) throw new Error(`第 ${index} 条没拿到 id`)
    return { id, ...entry }
  })
}

/** 直读库表用的行形态（列名即实现落盘形态——判据 5 要的就是它）。 */
type RawEntryRow = {
  id: number
  session: string
  kind: string
  content_kind: string
  content_text: string | null
  content_blob: string | null
  payload: string | null
  at: number
  source: string | null
}

type RawEventRow = {
  id: number
  session: string
  turn: number | null
  at: number
  kind: string
  data: string
}

/** 一次「写满四类」的夹具——条目与事件共用同一份。 */
function fourEntries(blobRef: string): NewEntry[] {
  return [
    {
      kind: 'user',
      content: { text: '把 playground 里的脚本跑一遍\n第二行也要原样回来' },
      at: T0 + 1,
    },
    {
      kind: 'assistant',
      content: { text: '好——先看一眼那个文件，再决定怎么跑。' },
      at: T0 + 2,
    },
    {
      kind: 'tool-call',
      content: { text: 'exec: ls -la playground' },
      payload: {
        name: 'exec',
        args: {
          cmd: 'ls -la playground',
          cwd: '/tmp/work',
          options: { follow: true, depth: 3, filters: ['*.ts', '*.md'] },
          threshold: 1.5,
          dryRun: false,
          note: null,
          unicode: '中文 · 换行\n制表\t· 引号"· 反斜杠\\',
        },
      },
      at: T0 + 3,
      source: OTHER_SESSION, // 来源引用（协作预留字段）——一并验往返
    },
    {
      kind: 'tool-result',
      content: { text: 'exit=1（目录不存在）' },
      payload: { ok: false, output: { blob: blobRef } },
      at: T0 + 4,
    },
  ]
}

describe('判据 1 · 落取回环', () => {
  test('四类条目 + 四类事件落库后读回逐字段相等（含键集）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)

      // 大负载先落 blob——条目只存引用（判据 2 细究 blob 本身，这里验引用往返）
      const blobRef = await records.blobs.put('playground/ 下没有那个文件\n'.repeat(200))

      const entries = fourEntries(blobRef)
      const entryIds = entries.map((entry) => records.appendEntry(entry))

      let clock = T0
      const callId = records.nextId() // tool.call 事件的 id——`call` 引用它（三个 id 空间之一）
      const stamp = <K extends EventKind>(
        kind: K,
        data: EventDataOf[K],
        turn: TurnId | null = null,
      ): EventEnvelope<K> => {
        clock += 1
        return { id: records.nextId(), session: SESSION, turn, at: clock, kind, data }
      }

      const events: KernelEvent[] = [
        stamp('agent.start', {}),
        stamp('turn.end', { reason: 'aborted' }, 2),
        stamp('model.usage', { inputTokens: 1234, outputTokens: 5678 }, 2),
        stamp('tool.decision.request', {
          call: callId,
          name: 'exec',
          material: '命令分解：\n  rm -rf build/  ← 删除 · 不可逆',
          weight: 'heavy',
        }),
      ]
      for (const event of events) records.appendEvent(event)

      // —— 读回：条目 ——
      const readEntries: Entry[] = []
      for await (const entry of records.readEntries(SESSION)) readEntries.push(entry)

      expect(readEntries).toEqual(withIds(entries, entryIds))
      expect(readEntries.map((entry) => Object.keys(entry).sort())).toEqual(
        entries.map((entry) => Object.keys(entry).concat('id').sort()),
      )
      // 逐字段点名（回环之外，也让「哪一列丢了」一眼可见）
      expect(readEntries.map((entry) => entry.kind)).toEqual([
        'user',
        'assistant',
        'tool-call',
        'tool-result',
      ])
      expect(readEntries.map((entry) => entry.at)).toEqual([T0 + 1, T0 + 2, T0 + 3, T0 + 4])
      expect(readEntries[3]?.payload).toEqual({ ok: false, output: { blob: blobRef } })
      expect(readEntries[3]?.content).toEqual({ text: 'exit=1（目录不存在）' })
      expect(readEntries[0]?.content).toEqual({ text: '把 playground 里的脚本跑一遍\n第二行也要原样回来' })
      expect(readEntries[2]?.source).toBe(OTHER_SESSION)

      // —— 读回：事件 ——
      const readEvents: KernelEvent[] = []
      for await (const event of records.readEvents(SESSION)) readEvents.push(event)

      expect(readEvents).toEqual(events)
      expect(readEvents.map((event) => event.kind)).toEqual([
        'agent.start',
        'turn.end',
        'model.usage',
        'tool.decision.request',
      ])
      expect(readEvents.map((event) => event.turn)).toEqual([null, 2, 2, null])
      expect(readEvents[0]?.data).toEqual({})
      expect(readEvents[3]?.data).toEqual({
        call: callId,
        name: 'exec',
        material: '命令分解：\n  rm -rf build/  ← 删除 · 不可逆',
        weight: 'heavy',
      })

      // id 空间归记录域——条目与事件共用、单调、不撞
      const allIds = [...entryIds, ...events.map((event) => event.id)]
      expect(new Set(allIds).size).toBe(allIds.length)
      expect([...allIds].sort((a, b) => a - b)).toEqual(allIds)

      // 分束——别的会话读不到本会话的东西
      const foreign: Entry[] = []
      for await (const entry of records.readEntries(OTHER_SESSION)) foreign.push(entry)
      expect(foreign).toEqual([])

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('条目范围＝按 id 的闭区间（含端点）；越界即空', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)

      const append = (n: number): RecordId =>
        records.appendEntry({ kind: 'user', content: { text: `第 ${n} 条` }, at: T0 + n })

      const id1 = append(1)
      const id2 = append(2)
      const id3 = append(3)
      const id4 = append(4)
      const id5 = append(5)

      const idsIn = async (range?: { from?: RecordId; to?: RecordId }): Promise<RecordId[]> => {
        const seen: RecordId[] = []
        for await (const entry of records.readEntries(SESSION, range)) seen.push(entry.id)
        return seen
      }

      expect(await idsIn()).toEqual([id1, id2, id3, id4, id5])
      expect(await idsIn({ from: id3 })).toEqual([id3, id4, id5])
      expect(await idsIn({ to: id4 })).toEqual([id1, id2, id3, id4])
      expect(await idsIn({ from: id3, to: id4 })).toEqual([id3, id4]) // 含端点
      expect(await idsIn({ from: id5, to: id1 })).toEqual([]) // 倒挂即空

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('会话列表——写入过的会话各现一次，最近在前', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const later = store.serviceFor(OTHER_SESSION)
      const earlier = store.serviceFor(SESSION)

      earlier.appendEntry({ kind: 'user', content: { text: '先来的' }, at: T0 + 10 })
      later.appendEntry({ kind: 'user', content: { text: '后来的' }, at: T0 + 20 })

      // **原锚**：列表＝「写入过的会话各现一次，最近在前」（全等断言）。
      // **为何变**：U26 给摘要加了 `workspace`（会话归属工作区）——行多了一键。
      // **新锚**：同一条规格，**全等照旧**（不放宽成「只看 id 与 at」——那正是判据定松）。
      expect(await store.listSessions()).toEqual([
        { id: OTHER_SESSION, at: T0 + 20, workspace: ROOTS },
        { id: SESSION, at: T0 + 10, workspace: ROOTS },
      ])
      expect(await store.serviceFor('s-0003').listSessions()).toEqual(
        await store.listSessions(),
      ) // 列表是域的面，不随实例而变

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('kind 与载荷强对应——错配即拒（形态缺口在写入侧落硬闸）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const at = T0 + 1

      expect(() =>
        records.appendEntry({
          kind: 'tool-call',
          content: { text: 'exec' },
          at,
          // 缺载荷——`tool-call` 的名与参数是重放真源，不能省
        }),
      ).toThrow(/tool-call/)
      // ⚠️ **原锚**：`user` 条目带**任何**载荷都拒（那时非工具条目一律不带载荷）。
      // **为何变**：U33 起 `user` 条目可以带它自己的载荷——随这次交代送出去的技能材料。
      // **新锚**：装的**不是那一份**就拒（工具条目的载荷支照旧不许错位到 `user` 头上）。
      expect(() =>
        records.appendEntry({
          kind: 'user',
          content: { text: '你好' },
          at,
          payload: { name: 'exec', args: {} }, // 工具条目的载荷支，不是技能材料
        }),
      ).toThrow(/user/)

      // U37：图片那一支**收下**（它没有 `text`——内容是字节，落在 blob 里）——
      // 落取回环对得上，且**缺件的（少 blob / 少 mime）照拒**。
      const image: UserPayload = {
        refs: [
          {
            kind: 'image',
            at: 0,
            marker: '@shot.png',
            source: '/ws/shot.png',
            label: 'shot.png',
            name: 'shot.png',
            mime: 'image/png',
            blob: 'blob_1',
          },
        ],
      }
      records.appendEntry({ kind: 'user', content: { text: '看这张' }, at, payload: image })

      const one = image.refs?.[0]
      for (const broken of [
        { ...one, blob: undefined }, // 字节的把手没了——取回不来
        { ...one, mime: undefined }, // 类型没了——送模型时拼不出图像部件
        { ...one, name: undefined },
      ]) {
        expect(() =>
          records.appendEntry({
            kind: 'user',
            content: { text: '看这张' },
            at,
            payload: { refs: [broken] } as unknown as UserPayload,
          }),
        ).toThrow(/user/)
      }

      // 技能材料那一份**收下**，且**落取回环**对得上（正身：名字 / 来源 / 正文三件齐全）
      const material = {
        skills: [
          {
            name: 'pdf',
            source: '/ws/.magic/skills/pdf',
            label: '项目 .magic/skills',
            text: '正文',
          },
        ],
      }
      records.appendEntry({ kind: 'user', content: { text: '照这份技能做' }, at, payload: material })

      const back: Entry[] = []
      for await (const entry of records.readEntries(SESSION)) back.push(entry)
      // **两形各归各位**：图片那一份与技能那一份都原样回来（次序即写入序）
      expect(back.map((entry) => entry.payload)).toEqual([image, material])

      // U64：`assistant` 那一格**开**了——但开的是**一格**，不是「随便什么都能放」。
      //
      // 由头（U41）：DeepSeek 的思考模式在带 tools 时要求把历史轮的 `reasoning_content`
      // 原样回传（不回则 400）——那份思考**确实是重放真源**，故它在表里该有位置。
      // ⚠️ **核准的只有这一形**：`{ reasoning: string }`。这条表仍是「重放真源」，
      // 不是杂物抽屉——多一个键、换个类型、给个空对象，**一条都不放行**。
      const reasoning = { reasoning: '先看清路径再动手' }
      records.appendEntry({ kind: 'assistant', content: { text: '看完了' }, at, payload: reasoning })
      // 不带载荷的 `assistant` 照旧（**既有条目一字不动**：旧写入路径产出的行与新路径逐字同形）
      records.appendEntry({ kind: 'assistant', content: { text: '没有思考的一轮' }, at })

      for (const broken of [
        { foo: 1 }, // 别的东西——载荷不是杂物抽屉
        {}, // 空载荷＝「没有载荷」写错了地方（与 `user` 那条同一姿势）
        { reasoning: 3 }, // 形状不对：那一格是**文字**
        { reasoning: '想过了', extra: 1 }, // 多带一位：只许 `reasoning` 这一个键
      ]) {
        expect(() =>
          records.appendEntry({
            kind: 'assistant',
            content: { text: '看完了' },
            at,
            payload: broken as unknown as AssistantPayload,
          }),
        ).toThrow(/assistant/)
      }

      // **读得回来**：那一份逐字一致；没载荷那条**一个键都不多**（两形分得开）
      const afterAssistant: Entry[] = []
      for await (const entry of records.readEntries(SESSION)) afterAssistant.push(entry)
      const landed = afterAssistant.filter((entry) => entry.kind === 'assistant')
      expect(landed.map((entry) => entry.payload)).toEqual([reasoning, undefined])
      expect(landed.map((entry) => entry.content)).toEqual([{ text: '看完了' }, { text: '没有思考的一轮' }])
      expect(() =>
        records.appendEntry({
          kind: 'tool-result',
          content: { text: '' },
          at,
          payload: { name: 'exec', args: {} }, // 载荷支错位
        }),
      ).toThrow(/tool-result/)

      // 工具结果的可选位 `plan`（U34）——**只增不改的兼容位**：给了照收、形状不对即拒。
      // 形状错的那几条：状态不在词表里 · 步骤不是对象 · notes 不是字符串。
      // ⚠️ 这些值**故意不是** `PlanNote`（要验的正是运行时那道硬闸），故此处只能落一次
      // 断言（类型层本来就拦得住它们——那道闸拦的是「库里的旧行 / 手写的 JSON」，不是本文件）。
      for (const broken of [
        { steps: [{ text: '一步', status: 'doing' }], notes: '' },
        { steps: ['一步'], notes: '' },
        { steps: [], notes: 3 },
      ]) {
        expect(() =>
          records.appendEntry({
            kind: 'tool-result',
            content: { text: '已更新' },
            at,
            payload: { ok: true, output: { text: '已更新' }, plan: broken } as unknown as ToolResultPayload,
          }),
        ).toThrow(/tool-result/)
      }

      // 会话 id 是分束的键——空串不是会话
      expect(() => store.serviceFor('')).toThrow(/session/)
      // 信封的 session 与服务实例不一致＝跨会话串线，拒
      expect(() =>
        records.appendEvent({
          id: records.nextId(),
          session: OTHER_SESSION,
          turn: null,
          at,
          kind: 'agent.start',
          data: {},
        }),
      ).toThrow(/session/)

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  /**
   * U34 · **计划载荷的三态**：缺字段 / 有值 / `null`（清空）——落取回环逐字段相等。
   *
   * 判据的重点在**缺字段与 `null` 分得开**（契约 `ToolResultPayload.plan` 那条注）：
   * 用真假判断把两者混在一起，读侧就分不出「这次清空了」与「这次跟计划无关」。
   */
  test('工具结果携带计划更新——三态落取回环逐字段相等（缺字段 / 有值 / null）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const at = T0 + 2

      const plan: PlanNote = {
        steps: [
          { text: '定位登录失败提示', status: 'completed' },
          { text: '覆盖四个失败分支', status: 'in_progress' },
        ],
        notes: '目标：保持已输入内容',
      }

      records.appendEntry({ kind: 'tool-result', content: { text: '无关的一次结果' }, at, payload: { ok: true, output: { text: '无关的一次结果' } } })
      records.appendEntry({ kind: 'tool-result', content: { text: '已更新计划' }, at: at + 1, payload: { ok: true, output: { text: '已更新计划' }, plan } })
      records.appendEntry({ kind: 'tool-result', content: { text: '已清空计划' }, at: at + 2, payload: { ok: true, output: { text: '已清空计划' }, plan: null } })

      const back: Entry[] = []
      for await (const entry of records.readEntries(SESSION)) back.push(entry)

      expect(back.map((entry) => entry.payload)).toEqual([
        { ok: true, output: { text: '无关的一次结果' } },
        { ok: true, output: { text: '已更新计划' }, plan },
        // `null` 与「没有这一位」在 JSON 列上**不是同一个值**——这条是两者的分界
        { ok: true, output: { text: '已清空计划' }, plan: null },
      ])

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  /**
   * U34 · **倒序、有界读**（`readEntriesBack`）——当前计划与回查历史共用的一条读面。
   *
   * 四条判据：`before` **不含**它自己 · 交回按**记录序**（升序）· `limit` 封顶 ·
   * 到头（没有更早的了）如实少给。跨会话不串线（`before` 取自别条会话也不越界）。
   */
  test('倒序、有界读：before 不含 · 升序交回 · limit 封顶 · 跨会话不串线', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)
      const other = store.serviceFor(OTHER_SESSION)

      const ids: RecordId[] = []
      for (let index = 0; index < 5; index += 1) {
        ids.push(
          records.appendEntry({ kind: 'assistant', content: { text: `第 ${index} 条` }, at: T0 + index }),
        )
      }
      other.appendEntry({ kind: 'assistant', content: { text: '别条会话' }, at: T0 })

      const idsText = (list: readonly Entry[]): string[] =>
        list.map((entry) => ('text' in entry.content ? entry.content.text : ''))

      // 一次封顶：最近两条，按记录序交回
      expect(idsText(await records.readEntriesBack(SESSION, undefined, 2))).toEqual([
        '第 3 条',
        '第 4 条',
      ])
      // `before` 不含它自己——给最后一条的 id，取到的是它之前那两条
      const last = ids[4] ?? 0
      expect(idsText(await records.readEntriesBack(SESSION, last, 2))).toEqual(['第 2 条', '第 3 条'])
      // 到头：还剩一条就给一条（不补齐、不重复）
      const earliest = ids[0] ?? 0
      expect(idsText(await records.readEntriesBack(SESSION, earliest, 2))).toEqual([])
      // 跨会话不串线：拿别条会话的 `before` 也只看本条会话
      expect(idsText(await records.readEntriesBack(SESSION, undefined, 99))).toHaveLength(5)

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('写入失败：不留半行 · 号不回退（失败路径也要干净）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)

      const first = records.appendEntry({
        kind: 'user',
        content: { text: '先成一条' },
        at: T0 + 1,
      })

      // 载荷里带环——JSON 序列化在事务内抛，整笔回滚（会话行与条目行都不留）
      const circular: Record<string, unknown> = { cmd: 'ls' }
      circular['self'] = circular
      expect(() =>
        records.appendEntry({
          kind: 'tool-call',
          content: { text: 'exec' },
          payload: { name: 'exec', args: circular },
          at: T0 + 2,
        }),
      ).toThrow(/cycl/i) // Bun 的措辞：cannot serialize cyclic structures

      const survived: Entry[] = []
      for await (const entry of records.readEntries(SESSION)) survived.push(entry)
      expect(survived.map((entry) => entry.id)).toEqual([first]) // 半行不留

      // 号不回退——重发号会撞主键，也破了「id 排序权威」
      const second = records.appendEntry({
        kind: 'user',
        content: { text: '再来一条' },
        at: T0 + 3,
      })
      expect(second).toBeGreaterThan(first)

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})

describe('判据 5 · 独立验证（直读库表）', () => {
  test('库文件落盘后裸读：行、列与写进去的一一对账', async () => {
    const dir = tempDataDir()
    const blobRef = 'blob-ref-占位' // 本用例只查引用列，不落真 blob

    const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
    const records = store.serviceFor(SESSION)
    const entries = fourEntries(blobRef)
    const entryIds = entries.map((entry) => records.appendEntry(entry))
    records.appendEvent({
      id: records.nextId(),
      session: SESSION,
      turn: null,
      at: T0 + 9,
      kind: 'agent.start',
      data: {},
    })
    records.appendEvent({
      id: records.nextId(),
      session: SESSION,
      turn: 1,
      at: T0 + 10,
      kind: 'turn.end',
      data: { reason: 'settled' },
    })
    store.close() // 先关连接——断言的是**落盘的东西**，不是内存里的

    const db = new Database(databasePathOf(dir), { readonly: true })
    try {
      const rows = db
        .query<RawEntryRow, []>(
          `SELECT id, session, kind, content_kind, content_text, content_blob, payload, at, source
             FROM entries ORDER BY id`,
        )
        .all()

      expect(rows.map((row) => row.id)).toEqual(entryIds)
      expect(rows.map((row) => row.session)).toEqual([SESSION, SESSION, SESSION, SESSION])
      expect(rows.map((row) => row.kind)).toEqual([
        'user',
        'assistant',
        'tool-call',
        'tool-result',
      ])
      expect(rows.map((row) => row.content_kind)).toEqual(['text', 'text', 'text', 'text'])
      expect(rows.map((row) => row.content_text)).toEqual([
        '把 playground 里的脚本跑一遍\n第二行也要原样回来',
        '好——先看一眼那个文件，再决定怎么跑。',
        'exec: ls -la playground',
        'exit=1（目录不存在）',
      ])
      expect(rows.map((row) => row.content_blob)).toEqual([null, null, null, null])
      expect(rows.map((row) => row.at)).toEqual([T0 + 1, T0 + 2, T0 + 3, T0 + 4])
      expect(rows.map((row) => row.source)).toEqual([null, null, OTHER_SESSION, null])

      // 载荷＝JSON 一列（工具条目有，其余无）——重放真源落在库里
      expect(rows[0]?.payload).toBeNull()
      expect(rows[1]?.payload).toBeNull()
      expect(JSON.parse(rows[2]?.payload ?? 'null')).toEqual(entries[2]?.payload)
      expect(JSON.parse(rows[3]?.payload ?? 'null')).toEqual({
        ok: false,
        output: { blob: blobRef },
      })

      const eventRows = db
        .query<RawEventRow, []>('SELECT id, session, turn, at, kind, data FROM events ORDER BY id')
        .all()

      expect(eventRows.map((row) => row.kind)).toEqual(['agent.start', 'turn.end'])
      expect(eventRows.map((row) => row.turn)).toEqual([null, 1])
      expect(eventRows.map((row) => row.session)).toEqual([SESSION, SESSION])
      expect(eventRows.map((row) => row.at)).toEqual([T0 + 9, T0 + 10])
      expect(eventRows.map((row) => JSON.parse(row.data))).toEqual([{}, { reason: 'settled' }])
    } finally {
      db.close()
      removeDataDir(dir)
    }
  })
})
