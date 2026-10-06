/** 长会话名、计划、待带入消息与审批；真实 CLI/PTY，隔离 HOME 与本地端点。 */
import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'
const columns=Number(process.argv[2]??200)
const title='核对跨目录配置变更与完整审批材料，并保留计划、排队消息和用户草稿的长会话名称'
const pending='PENDING_LAYOUT：工具完成后请核对原工作区中的变更，不要丢弃这条补充消息。'
const plan={steps:[{text:'PLAN_FIRST：定位原配置',status:'completed'},{text:'PLAN_ACTIVE：审阅当前执行动作',status:'in_progress'},{text:'PLAN_LAST：确认排队补充已带入',status:'pending'}],notes:'保持原工作区与已有草稿'}
const ui=await createUiSession({columns,rows:40,label:`20261007-layout-${columns}`,artifacts:REPO_ROOT+'/.ui-runs/defects-20261007',turns:[
 {kind:'text',text:'已建立隔离验收会话。',chunks:1,chunkDelayMs:20},
 {kind:'tool',name:'plan_update',args:{plan},chunks:1,chunkDelayMs:20},
 {kind:'tool',name:'exec',args:{cmd:'chmod 755 . && sleep 1 && printf LAYOUT_TOOL_DONE'},text:'正在准备当前执行动作。',reasoning:'先检查审批材料、保留补充消息与原来的草稿。'.repeat(8),chunks:20,chunkDelayMs:200},
 {kind:'text',text:'LAYOUT_FINISHED：计划、审批和排队输入的受控流程完成。',chunks:1,chunkDelayMs:20},
]})
try{
 await ui.send('建立验收会话');await ui.key('enter');await ui.wait({text:'已建立隔离验收会话。'});await ui.wait({text:'○ 空闲'})
 await ui.send('/rename '+title);await ui.key('enter');await ui.wait({text:'○ 空闲 · 核对跨目录配置'})
 await ui.send('开始布局验收');await ui.key('enter');await ui.wait({text:'PLAN_ACTIVE'});await ui.wait({text:'思考'})
 await ui.wait({text:'↑↓ 选择'},{timeoutMs:20000})
 await ui.capture({label:'long-title-plan-approval-arrives'})
 await ui.key('esc');await ui.wait({text:'Tab 进入决策'})
 await ui.send(pending,{until:{text:'PENDING_LAYOUT'}});await ui.key('enter');await ui.wait({text:'待带入'})
 await ui.send('DRAFT_PRESERVED：这条草稿还未发送',{until:{text:'DRAFT_PRESERVED'}})
 const working=await ui.capture({label:'plan-pending-draft'})
 const lines=working.text.split('\n'),rules=lines.flatMap((line,i)=>/^─{5}/.test(line)?[i]:[])
 assert.equal(rules.length,2)
 assert(lines.findIndex(line=>line.includes('PLAN_ACTIVE'))<rules[0]!)
 assert(lines.findIndex(line=>line.includes('DRAFT_PRESERVED'))>rules[0]!)
 assert(working.text.includes('PENDING_LAYOUT'))
 await ui.key('tab');await ui.wait({text:'↑↓ 选择'})
 const approval=await ui.capture({label:'long-title-plan-pending-approval'})
 assert(approval.text.includes('○ 批准这一次'));assert(approval.text.includes('chmod 755'));assert(approval.text.includes('PENDING_LAYOUT'))
 await ui.key('esc');await ui.wait({text:'Tab 进入决策'})
 const returned=await ui.capture({label:'esc-restores-draft-pending-visible'})
 assert(returned.text.includes('DRAFT_PRESERVED'));assert(returned.text.includes('PENDING_LAYOUT'))
 await ui.key('tab');await ui.wait({text:'↑↓ 选择'});await ui.key('down');await ui.key('enter')
 await ui.wait({text:'LAYOUT_FINISHED'},{timeoutMs:20000});await ui.wait({text:'○ 空闲'})
 await ui.capture({label:'finished-draft-preserved'})
 assert(ui.requests().some(request=>JSON.stringify(request.body).includes('PENDING_LAYOUT')))
 await ui.quit()
 writeFileSync(ui.runDir+'/layout-facts.json',JSON.stringify({title,pending,plan,columns,facts:ui.facts()},null,2))
 console.log(ui.runDir)
}finally{await ui.close()}
