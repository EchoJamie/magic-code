/** 控制面待确认请求的生命周期（P1 回归）：ready 前排队并补发、退出/收代就地落定、排队期撤销即时收口。 */
import { expect, test } from 'bun:test'
import type { ManagerToExecutor } from '@magic/host'
import { newRunRecord, refresh } from '@magic/host'
import type { AgentModelConfig } from '@magic/contracts'
import { createExecutorControl, type Executor } from '../src/executor-control.ts'

function fakeExecutor(ready: boolean): { readonly executor: Executor; readonly sent: ManagerToExecutor[] } {
  const sent: ManagerToExecutor[] = []
  const run = newRunRecord({ gen: 1, session: 's', startedAt: 1, explicit: false })
  refresh(run, 1)
  if (ready) run.ready = true
  const executor: Executor = {
    ledger: { list: () => [] } as never,
    network: {} as never,
    gen: 1, executionId: 'g1', run,
    spawned: { onExit: () => () => {}, cancel: () => {}, kill: () => {} } as never,
    exited: false,
    link: { send: message => { sent.push(message as ManagerToExecutor); return true }, onMessage() {}, onClose() {}, close() {}, get closed() { return false } },
    diagnostic: () => {},
  }
  return { executor, sent }
}

const model: AgentModelConfig = { provider: 'p', model: 'm', choice: 'spell' } as AgentModelConfig

test('未就绪的换模排队，ready 时刻补发（P1 回归——此前既不排队也无超时）', async () => {
  const { executor, sent } = fakeExecutor(false)
  const control = createExecutorControl(() => {})
  const configuring = control.configure(executor, model)
  expect(sent).toHaveLength(0)
  executor.run.ready = true // 真实流程：lifecycle 的 ready 分支先置位，再走补发口
  control.ready(executor)
  expect(sent).toHaveLength(1)
  const frame = sent[0] as unknown as { readonly t: string; readonly requestId: string }
  if (frame.t !== 'collaboration.configure') throw new Error(`补发的不是换模帧：${frame.t}`)
  control.configured(executor, { t: 'collaboration.configured', requestId: frame.requestId, result: { ok: true } } as never)
  await expect(configuring).resolves.toBeUndefined()
})

test('未就绪排队的压缩在执行者退出时就地拒绝（P1 回归——不再悬挂）', async () => {
  const { executor, sent } = fakeExecutor(false)
  const control = createExecutorControl(() => {})
  const state = control.compact(executor, { requestId: 'c1' }, new AbortController().signal, () => {})
  expect(sent).toHaveLength(0)
  control.exited(executor)
  await expect(state).rejects.toThrow('执行实例已结束')
})

test('排队期撤销：压缩立即落定为 cancelled，不等 ready 也不等退出', async () => {
  const { executor, sent } = fakeExecutor(false)
  const control = createExecutorControl(() => {})
  const controller = new AbortController()
  const state = control.compact(executor, { requestId: 'c1' }, controller.signal, () => {})
  controller.abort()
  await expect(state).resolves.toMatchObject({ requestId: 'c1', state: 'cancelled' })
  // 撤销后 ready 不再补发
  control.ready(executor)
  expect(sent).toHaveLength(0)
})

test('收代同样落定排队中的压缩与换模队列条目', async () => {
  const { executor } = fakeExecutor(false)
  const control = createExecutorControl(() => {})
  const state = control.compact(executor, { requestId: 'c2' }, new AbortController().signal, () => {})
  const configuring = control.configure(executor, model)
  control.retire(executor, '子进程退出（0）')
  await expect(state).rejects.toThrow('本次压缩中断')
  await expect(configuring).rejects.toThrow('成员配置结果未确认')
})
