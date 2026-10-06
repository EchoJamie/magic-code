import { startResidentHost } from './resident-host-fixture.ts'
import {strict as assert} from 'node:assert'
import {writeFileSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {Database} from 'bun:sqlite'
import {createUiSession, REPO_ROOT } from './ui/driver.ts'
import {startFixture} from './ui/fixture.ts'
import {createSandbox} from './ui/sandbox.ts'
import {commitGrants} from '../src/grants-file.ts'
const root=REPO_ROOT
for(const before of (process.argv.includes('--current-only') ? [false] : [true,false])){
 const fixture=startFixture({turns:[{kind:'text',text:'BASELINE_HISTORY_REPLY',chunks:1,chunkDelayMs:10},{kind:'tool',name:'exec',args:{cmd:'chmod 700 approved.sh'}},{kind:'text',text:'AFTER_APPROVAL',chunks:1,chunkDelayMs:10}]})
 const sandbox=createSandbox({baseURL:fixture.baseURL});writeFileSync(join(sandbox.workspace,'approved.sh'),'#!/bin/sh\n')
 commitGrants(sandbox.grantsPath,[{kind:'grant',workspace:realpathSync(sandbox.workspace),grant:{tool:'exec',path:'**',op:'read',grantedAt:Date.now()}}])
 const host=await startResidentHost(sandbox,root+'/.ui-runs/u114/comparison-host-'+Date.now(),before?root+'/.ui-runs/u114-baseline/packages/app/src/cli.ts':root+'/packages/app/src/cli.ts')
 const ui=await createUiSession({fixture,sandbox,columns:200,rows:40,label:`U114-${before?'修前':'修后'}-核心对照`,artifacts:root+'/.ui-runs/u114',...(before?{checkout:root+'/.ui-runs/u114-baseline'}: {})})
 const key=async(k:Parameters<typeof ui.key>[0])=>{await ui.key(k);await Bun.sleep(100)}
 const frame=async(label:string)=>{await Bun.sleep(100);return ui.capture({label})}
 const findings:any[]=[]
 try{
  await ui.send('ESC_KEEP_DRAFT');await key('esc');const esc=await frame('200-正文Esc');findings.push({rule:'正文Esc保持完整稿',pass:esc.text.includes('ESC_KEEP_DRAFT')})
  if(!before){for(let i=0;i<14;i++)await key('backspace')}
  await ui.send('/help ');await key('enter');await ui.wait({text:before?'可用命令':'输入任务描述开始工作'});const command=await frame('200-slash输入记录');findings.push({rule:'slash原文按用户输入回显',pass:before?command.text.includes('› /help'):(await ui.screen()).history.some(line=>line.startsWith('› /help'))})
  await key('ctrl+p');const history=await frame('200-slash召回');findings.push({rule:'CtrlP召回完整slash稿',pass:history.text.split('\n').some(l=>l.startsWith(' › /help'))})
  if(!before)for(let i=0;i<6;i++)await key('backspace')
  await ui.send('OLD_HISTORY');await key('enter');await ui.wait({text:'BASELINE_HISTORY_REPLY'});await ui.wait({text:'○ 空闲'})
  await ui.send('line1\nline2\nline3');await key('up');const multiline=await frame('200-多行上移');findings.push({rule:'多行Up不换整稿为历史',pass:multiline.text.includes('line1')&&multiline.text.includes('line2')&&multiline.text.includes('line3')})
  if(before)for(let i=0;i<11;i++)await key('backspace');else for(let i=0;i<11;i++)await key('backspace')
  // 回到正文并清掉测试草稿；Esc 在新版不负责删除。
  await key('ctrl+n');await key('esc')
  await key('down');await key('down');await key('ctrl+e');for(let i=0;i<40;i++)await key('backspace')
  await ui.send('APPROVAL_PROMPT');await key('enter');await ui.wait({text:before?'本工作区总是允许':'↑↓ 选择'})
  const db=new Database(join(ui.facts().dataDir,'records.db'),{readonly:true})
  await ui.send('y');await Bun.sleep(300);const approval=await frame('200-普通y与审批')
  const decisions=db.query("SELECT kind,data FROM events WHERE kind='tool.decision'").all()
  findings.push({rule:'普通y不裁决',pass:decisions.length===0,decisions,screen:approval.text})
  if(before)await ui.wait({text:'AFTER_APPROVAL'});else {await key('up');await key('enter');await ui.wait({text:'AFTER_APPROVAL'})}
  await ui.wait({text:'○ 空闲'})
  if(!before)await key('backspace')
  await ui.send('/grants ');await key('enter');await ui.wait({text:before?'回车＝撤销选定那条':'授权'})
  const original=await Bun.file(sandbox.grantsPath).text();await key('down');await key('up');await key('enter');await ui.wait({text:before?'已撤销':'授权详情'});const grants=await frame('200-授权Enter查看')
  const unchanged=original===await Bun.file(sandbox.grantsPath).text()
  findings.push({rule:'授权列表Enter查看不撤销',pass:unchanged,detailVisible:grants.text.includes('授权详情')})
  assert(findings.every(one=>one.pass===!before),JSON.stringify(findings))
  writeFileSync(`${ui.runDir}/u114-comparison-facts.json`,JSON.stringify({before,code:before?'eb611784e68e78ef7744ae597621442b712fabfd':'fix/u114-tui-interaction working tree',facts:ui.facts(),findings,requests:ui.requests()},null,2));db.close();console.log(ui.runDir)
 }finally{await ui.close({keepSandbox:true});await host.close();await fixture.stop()}
}
