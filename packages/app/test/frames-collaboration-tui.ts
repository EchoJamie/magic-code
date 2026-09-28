/** 局部契约夹具 + 既有 ui/driver 真 PTY。只证明 TUI，不替代 manager/真实模型集成。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command, ControlTransport, KernelEvent } from '@magic/contracts'
import { runTui } from '@magic/tui'
import { collaborationDetail, collaborationFixture, event } from './frames-collaboration-fixture.ts'
import { createUiSession } from './ui/index.ts'

if (process.argv.includes('--fixture')) {
  const listeners = new Set<(event: KernelEvent) => void>()
  const emit = (item: KernelEvent): void => { for (const listener of listeners) listener(item) }
  const transport: ControlTransport = {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    send(command: Command) {
      if (command.type === 'collaboration.read') emit(event('collaboration.view', collaborationDetail(command.member)))
      if (command.type === 'model.list') emit(event('model.catalog', { entries: [{ provider: 'local', model: 'mini' }], current: { provider: 'local', model: 'mini' } }))
      if (command.type === 'collaboration.configure') emit(event('collaboration.view', { ...collaborationFixture, note: `夹具已接收配置：${command.member ?? '后续派生默认'}` }))
      if (command.type === 'collaboration.stop') emit(event('collaboration.view', { ...collaborationFixture, note: command.delegation === undefined ? '夹具已接收整体停止' : `夹具已接收局部停止：委派 ${command.delegation}` }))
      if (command.type === 'collaboration.input') {
        emit(event('input.settled', { ok: true, ref: command.input.ref! }, { session: command.member === undefined ? 'origin' : 'member' }))
        if (command.input.text.includes('需要审批')) emit(event('tool.decision.request', { call: 500, name: 'exec', material: '运行回调验证：bun test callback.test.ts', weight: 'light' }, { session: 'member', id: 501 }))
      }
      if (command.type === 'decision.answer') emit(event('tool.decision', { call: 500, decision: command.decision, decider: 'user', elapsedMs: 100 }, { session: 'member' }))
    },
  }
  const handle = await runTui({ transport, boot: async () => {
    emit(event('session.state', { active: 'origin', sessions: [{ id: 'origin', title: '修复支付回调', at: 0 }] }))
    emit(event('collaboration.view', collaborationFixture))
  } })
  await handle.waitUntilExit()
} else {
  const out = resolve(process.argv[process.argv.indexOf('--out') + 1] ?? '.ui-runs/collaboration-tui/local')
  // --out 缺席时不把脚本路径认成输出目录。
  const artifacts = process.argv.includes('--out') ? out : resolve('.ui-runs/collaboration-tui/local')
  mkdirSync(artifacts, { recursive: true })
  const narrow = process.argv.includes('--narrow')
  const ui = await createUiSession({ label: narrow ? '协作-TUI-窄窗夹具' : '协作-TUI-契约夹具', columns: narrow ? 46 : 100, rows: narrow ? 18 : 30, artifacts,
    command: [process.execPath, import.meta.path, '--fixture'], skipReady: true })
  const key = async (...args: Parameters<typeof ui.key>): Promise<void> => { await ui.key(...args); await Bun.sleep(40) }
  const captures: string[] = []
  const capture = async (label: string, contains: string): Promise<void> => {
    await ui.wait({ text: contains }, { timeoutMs: 5000 })
    const frame = await ui.capture({ label })
    if (!frame.text.includes(contains)) throw new Error(`${label} 没有 ${contains}`)
    captures.push(frame.files.text)
  }
  const down = async (count: number): Promise<void> => { for (let i = 0; i < count; i++) await key('down') }
  const member = async (): Promise<void> => {
    await key('tab', { until: { text: '后续派生的默认模型' }, timeoutMs: 5000 })
    await down(1)
    await key('enter', { until: { text: '查看完整对话与工具' }, timeoutMs: 5000 })
  }
  try {
    await ui.wait({ text: '1 位执行中' }, { timeoutMs: 5000 })
    await ui.wait({ absent: '启动中' })
    if (narrow) {
      await member(); await down(2); await key('enter')
      await capture('01-窄窗点名委派', '停止「补充复核」')
      await key('left'); await down(1); await key('enter')
      await capture('02-窄窗阅读工具', '回调兼容测试通过')
      await key('esc'); await key('ctrl+c'); await key('ctrl+c')
    } else {
    await capture('01-入口空闲成员执行', '1 位执行中')
    await ui.send('整体保留的草稿', { until: { text: '整体保留的草稿' } })
    await member()
    await capture('02-成员详情仍输入整体', '输入给：整件工作')
    await down(3); await key('enter')
    await capture('03-成员对话与工具', '回调兼容测试通过')
    await ui.send('\u001b[6~')
    await capture('04-成员阅读翻页', '第 12 项检查')
    await key('left'); await down(1); await key('enter')
    await capture('05-讨论引用及保留分歧', '未解决的兼容性疑点')
    await key('left'); await key('up'); await key('up'); await key('up'); await key('enter')
    await ui.send('需要审批，成员草稿', { until: { text: '需要审批，成员草稿' } })
    await capture('06-显式输入成员', '输入给：实现')
    await key('enter')
    await capture('07-审批成员与原因', '实现 · exec')
    await ui.send('y', { until: { absent: '实现 · exec' } })
    await key('tab'); await down(2); await key('enter')
    await capture('08-返回整体原稿', '整体保留的草稿')
    await member(); await down(2); await key('enter')
    await capture('09-点名局部委派', '停止「补充复核」')
    await ui.resize(46, 18)
    await Bun.sleep(100)
    await capture('10-窄窗局部停止', '停止「回调校验」')
    await key('down'); await key('enter')
    await capture('11-局部停止回执', '委派 11')
    await key('tab'); await down(4); await key('enter')
    await capture('12-按需默认模型配置', '后续派生的默认配置')
    await key('enter')
    await capture('13-思考设置作用对象', '后续派生默认')
    await key('esc')
    // 当前夹具入口空闲，既有 Ctrl+C 仅退出窗口；本脚本不声明 U100 验收。
    await key('ctrl+c'); await key('ctrl+c')
    }
  } finally {
    const report = await ui.close()
    writeFileSync(resolve(artifacts, 'result.json'), JSON.stringify({ proof: 'local-contract-PTY-only', captures, report }, null, 2))
    console.log(JSON.stringify({ captures: captures.length, ...report }))
  }
}
