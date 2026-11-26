import type { UserInput } from './control.ts'
import type { NewEntry } from './entries.ts'
import type { RecordId, TurnId } from '../shared/ids.ts'
import { INPUT_PREVIEW_TEXT_BYTES } from '../shared/control-budget.ts'
export type InputPurpose = 'current' | 'next'

/**
 * 输入七态（边界方案 §五）——每迁移唯一写者：
 * - `pending`（受理，engine）→ `executing`（engine 的 `dequeue`，准入通过后出队）
 *   → `consumed`（executor 的 `consume`，与落条目同一事务，同时写 `turn`）→ `included`（engine）；
 * - `rejected`（engine：受理即拒不经 pending，或已受理后 closing/archived 的 `rejectPending`）；
 * - `failed`（engine：执行前/执行中断；`failedFrom` 记失败前状态）；
 * - `withdrawn`（engine：**只从 pending** 撤回，无 executing→withdrawn 迁移）。
 */
export type InputState = 'pending' | 'rejected' | 'executing' | 'consumed' | 'included' | 'failed' | 'withdrawn'

export type StoredInput = {
  readonly ref: string
  readonly input: UserInput
  readonly purpose: InputPurpose
  readonly at: number
  readonly revision: number
  readonly state: InputState
  readonly entry?: RecordId
  /** 这份输入被哪次交代消费（`turns.id`）。**消费前缺席**——只在 `consume` 事务里写（不得预写）。 */
  readonly turn?: TurnId
  readonly reason?: string
  /** 失败前状态（`failed` 行才有）：`retry` 按 `failedFrom` 区分文案。 */
  readonly failedFrom?: 'pending' | 'executing'
  /** 拒收类别（`rejected` 行才有）——UI 据它选动作（capacity→一键重发；free text 选不对动作与不给同罪）。 */
  readonly rejectedKind?: 'capacity' | 'closing' | 'archived'
}
/**
 * 待处理输入在控制面里的**线上视图**——正文只留预览，附总字节数与截断标记。
 *
 * 2026-11-21 接续事故的另一条产生路径：`input.pending` 把 `inputs.list()` 的
 * 全部正文原样下发，一条 8MB 的待处理输入就能把连接压断。这里把「视图怎么成形」
 * 收成一处纯函数，内核与管理者共用；旧客户端忽略多出来的两个可选字段。
 */
export type PendingInputView = StoredInput & {
  /** 原文总字节数（只在截断时给）——UI 据此说「还有多少」。 */
  readonly textBytes?: number
  /** 正文被截断（只在截断时给）。 */
  readonly truncated?: true
}

/** 每类输入最多带多少条（pending / 最近 consumed 各一份）。 */
export const PENDING_VIEW_LIMIT = 20

const pendingEncoder = new TextEncoder()

/** 按 UTF-8 字节裁文本——逐码点收，不切坏多字节字符。 */
function clipInputText(text: string, maxBytes: number): { readonly text: string; readonly bytes: number } {
  const bytes = pendingEncoder.encode(text).byteLength
  if (bytes <= maxBytes) return { text, bytes }
  let used = 0
  let out = ''
  for (const char of text) {
    const size = pendingEncoder.encode(char).byteLength
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return { text: out, bytes }
}

/**
 * 把一份 `inputs.list()` 收成线上视图：pending 全部（最近 `limit` 条）＋
 * 最近 `limit` 条已消费的；每条正文超过 `INPUT_PREVIEW_TEXT_BYTES` 就截断。
 */
export function pendingViews(
  inputs: readonly StoredInput[],
  limit: number = PENDING_VIEW_LIMIT,
): readonly PendingInputView[] {
  const pending = inputs.filter(one => one.state === 'pending').slice(-limit)
  const consumed = inputs.filter(one => one.state === 'consumed').slice(-limit)
  return [...pending, ...consumed].map(one => {
    const clipped = clipInputText(one.input.text, INPUT_PREVIEW_TEXT_BYTES)
    if (clipped.text === one.input.text) return one
    return { ...one, input: { ...one.input, text: clipped.text }, textBytes: clipped.bytes, truncated: true }
  })
}

/**
 * 记录域保存提交事实；运行只持本次明确启动的身份，不自动消费遗留输入。
 *
 * 状态机纪律（边界方案 §五）：每个迁移一个写者；`turn` 只在 `consume` 事务里写
 * （消费前写 `turn` 的路径都是违规）；`withdrawn` 只从 `pending`。
 */
export interface InputRecords {
  /** 受理落 `pending`（事务性发件箱：受理即落账，帧只是加速信号）。 */
  accept(input: UserInput & { ref: string }, at: number): StoredInput
  /** 受理即拒（容量/closing/archived）：**不经 pending** 直接落 `rejected` 行，原稿留在账上，`rejectedKind` 记类别。 */
  reject(input: UserInput & { ref: string }, reason: string, at: number, kind: 'capacity' | 'closing' | 'archived'): StoredInput
  get(ref: string): StoredInput | undefined
  list(): readonly StoredInput[]
  edit(ref: string, revision: number, input: UserInput): boolean
  /** pending → withdrawn（**只从 pending**；N18：无 executing→withdrawn 迁移）。 */
  withdraw(ref: string, revision: number): boolean
  /** pending → rejected（已受理后拒：closing/archived），带 `(session,ref)` 回执由调用方发。 */
  rejectPending(ref: string, reason: string, kind: 'closing' | 'archived'): boolean
  /** pending → executing（engine；准入 `beginExecution` 在 dequeue 之前）。 */
  dequeue(ref: string, revision: number): boolean
  /** executing → consumed（executor；与落条目同一事务，写 `turn`）。 */
  consume(ref: string, revision: number, entry: NewEntry): RecordId | undefined
  hold(ref: string, reason: string | undefined): void
  /** pending/executing → failed；`failedFrom` 记失败前状态（G3/M4）。 */
  fail(ref: string, reason: string): void
  /** failed/rejected → pending（用户重试/重发）；清 `failedFrom` 与 `reason`。 */
  retry(ref: string, revision: number): boolean
  included(entries: readonly RecordId[]): readonly StoredInput[]
}
export type InputManage = { readonly member?: import('../shared/ids.ts').AgentId } & (
  | { readonly type: 'input.manage'; readonly action: 'list' }
  | { readonly type: 'input.manage'; readonly action: 'edit'; readonly ref: string; readonly revision: number; readonly input: UserInput }
  | { readonly type: 'input.manage'; readonly action: 'withdraw'; readonly ref: string; readonly revision: number }
  /**
   * **立即消费**（pending 下触发 consume/drain，非 retry——N14：准入失败的动作是再送一次，
   * 不是把失败当重试）。`retry` 只从 failed/rejected 起。
   */
  | { readonly type: 'input.manage'; readonly action: 'retry' | 'consume'; readonly ref: string; readonly revision: number }
  /** 旧名，语义并入 `consume`（pending 下立即消费）；不再承担 failed 起的重试（那是 `retry`）。 */
  | { readonly type: 'input.manage'; readonly action: 'continue'; readonly ref: string; readonly revision: number })
