import {strict as assert} from 'node:assert'
import {readFileSync,writeFileSync} from 'node:fs'
import {createUiSession,type Capture, REPO_ROOT } from './ui/driver.ts'
const root=REPO_ROOT
const ui=await createUiSession({command:[process.execPath,root+'/packages/tui/test/u114-paging-window.ts'],columns:160,rows:40,label:'U114-其它翻页入口',artifacts:root+'/.ui-runs/u114',turns:[]})
try {
 await ui.wait({text:'真实计划步骤001'});await ui.send('保留当前草稿');await ui.wait({text:'保留当前草稿'})
 const frame=async(label:string)=>{await Bun.sleep(120);return ui.capture({label})}
 const bytes=(f:Capture)=>JSON.parse(readFileSync(ui.runDir+'/'+f.files.data,'utf8')).bytes
 const first=await frame('160-计划首页与草稿')
 await ui.key('pageDown');const second=await frame('160-计划真实PgDn')
 assert(second.text.includes('上面'));assert(!second.text.includes('真实计划步骤001'));assert.notEqual(second.text,first.text);assert(bytes(second)>bytes(first));assert(second.text.includes('保留当前草稿'))
 await ui.key('pageUp');const back=await frame('160-计划真实PgUp还原')
 assert.equal(back.text,first.text);assert(bytes(back)>bytes(second));assert.equal(ui.requests().length,0)
 writeFileSync(ui.runDir+'/u114-paging-facts.json',JSON.stringify({facts:ui.facts(),proof:'product runTui actual PTY, controlled KernelEvents; no actual tool or model execution',pageDownNewOutput:true,pageUpRestoresBodyAndDraft:true,zeroModelRequests:true},null,2));console.log(ui.runDir)
}finally{await ui.close({keepSandbox:true})}
