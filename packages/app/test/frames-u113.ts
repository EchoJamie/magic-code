/** U113 的本地受控端点 + 既有真 PTY 驱动；不调用真实供应商。 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSandbox, createUiSession } from './ui/index.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import type { Fixture, UiSession } from './ui/index.ts'

const out = resolve('.ui-runs/u113')
mkdirSync(out, { recursive: true })
const requests: Record<string, unknown>[] = []
let spawned = false
let highUsage = false
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.method === 'GET') return Response.json({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] })
  const body = await request.json() as Record<string, unknown>
  requests.push({ url: request.headers.get('X-U113-Original-URL') ?? request.url, body })
  const frame = (choices: unknown, usage?: unknown) => `data: ${JSON.stringify({ id: 'u113', object: 'chat.completion.chunk', created: 1, model: body.model, choices, usage })}\n\n`
  const text = JSON.stringify(body.messages)
  if (!spawned && text.includes('U113委派示例')) {
    spawned = true
    const args = { operationId: 'u113-frame-member', name: '执行成员', responsibility: '核对未完成范围', scope: '受控执行检查', body: [{ kind: 'text', text: '仅核对未完成范围；不给工具效果。' }], model: { alias: 'spell' }, modelReason: '明确方案的常规执行任务' }
    return new Response(frame([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'u113-spawn', type: 'function', function: { name: 'agent_spawn', arguments: JSON.stringify(args) } }] } }]) + frame([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  const round = [...text.matchAll(/受控上下文第(\d+)轮/g)].at(-1)?.[1]
  const reply = round === undefined ? '受控工作答复' : `受控工作答复：第${round}轮完成`
  return new Response(frame([{ index: 0, delta: { content: reply } }]) + frame([{ index: 0, delta: {}, finish_reason: 'stop' }], { prompt_tokens: highUsage ? 200000 : 100, completion_tokens: 8 }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
} })
const wire: Fixture = { baseURL: `http://127.0.0.1:${server.port}/v1`, port: server.port!, requests: () => [], stop: async () => { server.stop(true) } }
const sandbox = createSandbox({ provider: 'none' })
sandbox.env['BUN_OPTIONS'] = `--preload=${resolve('packages/app/test/ui/u113-transport.ts')}`
sandbox.env['U113_FIXTURE_URL'] = wire.baseURL
const host = await startResidentHost(sandbox, resolve(out, 'host'))
let ui: UiSession | undefined
try {
  ui = await createUiSession({ label: 'U113-无配置接入与设置', artifacts: out, fixture: wire, sandbox, columns: 100, rows: 32 })
  // 按键节奏只模拟逐次输入；保存/请求/运行完成由下面的可见状态等待判定。
  const key = async (name: Parameters<UiSession['key']>[0]) => { await ui!.key(name); await Bun.sleep(60) }
  let savedDefaults = 0
  const defaultSaved = async () => {
    const expected = ++savedDefaults
    const until = Date.now() + 5000
    for (;;) {
      const frame = await ui!.capture({ label: '同步-Default保存回执' })
      if (frame.text.split('已保存 Default').length - 1 >= expected) return
      if (Date.now() >= until) throw new Error('新的 Default 保存回执未出现')
      await Bun.sleep(10)
    }
  }
  await ui.send('/model '); await key('enter')
  await ui.wait({ text: '默认模型 · Default' }, { timeoutMs: 5000 })
  console.log((await ui.capture({ label: '01-首次设置与缺配置' })).text)
  await key('enter')
  console.log((await ui.capture({ label: '02-使用此模型开始' })).text)
  await key('enter')
  console.log((await ui.capture({ label: '02a-供应商接入' })).text)
  await key('down'); await key('enter')
  console.log((await ui.capture({ label: '02b-接入凭据' })).text)
  await ui.send('local-only'); await key('enter')
  await ui.wait({ text: 'deepseek-chat' }, { timeoutMs: 5000 })
  console.log((await ui.capture({ label: '03-独立型号列表' })).text)
  for (let n = 0; n < 5; n++) await key('up')
  await key('enter')
  await defaultSaved()
  await ui.wait({ text: '已选择 Default' }, { timeoutMs: 5000 })
  console.log((await ui.capture({ label: '04-首次保存回执' })).text)
  await ui.send('/model '); await key('enter')
  await ui.wait({ text: '当前三个档位使用同一模型' }, { timeoutMs: 5000 })
  console.log((await ui.capture({ label: '05-四项独立设置' })).text)
  await key('down'); await key('enter')
  console.log((await ui.capture({ label: '06-编辑Cantrip' })).text)
  await key('down'); await key('enter')
  await ui.wait({ text: '已保存 Cantrip' }, { timeoutMs: 5000 })
  await ui.send('/model '); await key('enter')
  await key('enter'); await key('down'); await key('enter')
  await defaultSaved()
  writeFileSync(resolve(out, 'default-only-edit.json'), readFileSync(sandbox.configPath))
  await ui.send('/model '); await key('enter')
  console.log((await ui.capture({ label: '07-Default独立编辑不改变三档' })).text)
  await key('enter'); await key('up'); await key('enter')
  await defaultSaved()
  await ui.send('/model '); await key('enter')
  for (let n = 0; n < 4; n++) await key('down'); await key('enter')
  await ui.wait({ text: '作用对象：当前工作' }, { timeoutMs: 5000 })
  console.log((await ui.capture({ label: '08-当前工作选档' })).text)
  await ui.resize(46, 18); await ui.wait({ text: '作用对象：当前工作' }, { timeoutMs: 5000 })
  console.log((await ui.capture({ label: '09-窄窗工作选档' })).text)
  await ui.resize(100, 32); await key('esc')
  await ui.send('U113委派示例'); await key('enter')
  await ui.wait({ text: 'agent_spawn' }, { timeoutMs: 5000 }); await ui.send('y')
  await ui.wait({ text: '执行成员' }, { timeoutMs: 5000 }); await ui.wait({ text: '暂无执行' }, { timeoutMs: 5000 })
  await key('tab'); await key('down'); await key('enter')
  for (let n = 0; n < 5; n++) await key('down'); await key('enter')
  console.log((await ui.capture({ label: '10-成员模型设置作用对象' })).text)
  for (let n = 0; n < 4; n++) await key('down'); await key('enter')
  console.log((await ui.capture({ label: '11-成员独立选档' })).text)
  await key('esc')
  const config = JSON.parse(readFileSync(sandbox.configPath, 'utf8'))
  config.providers.deepseek.modelOverrides = { 'deepseek-reasoner': { limits: { maxInputTokens: 1 } } }
  writeFileSync(sandbox.configPath, JSON.stringify(config, null, 2))
  highUsage = true
  for (let n = 0; n < 12; n++) {
    const before = requests.length
    await ui.send(`受控上下文第${n}轮，请保留原始记录`); await key('enter')
    const until = Date.now() + 5000
    while (requests.length === before && Date.now() < until) await Bun.sleep(30)
    if (requests.length === before) throw new Error(`第${n}轮未发出请求`)
    await ui.wait({ text: `受控工作答复：第${n}轮完成` }, { timeoutMs: 5000 })
    await ui.wait({ text: '○ 空闲' }, { timeoutMs: 5000 })
  }
  await ui.wait({ text: '窗口不足' }, { timeoutMs: 5000 })
  console.log((await ui.capture({ label: '12-Cantrip压缩窗口不足与真实配置位置' })).text)
  await ui.send('/model '); await key('enter'); await key('down'); await key('enter')
  console.log((await ui.capture({ label: '13-失败后可达Cantrip设置' })).text)
  await key('esc')
  writeFileSync(resolve(out, 'configured.json'), readFileSync(sandbox.configPath))
  await ui.quit()
} finally {
  const report = await ui?.close()
  await host.close()
  await wire.stop()
  await sandbox.dispose()
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ proof: 'controlled-PTY-only', runDir: ui?.runDir, report, requests }, null, 2))
}
