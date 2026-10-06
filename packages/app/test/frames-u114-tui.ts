import {strict as assert} from 'node:assert'
import {writeFileSync} from 'node:fs'
import {createUiSession, REPO_ROOT } from './ui/driver.ts'

const ui=await createUiSession({columns:200,rows:40,label:'U114-初轮真实终端',artifacts:REPO_ROOT + '/.ui-runs/u114',turns:[{kind:'text',text:'FIXTURE_REPLY',chunks:1,chunkDelayMs:10}]})
try{
 await ui.capture({label:'200-空态'})
 await ui.send('/help ');await ui.key('enter');await ui.wait({text:'可用命令'});await ui.capture({label:'200-命令与帮助'})
 assert.equal(ui.requests().filter(r=>r.path.endsWith('/chat/completions')).length,0,'本地命令不请求模型')
 await ui.send(`left中emoji🙂é
second line
third line`);await ui.capture({label:'200-多行稿'})
 await ui.key('up');await ui.key('left');await ui.send('INSERT');await ui.capture({label:'200-多行原位编辑'})
 await ui.key('esc');await ui.capture({label:'200-Esc保留稿'})
 await ui.resize(100,40);await ui.wait({writtenFrame:100});await ui.capture({label:'100-同稿'})
 await ui.resize(200,40);await ui.wait({writtenFrame:200});await ui.capture({label:'200-同稿'})
 // 带控制字节的实际输入流，装置不替代产品解键。
 await ui.send('\x10');await ui.wait({text:'/help'});await ui.capture({label:'200-命令召回'})
 await ui.send('\x0e');await ui.capture({label:'200-归还原稿'})
 await ui.send('\x1b\r');await ui.wait({text:'本条输入用途'});await ui.capture({label:'200-用途选择'})
 await ui.key('down');await ui.key('enter');await ui.wait({text:'本条：下一件'});await ui.capture({label:'200-用途已选未发送'})
 assert.equal(ui.requests().filter(r=>r.path.endsWith('/chat/completions')).length,0)
 await ui.key('enter');await ui.wait({text:'FIXTURE_REPLY'});await ui.wait({text:'○ 空闲'});await ui.capture({label:'200-真实请求后'})
 const requests=ui.requests().filter(r=>r.path.endsWith('/chat/completions'))
 assert.equal(requests.length,1)
 assert(!JSON.stringify(requests[0]!.body).includes('/help '),'命令不进真实请求')
 writeFileSync(`${ui.runDir}/u114-request-facts.json`,JSON.stringify({facts:ui.facts(),requests},null,2))
 console.log(ui.runDir)
}finally{await ui.close({keepSandbox:true})}
