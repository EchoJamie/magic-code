import { expect, test } from 'bun:test'
import { collaborationRuntime } from './run-collaboration-fixture.ts'

/**
 * 窗口自己的模型选择（用户 2026-11-19 定：连接是核心、会话懒建立）。
 *
 * 还没有会话时 `/model` 的选择不发给引擎、只留在窗口；发送交代时随 `input.submit` 带过来。
 * 这一条走的是真 manager/socket/执行者：判据是**第一条请求**打到了窗口选的那一档。
 */
test('还没有会话时，交代里带的模型选择就用在第一条消息上', async () => {
  const f = await collaborationRuntime('window-model-choice', () => ({ text: '收到，按新选择跑' }), {
    models: {
      default: { provider: 'controlled', model: 'entry-model' },
      cantrip: { provider: 'controlled', model: 'changed-model' },
      spell: { provider: 'controlled', model: 'member-model' },
      arcane: { provider: 'controlled', model: 'descendant-model' },
    },
  })
  try {
    f.client.send({ type: 'input.submit', text: '用换过的模型', model: { choice: 'cantrip' } })
    await f.wait('第一轮请求', () => f.calls.length >= 1)
    expect(f.calls[0]?.model).toBe('changed-model')
  } finally {
    await f.close()
  }
})
