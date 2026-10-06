/** U115：现行 runTui 真 PTY，接真实 manager/socket/executor，只有本地 HTTP 回答受控。 */
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runTui } from '@magic/tui'
import { loadConfig } from '../src/config.ts'
import { connectManager } from '../src/run/client.ts'
import { terminalOptions } from '../src/run/terminal.ts'
import { collaborationRuntime, latch, requestText } from './run-collaboration-fixture.ts'
import { createUiSession } from './ui/index.ts'

if (process.argv.includes('--terminal')) {
  const input = JSON.parse(process.argv[process.argv.indexOf('--terminal') + 1]!)
  const client = await connectManager(input.socket, { cwd: input.cwd, session: input.session, label: 'U115 真终端', expectedIdentity: input.identity, environment: process.env })
  if (!client) throw new Error('连接失败')
  const handle = await runTui(terminalOptions({ client, cwd: input.cwd, magic: input.magic, loaded: loadConfig({ magic: input.magic }), session: input.session }))
  try { await handle.waitUntilExit() } catch (error) { writeFileSync(join(input.cwd, 'terminal-error.txt'), String(error)); throw error } finally { client.close() }
} else {
  const out = resolve(process.argv[process.argv.indexOf('--out') + 1] ?? '.ui-runs/u115')
  mkdirSync(out, { recursive: true })
  const advisor = latch()
  const failure = latch()
  const f = await collaborationRuntime('u115-terminal', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return { text: '原工作已准备，等待查证问题。' }
      if (call.index === 1) return { tool: 'consult_arcane', args: { operationId: 'ui-consult', question: '初始化失败的证据如何解释？', body: [{ kind: 'text', text: '查 evidence.txt，只给建议。' }] } }
      if (call.index === 2) return { tool: 'write', args: { path: 'independent.txt', content: '独立步骤已完成' } }
      if (call.index === 3) return { tool: 'agent_wait', args: { operationId: 'ui-wait', agents: [f.member()!.agentId], expectation: '等初始化证据意见', deadline: Date.now() + 60000 } }
      if (call.index === 4) {
        if (!requestText(call).includes('初始化证据-426')) throw new Error('没有实际取证结果')
        return { text: '已收到 Arcane 建议。先核当前初始化代码，再按证据继续修复；顾问只读查证，修复仍由原工作负责。' }
      }
      if (call.index === 5) return { tool: 'consult_arcane', args: { operationId: 'ui-failure', question: '再核对另一份矛盾证据' } }
      if (call.index === 6) return { tool: 'agent_wait', args: { operationId: 'ui-wait-failure', agents: [f.members().filter(one => one.purpose === 'consultation').at(-1)!.agentId], expectation: '等第二份证据咨询', deadline: Date.now() + 60000 } }
      return { text: '这次咨询未完成，尚不能按建议执行依赖步骤。' }
    }
    if (call.index === 0) { await advisor.promise; return { tool: 'read', args: { path: 'evidence.txt' } } }
    if (call.index === 1) return { text: 'evidence.txt:1 给出初始化证据-426。建议对照注册顺序核对；当前文件可能变化，采纳前再读。尚未验证修复。' }
    await failure.promise
    return { text: '半截内容', finish: 'length' }
  }, { allowAll: true })
  writeFileSync(join(f.workspace, 'evidence.txt'), '初始化证据-426')
  let ui: Awaited<ReturnType<typeof createUiSession>> | undefined
  const captures: string[] = []
  const returns: {fromBytes:number;toBytes:number;cursor:unknown;label:string}[] = []
  const cancellations: {from:string;to:string;fromBytes:number;toBytes:number}[] = []
  try {
    f.shell.key({ kind: 'paste', text: '准备原工作' }); f.shell.key({ kind: 'enter' })
    await f.wait('原工作空闲', () => f.requests().length === 1 && f.events.some(one => one.kind === 'turn.end'))
    ui = await createUiSession({ columns: 200, rows: 40, artifacts: out, label: 'U115-真实终端', skipReady: true,
      command: [process.execPath, import.meta.path, '--terminal', JSON.stringify({ socket: f.manager.socketPath, identity: f.manager.identity, session: f.session(), cwd: f.workspace, magic: f.magic })] })
    await ui.wait({ text: '原工作已准备' })
    const capture = async (label: string) => { const frame = await ui!.capture({ label }); captures.push(frame.files.data); return frame }
    await capture('01-原工作')
    await ui.send('请就初始化证据咨询 Arcane，再继续独立步骤'); await ui.key('enter')
    await ui.wait({ text: '等初始化证据意见' })
    await capture('02-已受理独立步骤与依赖等待')
    // 扩展结果是受理事实，不能冒充顾问完成。
    await ui.key('ctrl+o'); await ui.wait({ text: 'advisorAgentId' })
    await capture('03-受理回执')
    const returnInput = async(label:string, fromBytes:number) => {
      await f.wait(label,async()=>{
        const screen=await ui!.screen()
        return Buffer.byteLength(ui!.rawText())>fromBytes && !screen.cursor.hidden &&
          !screen.lines.some(line=>/^\d+–\d+ \/ \d+ 行 ·/.test(line.text)) &&
          screen.lines.some(line=>/^› /.test(line.text)) && screen.lines.some(line=>line.text.includes('ctrl+c'))
      })
      const screen=await ui!.screen(),toBytes=Buffer.byteLength(ui!.rawText())
      assert(toBytes>fromBytes);assert(!screen.cursor.hidden)
      returns.push({label,fromBytes,toBytes,cursor:screen.cursor})
    }
    const layer = async() => {
      const screen=await ui!.screen(),text=screen.lines.map(line=>line.text).join('\n')
      if(screen.lines.some(line=>/^\d+–\d+ \/ \d+ 行 ·/.test(line.text)))return text.includes('咨询 Arcane · 对话与工具')?'member-reader':'main-reader'
      if(text.includes('查看记录不改变输入目标'))return 'members'
      if(text.includes('查看完整对话与工具')&&text.includes('只读咨询'))return 'member-actions'
      if(!screen.cursor.hidden && screen.lines.some(line=>line.row===screen.cursor.y&&/^\s*› /.test(line.text)))return 'input'
      throw Error('无法识别真实当前层：'+text)
    }
    const cancelToInput = async() => {
      const visited=new Set<string>()
      for(;;){
        const from=await layer();if(from==='input')return
        const fromBytes=Buffer.byteLength(ui!.rawText());await ui!.key('esc')
        let to=from
        await f.wait('取消 '+from+' 后新输出及实际下一层',async()=>{
          if(Buffer.byteLength(ui!.rawText())<=fromBytes)return false
          try{to=await layer();return to!==from}catch{return false}
        })
        const transition=from+'→'+to;assert(!visited.has(transition),'不能重复走同一取消路径');visited.add(transition)
        cancellations.push({from,to,fromBytes,toBytes:Buffer.byteLength(ui!.rawText())})
      }
    }
    const receiptBytes=Buffer.byteLength(ui.rawText())
    await cancelToInput();await returnInput('全文退出后真实返回原输入层',receiptBytes)
    advisor.release()
    await ui.wait({ text: '已收到 Arcane 建议' })
    await f.wait('顾问资源退出', () => f.member()!.reachability === 'historical' && !f.manager.executors().some(one => one.session === f.member()!.sessionId))
    await capture('04-完成回报与原工作继续')
    await ui.send('原工作草稿应保留'); await ui.wait({ text: '原工作草稿应保留' })
    const selected = async (label: string) => f.wait(`选择 ${label}`, async () => {
      const screen = await ui!.screen()
      const row = screen.lines.find(one => one.text.includes(label))
      return row !== undefined && screen.cellsOf(row.row).some(cell => cell.bold)
    })
    await ui.key('tab'); await ui.wait({ text: '查看记录不改变输入目标' })
    await ui.key('down'); await selected('咨询 Arcane'); await ui.key('enter'); await ui.wait({ text: '初始化证据-426' });
    const readonlyBytes=Buffer.byteLength(ui.rawText());await ui.send('i')
    await f.wait('i 后仍在顾问记录，目标未切换',async()=>Buffer.byteLength(ui!.rawText())>readonlyBytes && (await ui!.screen()).lines.some(line=>line.text.includes('咨询 Arcane · 对话与工具')))
    if ((await ui.screen()).lines.some(line => line.text.includes('向「咨询 Arcane」补充'))) throw new Error('咨询阅读键切换了输入目标');
    await ui.send('m'); await ui.wait({ text: '查看完整对话与工具' })
    const detail = await capture('05-咨询详情只读')
    if (detail.text.includes('模型与思考设置') || detail.text.includes('向「咨询 Arcane」补充')) throw new Error('咨询开放了换模或输入切换')
    await selected('查看完整对话与工具'); await ui.key('enter'); await ui.wait({ text: '初始化证据-426' })
    await capture('06-顾问原始查证过程')
    const memberBytes=Buffer.byteLength(ui.rawText());await cancelToInput();await returnInput('顾问阅读逐层返回原草稿新输出',memberBytes)
    await ui.wait({ text: '原工作草稿应保留' });
    const restored=await ui.screen();assert.equal(restored.lines.find(line=>line.row===restored.cursor.y)?.text.trimStart(),'› 原工作草稿应保留');assert(restored.lines.some(line=>line.text.includes('输入给：整件工作')));
    await capture('07-回原工作草稿与输入目标')
    await ui.key('enter') // 原工作草稿真实保留并在原输入目标提交。
    await f.wait('第二份咨询在途', () => f.requests('descendant-model').length === 3)
    failure.release()
    await ui.wait({ text: '这次咨询未完成' }); await capture('08-失败回报保留依赖边界')
    await ui.key('ctrl+c'); await ui.wait({ text: '转到后台' }); await ui.key('down'); await selected('转到后台'); await ui.key('enter')
  } finally {
    advisor.release(); failure.release()
    const report = ui === undefined ? undefined : await ui.close()
    await f.close()
    writeFileSync(join(out, 'result.json'), JSON.stringify({ proof: 'real-runTui-PTY-manager-socket-executor-controlled-http', captures, returns, cancellations, report, calls: f.calls, processExits: f.processExits }, null, 2))
    console.log(JSON.stringify({ out, captures: captures.length, report }))
  }
}
