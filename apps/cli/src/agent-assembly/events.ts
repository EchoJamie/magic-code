import type {
  EventDataOf,
  EventKind,
  EventStamper,
  KernelEvent,
  SessionId,
  StepId,
  Timestamp,
  TurnId,
} from '@magic/contracts'

export function createStamper(input: {
  readonly records: { nextId(): number }
  readonly session: SessionId
  readonly now: () => Timestamp
}): EventStamper {
  let turn: TurnId | null = null
  let step: StepId | null = null
  let generation = 0

  return {
    stamp: <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent =>
      ({
        id: input.records.nextId(),
        session: input.session,
        turn,
        step,
        ...(generation === 0 ? {} : { generation }),
        at: input.now(),
        kind,
        data,
      }) as KernelEvent,

    beginTurn: (value: TurnId | undefined): void => {
      turn = value ?? null
      step = null
    },
    beginStep: (value: StepId | undefined): void => {
      step = value ?? null
    },
    setGeneration: (value: number): void => {
      generation = value
    },
  }
}

/** 后台事实只带命令、真实结果和输出路径；内部旁注不冒充用户输入。 */
