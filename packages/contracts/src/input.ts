import type { UserInput } from './control.ts'
import type { NewEntry } from './entries.ts'
import type { RecordId } from './ids.ts'
export type InputPurpose = 'current' | 'next'
export type StoredInput = {
  readonly ref: string
  readonly input: UserInput
  readonly purpose: InputPurpose
  readonly at: number
  readonly revision: number
  readonly state: 'pending' | 'consumed' | 'included' | 'withdrawn' | 'failed'
  readonly entry?: RecordId
  readonly reason?: string
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
export type InputManage = { readonly member?: import('./ids.ts').AgentId } & (
  | { readonly type: 'input.manage'; readonly action: 'list' }
  | { readonly type: 'input.manage'; readonly action: 'edit'; readonly ref: string; readonly revision: number; readonly input: UserInput }
  | { readonly type: 'input.manage'; readonly action: 'withdraw' | 'continue'; readonly ref: string; readonly revision: number })
