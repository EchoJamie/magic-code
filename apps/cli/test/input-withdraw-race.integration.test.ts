/** U114 撤回复现——现场：轮进行中连发两条排队，撤回后消息仍被消费。
 *
 * 真 manager/socket/executor/shell 全链路：夹具见 `run-collaboration-fixture.ts`。
 * 目标是把「撤回没打通」的环节钉出来：UI 发没发命令（`commands` 捕获）→
 * 引擎账本撤没撤掉（`inputs` 行状态）→ 消费还发不发生（`requests`）。
 */
import { expect, test } from 'bun:test'
import { collaborationRuntime, latch } from './run-collaboration-fixture.ts'

test('复现：轮进行中排队两条，alt+up 整组撤回应让账本变 withdrawn 且不再消费', async () => {
  const busy = latch()
  const f = await collaborationRuntime('u114-withdraw-race', async call => {
    if (call.index === 0) { await busy.promise; return { text: '第一轮收尾' } }
    return { text: '队列消息处理' }
  })
  try {
    // 起第一轮，模型挂住不回（模拟现场：模型正在干活）
    f.shell.key({ kind: 'paste', text: '开始干活' }); f.shell.key({ kind: 'enter' })
    await f.wait('第一轮在跑', () => f.requests().length === 1)

    // 轮进行中连发两条排队
    f.shell.key({ kind: 'paste', text: '第一条排队交代' }); f.shell.key({ kind: 'enter' })
    f.shell.key({ kind: 'paste', text: '第二条排队交代' }); f.shell.key({ kind: 'enter' })
    await f.wait('两条都收到受理回执', () => {
      const settled = f.events.filter(one => one.kind === 'input.settled')
      return ['第一条排队交代', '第二条排队交代'].every(text => {
        const ref = f.store.serviceFor(f.session()!).inputs.list().find(one => one.input.text === text)?.ref
        return ref !== undefined && settled.some(one => 'ref' in one.data && one.data.ref === ref && one.data.ok === true)
      })
    })

    // 关键证据点：受理回执之后，账本行还停在 pending（可撤）还是已被 dequeue 成 executing？
    const mid = f.store.serviceFor(f.session()!).inputs.list().filter(one => one.input.text.includes('排队交代'))
    console.log('--- 受理后的账本行状态:', JSON.stringify(mid.map(one => ({ text: one.input.text, state: one.state, revision: one.revision }))))
    const view = f.shell.getView()
    console.log('--- UI 快照里的行:', JSON.stringify(view.pendingInputs.map(one => ({ ref: one.ref.slice(0, 8), state: one.state }))))

    // 整组撤回
    f.shell.key({ kind: 'alt+up' })
    await Bun.sleep(800)
    const after = f.store.serviceFor(f.session()!).inputs.list().filter(one => one.input.text.includes('排队交代'))
    console.log('--- alt+up 后的账本行状态:', JSON.stringify(after.map(one => ({ text: one.input.text, state: one.state, revision: one.revision }))))
    console.log('--- shell 发出的 withdraw 命令数:', f.commands.filter(c => c.type === 'input.manage' && c.action === 'withdraw').length)

    // 放行模型：第一轮收尾后，不应再消费被撤的两条（不会有第二轮请求）
    busy.release()
    await f.wait('第一轮收尾', () => f.manager.runs().find(run => run.session === f.session())?.state === 'idle')
    await Bun.sleep(600)
    expect(f.requests().length).toBe(1)
    expect(f.requests().some(call => JSON.stringify(call.body).includes('排队交代'))).toBe(false)
  } finally { busy.release(); await f.close() }
}, 30000)
