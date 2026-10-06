import {strict as assert} from 'node:assert'
import {writeFileSync} from 'node:fs'
import {createUiSession, REPO_ROOT } from './ui/driver.ts'
const root=REPO_ROOT
const probe='WIDTH_PROBE_'+'a'.repeat(110)
const ui=await createUiSession({command:[process.execPath,root+'/packages/tui/test/u114-summary-window.ts'],columns:200,rows:40,label:'U114-122列四类摘要呈现',artifacts:root+'/.ui-runs/u114',turns:[]})
try {
 await ui.wait({text:'exec(rejected)'})
 for(const columns of [200,100]) {
  if(columns!==200){await ui.resize(columns,40);await ui.wait({writtenFrame:columns})}
  await Bun.sleep(150)
  const frame=await ui.capture({label:`${columns}-思考成功失败拒绝同一122列原文`})
  const lines=frame.text.split('\n').filter(line=>line.includes(probe))
  assert.equal(lines.length,4,'思考与三个不同状态摘要必须全部真实出现')
  assert(lines.every(line=>!line.includes('…')))
 }
 assert.equal(ui.requests().length,0)
 writeFileSync(ui.runDir+'/u114-summary-facts.json',JSON.stringify({probe,proof:'product runTui real PTY; controlled KernelEvents; not actual tool execution',states:['thinking','ok','failed','rejected'],zeroModelRequests:true,facts:ui.facts()},null,2));console.log(ui.runDir)
}finally{await ui.close({keepSandbox:true})}
