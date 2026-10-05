import {strict as assert} from 'node:assert'
import {writeFileSync} from 'node:fs'
import {createUiSession, REPO_ROOT } from './ui/driver.ts'
for(const reduced of [false,true]){
 const ui=await createUiSession({columns:160,rows:40,label:`U114-motion-${reduced?'reduced':'normal'}`,artifacts:REPO_ROOT + '/.ui-runs/u114',config:{motion:{reduced}},turns:[
  {kind:'tool',name:'plan_update',args:{plan:{goal:'验证真实动效',steps:[{text:'执行受控工具并等待用户',status:'in_progress'}],notes:''}},reasoning:'THINKING_'+ 'a'.repeat(114),text:'执行',chunks:5,chunkDelayMs:1000},
  {kind:'tool',name:'exec',args:{cmd:'sleep 5; printf U114_TOOL_DONE'}},
  {kind:'tool',name:'exec',args:{cmd:'chmod 700 approved.sh'}},
  {kind:'text',text:'U114_MOTION_FINISHED',chunks:1,chunkDelayMs:10},
 ]})
 try{
  writeFileSync(`${ui.facts().workspace}/approved.sh`,'#!/bin/sh\n')
  await ui.send('验证思考、工具、计划、等待与静止');await ui.key('enter')
  await ui.wait({text:'THINKING'});await ui.capture({label:'160-真实思考'})
  await ui.wait({text:'sleep 5'},{timeoutMs:20000})
  await Bun.sleep(4400);await ui.capture({label:'160-工具与计划两轮'})
  await ui.wait({text:'Ctrl+G 审阅'});await ui.capture({label:'160-等用户到达'})
  await Bun.sleep(1200);await ui.capture({label:'160-等待一次提示后静止'})
  await ui.send('yan');await ui.wait({text:'yan'});await ui.capture({label:'160-审批不抢稿'})
  await ui.key('ctrl+g');await ui.wait({text:'本工作区总是允许'});await ui.capture({label:'160-主动审批'})
  await ui.send('n');await ui.wait({text:'U114_MOTION_FINISHED'});await ui.wait({text:'○ 空闲'})
  await Bun.sleep(1200);await ui.capture({label:'160-完成后静止'})
  const calls=ui.requests().filter(row=>row.path.endsWith('/chat/completions'))
  assert.equal(calls.length,4);assert(calls[3]!.body)
  writeFileSync(`${ui.runDir}/u114-motion-facts.json`,JSON.stringify({reduced,facts:ui.facts(),calls},null,2))
  console.log(ui.runDir)
 }finally{await ui.close({keepSandbox:true})}
}
