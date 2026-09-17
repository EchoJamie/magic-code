/**
 * 铸造器桩 —— **共享测试替身之一**（技术方案 · 领域划分 · 信封的归属 v0 锚定）。
 *
 * 为什么共享（M02 回报·待决线索）：`EventStamper.stamp` 是**构造面泛型**——
 * `stamp<K>(kind: K, data: EventDataOf[K])`。泛型 `K` 与 `data` 的对应关系 TS
 * **无法在函数体内自证**（编译器的泛型实现约束），故任何桩都得在函数体里断言一次。
 * 先前这份断言**每域各写一遍**（M01-3 契约探针一处 · M02 一处 · 各域还会各一处）；
 * 收敛到本包后，全仓**只此一处**——域测试直接取用。
 *
 * 语义照桩的用途取真：
 * - `id` **本地单调**（从 `from ?? 1` 起）——真实现取自记录域 `RecordsService.nextId()`，
 *   桩则在本地数，域测试不必为此拉一个记录域桩；
 * - `session` / `turn` / `at` **可注入**；`at` 亦可给函数（需要「时间在走」的用例）；
 * - `beginTurn` **真管用**（改后续 `stamp` 的 `turn`；`undefined` ＝ 轮止 → 信封的 `null`），
 *   并把轨迹留在 `turns` 里——「谁在何时调了 beginTurn」可查（M02 用它钉住「模型域不调」）。
 *
 * 不做的：不发事件 / 不落库（那不是铸造器的活）；`stamped` 只是**铸造留痕**。
 */

import type {
  EventDataOf,
  EventKind,
  EventStamper,
  KernelEvent,
  RecordId,
  SessionId,
  Timestamp,
  TurnId,
} from '@magic/contracts'

/** 缺省时钟——**固定的**：测试要可复现，「当下」由注入说了算（与 M02 的桩同值）。 */
export const FIXED_AT: Timestamp = 1_700_000_000_000

/** 缺省会话 id——域测试里「哪个会话」通常无关紧要，写死一个可读的。 */
export const DEFAULT_TEST_SESSION: SessionId = 'test-session'

export type TestStamperOptions = {
  /** 会话 id——缺省 `'test-session'`。 */
  readonly session?: SessionId
  /** 起始轮——缺省 `null`（轮外）。 */
  readonly turn?: TurnId | null
  /** 时间戳：常量，或**按铸造次数取时的函数**——缺省 `FIXED_AT`。 */
  readonly at?: Timestamp | (() => Timestamp)
  /** `id` 起始值——缺省 `1`。 */
  readonly from?: RecordId
}

/**
 * 铸造器桩的观察面——断言用（`stamp` / `beginTurn` 的痕迹）。
 * 三个都是**活视图**（getter）：拿在手里也看得到后续铸造。
 */
export type TestStamper = EventStamper & {
  /** 已铸事件（按铸造序，含信封）。 */
  readonly stamped: readonly KernelEvent[]
  /** `beginTurn` 的调用轨迹——含 `undefined`（轮止）。 */
  readonly turns: readonly (TurnId | undefined)[]
  /** 下一个将用的 `id`（＝已铸条数 ＋ 起始值）。 */
  readonly nextId: RecordId
}

/**
 * 造一个铸造器桩——**装配的角色由测试自己扮**（真实现由装配按会话实例构造并注入）。
 */
export function makeTestStamper(options: TestStamperOptions = {}): TestStamper {
  const session = options.session ?? DEFAULT_TEST_SESSION
  const clock = options.at ?? FIXED_AT

  let turn: TurnId | null = options.turn ?? null
  let next: RecordId = options.from ?? 1

  const stamped: KernelEvent[] = []
  const turns: (TurnId | undefined)[] = []

  const now = (): Timestamp => (typeof clock === 'function' ? clock() : clock)

  return {
    get stamped(): readonly KernelEvent[] {
      return stamped
    },
    get turns(): readonly (TurnId | undefined)[] {
      return turns
    },
    get nextId(): RecordId {
      return next
    },

    // 泛型 `K` 与 `data: EventDataOf[K]` 的对应关系 TS 无法在函数体内自证（构造面的固有限制）；
    // 桩里由这一次断言收口——**全仓只此一处**，各域测试不必再写（见文件头注）。
    stamp: <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent => {
      const event: KernelEvent = {
        id: next,
        session,
        turn,
        at: now(),
        kind,
        data,
      } as KernelEvent
      next += 1
      stamped.push(event)
      return event
    },

    beginTurn: (value: TurnId | undefined): void => {
      turns.push(value)
      turn = value ?? null
    },
  }
}
