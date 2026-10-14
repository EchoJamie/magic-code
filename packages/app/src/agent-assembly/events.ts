import type {
  EventDataOf,
  EventKind,
  EventStamper,
  KernelEvent,
  SessionId,
  Timestamp,
  TurnId,
} from '@magic/contracts'

export function createStamper(input: {
  readonly records: { nextId(): number }
  readonly session: SessionId
  readonly now: () => Timestamp
}): EventStamper {
  let turn: TurnId | null = null

  return {
    stamp: <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent =>
      ({
        id: input.records.nextId(),
        session: input.session,
        turn,
        at: input.now(),
        kind,
        data,
      }) as KernelEvent,

    beginTurn: (value: TurnId | undefined): void => {
      turn = value ?? null
    },
  }
}

/** 后台事实只带命令、真实结果和输出路径；内部旁注不冒充用户输入。 */
