import { startResidentHost } from './resident-host-fixture.ts'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { startFixture } from './ui/fixture.ts'
import { createSandbox } from './ui/sandbox.ts'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'

const evidence = REPO_ROOT + '/.ui-runs/u114'
const fixture = startFixture({turns:[{kind:'tool',name:'skill',args:{name:'record-skill'}},{kind:'text',text:'U114_SKILL_REQUEST_FINISHED',chunks:1,chunkDelayMs:10}]})
const sandbox = createSandbox({baseURL:fixture.baseURL})
const store = createRecordsStore({dataDir:sandbox.dataDir,workspace:[realpathSync(sandbox.workspace)]})
const at=Date.now(), root='u114-record-root', other='u114-record-other', member='u114-record-member'
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=','base64')
const blob=await store.blobs.put(image)
const first=store.serviceFor(root).appendEntry({kind:'user',at,content:{text:'近似工作摘要：核对阅读路径甲 Image#1'},payload:{refs:[{kind:'image',at:18,marker:'Image#1',source:join(sandbox.workspace,'absent.png'),label:'测试原图',name:'原件.png',mime:'image/png',blob}]}})
const long=(prefix:string)=>Array.from({length:180},(_,i)=>`${prefix}${String(i+1).padStart(3,'0')} 中文🙂é ${'R'.repeat(122)}`).join('\n')
store.serviceFor(root).appendEntry({kind:'assistant',at:at+1,content:{text:long('整体阅读')}})
store.serviceFor(other).appendEntry({kind:'user',at:at+2,content:{text:'近似工作摘要：核对阅读路径乙，专门区分另一条记录'}})
store.serviceFor(other).appendEntry({kind:'assistant',at:at+3,content:{text:'另一件工作的最新进展乙'}})
store.setSessionTitle(root,'近似工作摘要：核对阅读路径',at)
store.setSessionTitle(other,'近似工作摘要：核对阅读路径',at+2)
const model={alias:'default' as const,provider:'local',model:'MiniMax-M3'}
const coordinator=store.collaboration.registerAgent({operationId:'u114-root-register',sessionId:root,name:'入口',role:'协调',model,at})
store.collaboration.openCollaboration(coordinator.agentId,{operationId:'u114-open',origin:{sessionId:root,entryId:first},at})
const spawned=store.collaboration.spawn(coordinator.agentId,{operationId:'u114-spawn-read',sessionId:member,name:'材料成员',role:'阅读',model,body:[{kind:'text',text:'初始受控委派'}],scope:'仅阅读',source:{sessionId:root,entryId:first},authorization:[{sessionId:root,entryId:first}],at})
store.serviceFor(member).appendEntry({kind:'assistant',at:at+4,content:{text:long('成员阅读')}})
const discussion=store.collaboration.send(coordinator.agentId,{operationId:'u114-discussion-1',recipients:[spawned.agent.agentId],purpose:'question',startDiscussion:true,body:[{kind:'text',text:'讨论甲：材料一致性\n'+long('讨论甲')}],at:at+5})
store.collaboration.send(coordinator.agentId,{operationId:'u114-discussion-2',recipients:[spawned.agent.agentId],purpose:'question',startDiscussion:true,body:[{kind:'text',text:'讨论乙：读取边界\n'+long('讨论乙')}],at:at+6})
mkdirSync(join(sandbox.workspace,'.magic','skills','record-skill'),{recursive:true})
writeFileSync(join(sandbox.workspace,'.magic','skills','record-skill','SKILL.md'),'---\nname: record-skill\ndescription: 验证真实技能来源与按需自读请求\n---\nU114_SKILL_ACTUAL_SOURCE_BODY\n')
const host=await startResidentHost(sandbox,evidence+'/records-host-'+Date.now())
const ui=await createUiSession({fixture,sandbox,argv:['--session',root],columns:160,rows:40,label:'U114-完整记录材料讨论与接回',artifacts:evidence})
const key=async(k:Parameters<typeof ui.key>[0])=>{await ui.key(k);await Bun.sleep(100)}
const frame=async(label:string)=>{await Bun.sleep(100);return ui.capture({label})}
const calls=()=>ui.requests().filter(r=>r.path.endsWith('/chat/completions'))
try{
 await ui.wait({text:'整体阅读180'})
 await ui.send('整体保存草稿');await key('ctrl+o');await ui.wait({text:'整体阅读001'});await frame('160-整体全文真实身份')
 await ui.send(']');await ui.wait({text:'e 导出原图'});await ui.send('e');await Bun.sleep(250)
 await ui.send('G');await ui.wait({text:'原图已导出'});const exported=await frame('160-原图从记录blob取回')
 const match=exported.text.match(/原图已导出 → (.+)/);assert(match,'真实导出回执')
 assert(existsSync(match[1]!.trim()));assert.deepEqual(readFileSync(match[1]!.trim()),image)
 await ui.send(']');await key('enter');await ui.wait({text:'整体保存草稿Image#'});await frame('160-历史材料原位加入且未发送');assert.equal(calls().length,0)
 await key('tab');await ui.wait({text:'向整件工作补充'});await key('down');await key('enter');await ui.wait({text:'材料成员 · 对话与工具'})
 await key('pageDown');await ui.wait({text:'成员阅读040'});const memberPage=await frame('160-成员独立阅读位置')
 await ui.send('m');await ui.wait({text:'查看关联讨论与结果'});await key('down');await key('enter');await ui.wait({text:'讨论甲：材料一致性'})
 await frame('160-讨论根列表有真实标题');await key('down');await key('enter');await ui.wait({text:'讨论甲001'})
 await key('pageDown');await ui.wait({text:'讨论甲040'});const discussionPage=await frame('160-讨论甲独立位置')
 await key('esc');await ui.wait({text:'Enter 阅读整份讨论'});await key('enter');await ui.wait({text:'讨论甲040'});const restoredDiscussion=await frame('160-讨论甲返回位置不串成员');assert.equal(restoredDiscussion.text,discussionPage.text)
 await key('esc');await ui.wait({text:'Enter 阅读整份讨论'});await key('esc');await ui.wait({text:'查看关联讨论与结果'});await key('esc');await ui.wait({text:'材料成员 · 对话与工具'});const restoredMember=await frame('160-成员返回原阅读位置');assert.equal(restoredMember.text,memberPage.text)
 await ui.send('i');await ui.wait({text:'输入给：材料成员'});await ui.send('成员自己的稿');await key('ctrl+o');await ui.wait({text:'整体阅读'});await frame('160-成员输入时CtrlO仍是主会话');await key('esc');await ui.wait({text:'输入给：材料成员'})
 await key('tab');await ui.wait({text:'向整件工作补充'});await key('down');await key('down');await key('enter');await ui.wait({text:'整体保存草稿Image#'});assert.equal(calls().length,0)
 // 本地 resume 原文可召回；相同标题由真实工作区、最近交代与进展区分。
 for(let i=0;i<15;i++)await key('backspace')
 await ui.send('/resume ');await key('enter');await ui.wait({text:'找工作并接回'});await frame('160-相近摘要完整工作详情')
 await ui.send('NO_MATCH_U114');await ui.wait({text:'没有名称匹配'});await frame('160-接回筛词空态');await key('esc');await ui.wait({text:'/resume'})
 for(let i=0;i<8;i++)await key('backspace')
 await ui.send('/clear ');await key('enter');await ui.wait({text:'新会话'})
 await ui.send('/skills ');await key('enter');await ui.wait({text:'record-skill'});await key('enter');await ui.wait({text:'/record-skill'});await ui.send(' 请读这份技能');await key('enter');await ui.wait({text:'U114_SKILL_REQUEST_FINISHED'});await ui.wait({text:'○ 空闲'})
 assert(calls().some(r=>JSON.stringify(r.body).includes('U114_SKILL_ACTUAL_SOURCE_BODY')),'模型实际按需读技能的正文须进入后续请求')
 await frame('160-真实技能按需带入结果')
 writeFileSync(join(ui.runDir,'u114-record-facts.json'),JSON.stringify({facts:ui.facts(),fixtureSeed:true,root,other,member,discussion:discussion.messageId,imageBlob:blob,imageBytes:image.length,calls:calls(),inputs:store.serviceFor(root).inputs.list()},null,2))
 console.log(ui.runDir)
}finally{await ui.close({keepSandbox:true});await host.close();await fixture.stop();store.close()}
