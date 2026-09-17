/**
 * 测试底架 —— 铸造器桩 · 假扇出 · 事件拾取。
 *
 * **两个桩都是契约面的最小实现**：`EventStamper` 只补信封四件（`id` 单调 ·
 * `at` 由桩盖——域不取时钟），`EventSink` 只收不发。域内一切结论都从**拾到的事件**
 * 与 `decide` 的返回值读——测试不碰域内部件。
 */

import type {
  EventDataOf,
  EventKind,
  EventSink,
  EventStamper,
  KernelEvent,
  PermissionContext,
  RecordId,
  ToolCall,
  TurnId,
} from '@magic/contracts'

/** 按 `kind` 收窄的拾取结果——`eventsOf('tool.decision')` 的 `data` 自动定型。 */
export type EventOf<K extends EventKind> = Extract<KernelEvent, { kind: K }>

export type Harness = {
  readonly sink: EventSink
  readonly stamper: EventStamper
  /** 扇出过的事件（按序）。 */
  readonly events: readonly KernelEvent[]
  eventsOf<K extends EventKind>(kind: K): readonly EventOf<K>[]
  /** 事件计数（按 kind）。 */
  countOf(kind: EventKind): number
}

/**
 * 造一套桩——`session` / `turn` 固定值；`at` 固定常数（信封是流水，逐条比会把用例
 * 钉死在一种铸造节奏上）。
 */
export function harness(session = 's-1', turn: TurnId | null = null): Harness {
  const events: KernelEvent[] = []
  let next: RecordId = 0

  const sink: EventSink = {
    emit(event) {
      events.push(event)
    },
  }

  const stamper: EventStamper = {
    // 泛型 `K` 与 `data: EventDataOf[K]` 的对应关系 TS 在函数体内无法自证（构造面的固有限制；
    // M01-3 / M02 测试桩同此）——由契约保证，桩用一次断言收口。
    stamp: <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent =>
      ({
        id: (next += 1),
        session,
        turn,
        at: 1_700_000_000_000,
        kind,
        data,
      }) as KernelEvent,
    beginTurn: () => {},
  }

  return {
    sink,
    stamper,
    events,
    eventsOf: <K extends EventKind>(kind: K): readonly EventOf<K>[] =>
      events.filter((event): event is EventOf<K> => event.kind === kind),
    countOf: (kind) => events.filter((event) => event.kind === kind).length,
  }
}

/** 权限上下文——阶段 1 单根（启动目录＝默认根）。 */
export function context(roots: readonly string[] = ['/work/proj']): PermissionContext {
  return { roots, defaultRoot: roots[0] ?? '/work/proj' }
}

/** 造一次工具调用——`id` 是**供应商侧**调用 id（只用于回填配对，见契约 `ids.ts` 头注）。 */
export function call(name: string, args: Readonly<Record<string, unknown>> = {}): ToolCall {
  return { id: `call-${name}`, name, args }
}
