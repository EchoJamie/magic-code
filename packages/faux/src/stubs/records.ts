/**
 * 记录域桩 —— `RecordsService` 的内存实现（**测试替身**，不是记录域）。
 *
 * 用处：**别家**的测试要一个能记账的记录域（对话域循环测试落条目 / 事件、控制域测试
 * 看事件流）。记录域自己的测试该测真实现（U02）——桩不替它背书。
 *
 * 语义照契约与真实现的口径取：
 * - **条目 / 事件共用 id 空间**（`RecordId` 空间归记录域，`nextId()` 是唯一取号口）；
 * - `readEvents` **按会话分束**（信封自带 `session`）；
 * - `blobs` 写权唯一归记录域——桩里就是两件事：给引用、原样取回。
 *
 * ⚠️ 一处**契约形态**的如实反映：`Entry` 不带 `session` 字段，而 `readEntries(sessionId, …)`
 * 按会话取——桩按**单会话**处理（忽略 `sessionId`）。真实现怎么分束是记录域的活（U02）。
 */

import type {
  BlobRef,
  BlobStore,
  Entry,
  EntryRange,
  KernelEvent,
  NewEntry,
  RecordId,
  RecordsService,
  RecoveryScan,
  SessionId,
  SessionSummary,
} from '@magic/contracts'

export type FauxRecordsOptions = {
  /** 预置的会话摘要（`listSessions` 的返回）——缺省空。 */
  readonly sessions?: readonly SessionSummary[]
  /** 预置 blob——键即 `BlobRef`。 */
  readonly blobs?: Readonly<Record<string, Uint8Array | string>>
  /** `nextId` 起始值——缺省 1。 */
  readonly from?: RecordId
  /**
   * **在途扫描的答案**（`scanInFlight`，恢复 ①）——缺省「干净会话」（无在途、无中断的轮）。
   *
   * 桩**不自己算**这个答案：判据（有 `tool.call` 无 `tool.result`）归记录域
   * （`@magic/records` 的 `scanForRecovery`）。要验处置的用例把答案**给定**——
   * 与「桩只满足签名、不发明行为」的底线一致（同 `sessions` 那一项）。
   */
  readonly scan?: RecoveryScan | ((session: SessionId) => RecoveryScan)
}

/** 记录域桩的观察面——测试靠它断言「记了什么」。 */
export type FauxRecords = RecordsService & {
  readonly entries: readonly Entry[]
  readonly events: readonly KernelEvent[]
  /** 已存 blob 的引用（按存入序）。 */
  readonly blobRefs: readonly BlobRef[]
}

/** 造一个记录域桩。 */
export function makeFauxRecords(options: FauxRecordsOptions = {}): FauxRecords {
  let next: RecordId = options.from ?? 1
  let blobSeq = 0

  const entries: Entry[] = []
  const events: KernelEvent[] = []
  const blobRefs: BlobRef[] = []
  const blobs = new Map<BlobRef, Uint8Array>()

  const asBytes = (data: Uint8Array | string): Uint8Array =>
    typeof data === 'string' ? new TextEncoder().encode(data) : data

  for (const [ref, data] of Object.entries(options.blobs ?? {})) {
    blobs.set(ref, asBytes(data))
    blobRefs.push(ref)
  }

  const blobStore: BlobStore = {
    async put(data: Uint8Array | string): Promise<BlobRef> {
      blobSeq += 1
      const ref: BlobRef = `blob_${blobSeq}`
      blobs.set(ref, asBytes(data))
      blobRefs.push(ref)
      return ref
    },
    async get(ref: BlobRef): Promise<Uint8Array> {
      const found = blobs.get(ref)
      // 取不到即抛——不静默给空（真实现读不到文件同样是失败）
      if (found === undefined) throw new Error(`Faux 记录桩：没有这个 blob「${ref}」`)
      return found
    },
  }

  return {
    get entries(): readonly Entry[] {
      return entries
    },
    get events(): readonly KernelEvent[] {
      return events
    },
    get blobRefs(): readonly BlobRef[] {
      return blobRefs
    },

    nextId: (): RecordId => {
      const id = next
      next += 1
      return id
    },

    appendEntry(entry: NewEntry): RecordId {
      const id = next
      next += 1
      entries.push({ ...entry, id })
      return id
    },

    appendEvent(event: KernelEvent): void {
      events.push(event)
    },

    // 条目不带 `session`（契约形态），桩按单会话处理——见文件头注
    readEntries: (_sessionId: SessionId, range?: EntryRange): AsyncIterable<Entry> =>
      (async function* (): AsyncIterable<Entry> {
        for (const entry of entries) {
          if (range?.from !== undefined && entry.id < range.from) continue
          if (range?.to !== undefined && entry.id > range.to) continue
          yield entry
        }
      })(),

    // 倒序、有界读（U34）——语义照真实现（`before` 不含 · 按记录序交回 · 一次封顶）：
    // 桩在「哪些条目算数」上不发一言（那是调用方的判据），只答「之前最近的 N 条是哪几条」
    readEntriesBack: (
      _sessionId: SessionId,
      before: RecordId | undefined,
      limit: number,
    ): Promise<readonly Entry[]> => {
      const ceiling = before ?? Number.MAX_SAFE_INTEGER
      const picked = entries.filter((entry) => entry.id < ceiling).slice(-Math.max(limit, 0))
      return Promise.resolve(limit <= 0 ? [] : picked)
    },

    readEvents: (sessionId: SessionId): AsyncIterable<KernelEvent> =>
      (async function* (): AsyncIterable<KernelEvent> {
        for (const event of events) {
          if (event.session === sessionId) yield event
        }
      })(),

    // 在途识别（恢复 ①）——答案由用例给定（见 `FauxRecordsOptions.scan`）
    scanInFlight: async (sessionId: SessionId): Promise<RecoveryScan> => {
      const scripted = options.scan
      if (scripted === undefined) {
        return { session: sessionId, openTurn: null, lastTurn: null, calls: [] }
      }

      return typeof scripted === 'function' ? scripted(sessionId) : scripted
    },

    listSessions: async (): Promise<readonly SessionSummary[]> => options.sessions ?? [],

    blobs: blobStore,
  }
}
