import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'
const ui=await createUiSession({columns:200,rows:40,label:'U114-本地字段编辑与密钥取消',artifacts:REPO_ROOT + '/.ui-runs/u114',turns:[]})
const key=async(k:Parameters<typeof ui.key>[0])=>{await ui.key(k);await Bun.sleep(80)}
try {
 const config=ui.facts().home+'/.magic/config.json',before=readFileSync(config,'utf8')
 await ui.send('/model manage ');await key('enter');await ui.wait({text:'local'})
 await key('enter');await ui.wait({text:'更新认证'})
 await key('enter');await ui.wait({text:'新名字'});await key('left');await key('left');await ui.send('X');await ui.wait({text:'locXal'})
 await ui.capture({label:'200-本地名字中间编辑不退出'})
 await key('esc');await ui.wait({text:'更新认证'});assert.equal(readFileSync(config,'utf8'),before)
 await key('down');await key('enter');await ui.wait({text:'密钥（输入不回显）'})
 await ui.send('\x1b[200~U114_MASKED_TEST\x1b[201~');await ui.wait({text:'••••'})
 await key('left');await ui.send('X');await ui.capture({label:'200-密钥粘贴中间编辑仍遮罩'})
 const screen=(await ui.screen()).lines.map(line=>line.text).join('\n')
 assert(!screen.includes('U114_MASKED_TEST'));assert(screen.includes('密钥（输入不回显）'))
 await key('esc');await ui.wait({text:'更新认证'});assert.equal(readFileSync(config,'utf8'),before)
 await key('esc');await ui.wait({text:'local'});await key('esc');await ui.wait({text:'○ 空闲'})
 await ui.send('/config ');await key('enter');await ui.wait({text:'减少动效'})
 await ui.send('动效');await ui.wait({text:'筛选「动效」'});await key('enter');await ui.wait({text:'已开 · Enter 切换'});await ui.wait({text:'已更新：动效'})
 const saved=JSON.parse(readFileSync(config,'utf8'));assert.equal(saved.motion.reduced,true)
 await ui.capture({label:'200-减少动效开关结果可见且实际保存'})
 assert.equal(ui.requests().length,0)
 writeFileSync(ui.runDir+'/u114-prompts-facts.json',JSON.stringify({facts:ui.facts(),zeroModelRequests:true,renameCancelConfigUnchanged:true,secretPasteMasked:true,secretCancelConfigUnchanged:true,motionSaved:saved.motion},null,2))
 console.log(ui.runDir)
} finally {await ui.close({keepSandbox:true})}
