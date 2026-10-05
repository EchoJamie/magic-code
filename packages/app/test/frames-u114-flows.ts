import { startResidentHost } from './resident-host-fixture.ts'
import {strict as assert} from 'node:assert'
import {mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {Database} from 'bun:sqlite'
import {startFixture} from './ui/fixture.ts'
import {createSandbox} from './ui/sandbox.ts'
import {commitGrants} from '../src/grants-file.ts'
import {createUiSession, REPO_ROOT } from './ui/driver.ts'
const long=Array.from({length:180},(_,i)=>`记录第${String(i+1).padStart(3,'0')}行 · 中文 🙂 é · ${'L'.repeat(135)}`).join('\n')
const fixture=startFixture({turns:[
 {kind:'tool',name:'exec',args:{cmd:'chmod 700 approved.sh'}},
 {kind:'tool',name:'exec',args:{cmd:'cat docs/note.txt'}},
 {kind:'text',text:long,chunks:1,chunkDelayMs:10},
 {kind:'tool',name:'agent_spawn',args:{operationId:'u114-read-member',name:'阅读成员',responsibility:'仅验证隔离记录阅读',scope:'临时工作区受控验收',body:[{kind:'text',text:'请返回可阅读的受控记录，不修改文件。'}]}},
 {kind:'text',text:long,chunks:1,chunkDelayMs:10},
]})
const sandbox=createSandbox({baseURL:fixture.baseURL})
writeFileSync(join(sandbox.workspace,'approved.sh'),'#!/bin/sh\n')
assert.equal(commitGrants(sandbox.grantsPath,[{kind:'grant',workspace:realpathSync(sandbox.workspace),grant:{tool:'exec',path:'**',op:'read',grantedAt:Date.now()}}]).ok,true)
const host=await startResidentHost(sandbox, REPO_ROOT + '/.ui-runs/u114/flow-host-'+Date.now())
const ui=await createUiSession({fixture,sandbox,columns:160,rows:40,label:'U114-连续功能验收',artifacts:REPO_ROOT + '/.ui-runs/u114'})
const key=async(k:Parameters<typeof ui.key>[0])=>{await ui.key(k);await Bun.sleep(60)}
const frame=async(label:string)=>{await Bun.sleep(100);return ui.capture({label})}
const requests=()=>ui.requests().filter(r=>r.path.endsWith('/chat/completions')).length
try{
 const ws=ui.facts().workspace
 mkdirSync(join(ws,'docs'),{recursive:true});writeFileSync(join(ws,'docs','note.txt'),'U114_MATERIAL_ACTUAL\n')
 writeFileSync(join(ws,'.hidden'),'hidden');writeFileSync(join(ws,'ordinary.txt'),'ordinary')
 mkdirSync(join(ws,'.magic','skills','local-skill'),{recursive:true})
 writeFileSync(join(ws,'.magic','skills','local-skill','SKILL.md'),'---\nname: local-skill\ndescription: 真实完整用途 '+ '用途说明'.repeat(40)+'\n---\nU114_SKILL_ACTUAL\n')
 await frame('160-新工作')
 await ui.send('/config ');await key('enter');await ui.wait({text:'减少动效'});await frame('160-设置层级')
 await ui.send('数据');await ui.wait({text:'筛选「数据」'});await key('left');await ui.send('X');await ui.wait({text:'数X据'});await frame('160-筛词原位插入')
 await key('backspace');await key('enter');await ui.wait({text:'数据与工作区'});await frame('160-只读路径')
 await ui.send('IGNORED');assert(!(await ui.screen()).lines.map(line=>line.text).join('\n').includes('IGNORED'))
 await key('esc');await ui.wait({text:'筛选「数据」'});await frame('160-只退子层')
 await key('esc');await ui.send('ORIGINAL ');await ui.wait({text:'ORIGINAL'})
 await ui.send('@');await ui.wait({text:'引用文件或目录'});await ui.send('docs/no-match');await ui.wait({text:'没有对得上的'});await frame('160-路径无匹配')
 await key('esc');await ui.wait({text:'ORIGINAL'});assert(!(await ui.screen()).lines.map(line=>line.text).join('\n').includes('@docs/no-match'))
 for(let i=0;i<9;i++)await key('backspace')
 await ui.send('@');await ui.wait({text:'引用文件或目录'});await ui.send('docs/');await ui.wait({text:'note.txt'});await key('down');await key('tab');await ui.wait({text:'note.txt'});await key('enter')
 await ui.wait({absent:'引用文件或目录'});await frame('160-文件引用未发送');assert.equal(requests(),0)
 await ui.send(' 读取实际材料');await key('enter');await ui.wait({text:'Ctrl+G 审阅'})
 await ui.send('yan\n审批不抢稿');await ui.wait({text:'审批不抢稿'});await frame('160-审批到达不抢多行稿')
 await key('ctrl+g');await ui.wait({text:'本工作区总是允许'});await frame('160-主动进入审批')
 await key('esc');await ui.wait({text:'审批不抢稿'});await frame('160-审批取消还稿')
 await key('ctrl+g');await ui.wait({text:'本工作区总是允许'});await ui.send('y')
 await ui.wait({text:'○ 空闲'},{timeoutMs:20000});await frame('160-完成且草稿仍在')
 assert(JSON.stringify(ui.requests().find(request=>request.path.endsWith('/chat/completions'))!.body).includes('@docs/note.txt'),'引用原位和身份须进入实际请求')
 assert(ui.requests().some(request=>JSON.stringify(request.body).includes('U114_MATERIAL_ACTUAL')),'按需自读的实际文件内容须随真实工具结果进入后续请求')
 // 清除当前未提交稿，逐字背删；每步是真 PTY 输入。
 for(let i=0;i<10;i++)await key('backspace')
 await ui.send('/grants ');await key('enter');await ui.wait({text:'工作区授权'});await frame('160-授权列表')
 const db=new Database(join(ui.facts().dataDir,'records.db'),{readonly:true})
 const grantPath=join(ui.facts().home,'.magic','grants.json')
 // 只比较这个隔离实例的真实授权文件。
 const before=readFileSync(grantPath,'utf8')
 await key('enter');await ui.wait({text:'授权详情'});await frame('160-授权详情默认返回')
 assert.equal(readFileSync(grantPath,'utf8'),before)
 await key('enter');await ui.wait({text:'工作区授权'});assert.equal(readFileSync(grantPath,'utf8'),before)
 await key('enter');await ui.wait({text:'授权详情'});await key('down');await key('enter');await ui.wait({text:'已撤销'})
 assert.notEqual(readFileSync(grantPath,'utf8'),before)
 await frame('160-明确撤销后安全焦点')
 await key('esc')
 for(let i=0;i<8;i++)await key('backspace')
 await key('ctrl+o');await ui.wait({text:'记录第001行'});const first=await frame('160-全文第一页')
 await key('pageDown');const second=await frame('160-全文第二页');assert.notEqual(second.text,first.text)
 await ui.send('\x1b[6');await ui.send('~');await Bun.sleep(100);const third=await frame('160-分段翻页第三页');assert.notEqual(third.text,second.text)
 await ui.send('\x1b[99~');await Bun.sleep(100);assert(!(await ui.screen()).lines.map(line=>line.text).join('\n').includes('[99~'))
 await ui.send('/NO_MATCH_U114');await key('enter');await frame('160-搜索无命中')
 await key('esc');await ui.send('/记录第080行');await key('enter');await frame('160-搜索定位')
 await ui.send('n');await ui.send('N');await frame('160-搜索下上命中')
 await key('esc');await key('esc');await ui.wait({text:'○ 空闲'});await frame('160-全文退回主屏')
 await ui.send('U114成员阅读');await key('enter');await ui.wait({text:'Ctrl+G 审阅'})
 await key('ctrl+g');await ui.wait({text:'批准'});await ui.send('y');await ui.wait({text:'阅读成员'},{timeoutMs:20000})
 await ui.wait({text:'○ 空闲'},{timeoutMs:20000})
 await ui.send('整体独立草稿');await key('tab');await ui.wait({text:'向整件工作补充'});await frame('160-整体成员列表')
 // 默认第一项为协调者，第二项是受控派生成员。
 await key('down');await key('enter');await ui.wait({text:'阅读成员 · 对话与工具'});await frame('160-成员整屏阅读')
 await key('pageDown');await frame('160-成员阅读位置')
 await ui.send('m');await ui.wait({text:'向「阅读成员」补充'});await frame('160-成员操作默认阅读')
 await key('esc');await ui.wait({text:'阅读成员 · 对话与工具'})
 await ui.send('i');await ui.wait({text:'输入给：阅读成员'});await ui.send('成员独立草稿');await ui.wait({text:'成员独立草稿'});await frame('160-明确成员输入不发送')
 const members=db.query('SELECT * FROM collaboration_agents').all()
 const events=db.query("SELECT session,id,kind,data FROM events WHERE kind IN ('input.local','tool.decision') ORDER BY id").all()
 writeFileSync(`${ui.runDir}/u114-flow-facts.json`,JSON.stringify({facts:ui.facts(),requests:ui.requests(),members,events},null,2));db.close()
 console.log(ui.runDir)
}finally{await ui.close({keepSandbox:true});await host.close();await fixture.stop()}
