import type { UserInput } from './control.ts'
import type { NewEntry } from './entries.ts'
import type { RecordId, TurnId } from '../shared/ids.ts'
import { INPUT_PREVIEW_TEXT_BYTES } from '../shared/control-budget.ts'
export type InputPurpose = 'current' | 'next'
export type StoredInput = {
  readonly ref: string
  readonly input: UserInput
  readonly purpose: InputPurpose
  readonly at: number
  readonly revision: number
  readonly state: 'pending' | 'consumed' | 'included' | 'withdrawn' | 'failed'
  readonly entry?: RecordId
  /** 这份输入被哪次交代消费（`turns.id`）。未消费时缺席。 */
  readonly turn?: TurnId
  readonly reason?: string
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

/** 记录域保存提交事实；运行只持本次明确启动的身份，不自动消费遗留输入。 */
export interface InputRecords {
  accept(input: UserInput & { ref: string }, at: number): StoredInput
  get(ref: string): StoredInput | undefined
  list(): readonly StoredInput[]
  edit(ref: string, revision: number, input: UserInput): boolean
  withdraw(ref: string, revision: number): boolean
  consume(ref: string, revision: number, entry: NewEntry): RecordId | undefined
  hold(ref: string, reason: string | undefined): void
  fail(ref: string, reason: string): void
  included(entries: readonly RecordId[]): readonly StoredInput[]
}
export type InputManage = { readonly member?: import('../shared/ids.ts').AgentId } & (
  | { readonly type: 'input.manage'; readonly action: 'list' }
  | { readonly type: 'input.manage'; readonly action: 'edit'; readonly ref: string; readonly revision: number; readonly input: UserInput }
  | { readonly type: 'input.manage'; readonly action: 'withdraw' | 'continue'; readonly ref: string; readonly revision: number })
