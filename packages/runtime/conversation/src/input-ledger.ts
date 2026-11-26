/** 输入受理 —— 从 service.ts 按职责拆出（行为不变）。
 *
 * 这一份职责：**账本交互与受理判定**——`accept` 落账与回执（`input.settled` / `input.pending`）、
 * `manage` 的四支账本操作（edit / withdraw / retry / 立即消费）与各自的 note 文案。
 * 队列本体（drain / holdQueued / 唤起与排空）仍归 `service.ts`——本模块经 `QueueBundle`
 * 拿到队列状态束，判定与落账在此，排空触发经回调交回。
 */
import { pendingViews } from '@magic/contracts'
import type { EventSink, EventStamper, InputManage, StoredInput, UserInput } from '@magic/contracts'
import type { ConversationDeps } from './service.ts'
import { messageOf } from './input-intake.ts'

/** 队列的一件——整份输入（U33）＋ 共享标志 ＋ 兑现回调。 */
export type QueueItem = { input: UserInput | undefined; shared: boolean; done?: () => void }
/** 协作补充的一件——在模型/工具边界消费（不在轮中途插条目）。 */
export type SupplementItem = { input: UserInput; shared: boolean; done: () => void }

/** 输入受理的依赖束——队列状态与账本读写的把手。 */
export type QueueBundle = {
  readonly deps: ConversationDeps
  readonly sink: EventSink
  readonly stamper: EventStamper
  /** 队列状态束（布尔位按对象属性共享——见 service.ts 的注）。 */
  readonly state: { readonly closed: boolean; readonly running: boolean }
  readonly pending: QueueItem[]
  readonly supplements: SupplementItem[]
  /** 压缩的用量计数（受理非 notice 输入时抬一格）。 */
  readonly onVersionBump: () => void
  /** 空闲即排空（压缩挂起时不启动——判定归 service）。 */
  readonly startDrainIfIdle: () => void
}

/**
 * 受理一条输入——**账本落账 ＋ 回执 ＋ 入队**（原 `enqueue` 的受理段）。
 *
 * - `accept` 对已有 ref 幂等（engine 受理前移后执行者重过账本同一行无害）；
 * - 已消费/已失败的历史输入不重复驱动；**仍在 pending 的被再次提交＝用户明确要它跑**
 *   （宿主重启后恢复的会话里，重新提交同一条就是「继续」——2026-11-24 裁定），照常入队；
 * - 忙时受理的当前输入进 supplements（在模型/工具边界消费，不插在途条目中间）。
 */
export function acceptInput(bundle: QueueBundle, input: UserInput, shared: boolean, done: () => void = () => {}): void {
  const { deps, sink, stamper, state } = bundle
  if (state.closed) { done(); return }
  const durable = { ...input, ref: input.ref ?? crypto.randomUUID() }
  try {
    const existing = deps.records.inputs.get(durable.ref)
    const row = deps.records.inputs.accept(durable, (deps.now ?? Date.now)())
    sink.emit(stamper.stamp('input.settled', row.state === 'failed' || row.state === 'withdrawn'
      ? { ref: durable.ref, ok: false, reason: row.reason ?? '这条输入已撤回' }
      : { ref: durable.ref, ok: true, stage: row.state === 'included' ? 'included' : 'accepted', ...(row.input.refs === undefined ? {} : { refs: row.input.refs }) }))
    sink.emit(stamper.stamp('input.pending', { inputs: pendingViews(deps.records.inputs.list()) }))
    if (existing !== undefined && existing.state !== 'pending' && existing.state !== 'executing') { done(); return }
    // ⚠️ **executing 也放行**（T2.1 dequeue 流）：那是本执行者刚出队的行——准入与 dequeue
    // 在信号点完成（见 assembly 的 `consumeLedgerInputs`），消费动作（inputs.consume 与
    // 落条目原子）在落账时发生。单活执行者前提下，executing 行只属于这一代。
    if (row.input.notice !== true) bundle.onVersionBump()
    deps.onInput?.(row.input)
    if (state.running && row.purpose === 'current') bundle.supplements.push({ input: row.input, shared, done })
    else bundle.pending.push({ input: row.input, shared, done })
    bundle.startDrainIfIdle()
  } catch (error) {
    sink.emit(stamper.stamp('input.settled', { ref: durable.ref, ok: false, reason: `受理失败：${messageOf(error)}` }))
    done()
  }
}

/**
 * 输入管理命令——四支各归各的账本迁移与文案（原 `manage` 的判定与执行）。
 *
 * - **edit / withdraw**：只对 pending（账本按 revision 校验）；
 * - **retry**（N14 · 契约）：只从 failed/rejected 起，**按 `failedFrom` 分文案**（G3/M4）——
 *   执行前失败的重提是「重试」；执行中重提＝「重新执行（可能重复副作用）」——那一轮
 *   跑过什么无从判定，重提是把同一次调用再发一遍；
 * - **consume**（旧名 `continue` 并入）：只对 pending——清除 hold、立即入队消费。
 *   准入失败（N14）的出路是**再消费一次**，不是把失败当重试。
 */
export function manageInput(bundle: QueueBundle, command: InputManage): void {
  const { deps, sink, stamper, state } = bundle
  if (state.closed) return
  const inputs = deps.records.inputs
  let note: string | undefined
  if (command.action === 'edit') note = inputs.edit(command.ref, command.revision, command.input) ? '已保存未消费输入' : '输入已消费或已改变，未修改'
  if (command.action === 'withdraw') note = inputs.withdraw(command.ref, command.revision) ? '已撤回未消费输入' : '输入已消费或已改变，未撤回'
  if (command.action === 'retry') {
    const row = inputs.get(command.ref)
    if (row !== undefined && row.revision === command.revision && inputs.retry(command.ref, command.revision)) {
      const fresh = inputs.get(command.ref)!
      bundle.pending.push({ input: fresh.input, shared: false })
      bundle.startDrainIfIdle()
      note = retryNoteOf(fresh)
    } else note = '输入不在可重试状态（只从失败/被拒起）或已改变，未重试'
  }
  if (command.action === 'consume' || command.action === 'continue') {
    const row = inputs.get(command.ref)
    if (row?.state === 'pending' && row.revision === command.revision) {
      inputs.hold(row.ref, undefined)
      bundle.pending.push({ input: row.input, shared: false })
      bundle.startDrainIfIdle()
    } else note = command.action === 'continue' ? '输入已消费或已改变，未继续' : '输入不在待消费状态（立即消费只对未开始的输入），未消费'
  }
  sink.emit(stamper.stamp('input.pending', { inputs: pendingViews(inputs.list()), ...(note === undefined ? {} : { note }) }))
}

/** retry 的 note 按 `failedFrom` 分（G3/M4）——执行中重提要明说副作用可能重复。 */
function retryNoteOf(row: StoredInput): string {
  return row.failedFrom === 'executing'
    ? '已重新入队——重新执行（可能重复副作用；先前那一轮跑到哪一步无从判定，先核对再继续）'
    : '已重新入队——重试'
}
