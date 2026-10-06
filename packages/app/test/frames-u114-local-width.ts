import {strict as assert} from 'node:assert'
import {writeFileSync} from 'node:fs'
import {createUiSession, REPO_ROOT } from './ui/driver.ts'
const root=REPO_ROOT
const probe='U114_LOCAL_'+'a'.repeat(112)
const command='sleep 0.5; printf '+probe
const ui=await createUiSession({columns:200,rows:40,label:'U114-后台回执与编辑器长错',artifacts:root+'/.ui-runs/u114',env:{VISUAL:probe,EDITOR:probe},turns:[{kind:'tool',name:'exec',args:{cmd:command,background:true}},{kind:'text',text:'U114_BG_STARTED',chunks:1,chunkDelayMs:10},{kind:'text',text:'U114_BG_RECEIPT_DONE',chunks:1,chunkDelayMs:10}]})
try {
 await ui.send('长后台回执与本地报错');await ui.key('enter');await ui.wait({text:'跑完了'},{timeoutMs:10000});await ui.wait({text:'○ 空闲'})
 for(const columns of [200,100]) {
  if(columns!==200){await ui.resize(columns,40);await ui.wait({writtenFrame:columns})}
  await Bun.sleep(100);const frame=await ui.capture({label:`${columns}-真实后台命令完整回执`})
  if(columns===200)assert(frame.text.includes(command),'后台回执先组装截60的旧约束必须已删除')
 }
 await ui.resize(200,40);await ui.wait({writtenFrame:200});await ui.key('ctrl+o');await ui.wait({text:'PgUp/PgDn'});await ui.send('v');await ui.wait({text:'起不了编辑器'})
 for(const columns of [200,100]) {
  if(columns!==200){const before=ui.rawText().length;await ui.resize(columns,40);await Bun.sleep(100);assert(ui.rawText().length>before,'全文改窗须有新的实际输出，不能拿旧屏套新尺寸')}
  await Bun.sleep(100);const frame=await ui.capture({label:`${columns}-真实编辑器启动长错`});assert.equal(frame.columns,columns)
  if(columns===200)assert(frame.text.includes(probe),'编辑器错误须保留超60列的真实文件名')
 }
 writeFileSync(ui.runDir+'/u114-local-width-facts.json',JSON.stringify({proof:'real CLI, background sleep/printf, real failed v editor launch, isolated env only',command,editor:probe,facts:ui.facts(),requests:ui.requests()},null,2));console.log(ui.runDir)
}finally{await ui.close({keepSandbox:true})}
