import { expect, test } from 'bun:test'
import { collaborationRuntime, latch, requestText, spawnMember } from './run-collaboration-fixture.ts'

test('U114 下一件等待真实委派结束，保留当前消费意图，结束事件后实际请求带入', async () => {
  const memberReply = latch()
  const f = await collaborationRuntime('u114-next-delegation', async call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : {text:'入口当前回合已完成'}
    if (call.index === 0) {
      await memberReply.promise
      return {tool:'agent_message',args:{action:'respond',operationId:'reject-remaining',delegation:f.delegation()!.delegationId,response:'reject',reason:'受控结束前项委派'}}
    }
    return {text:'成员委派已结束'}
  })
  try {
    f.shell.key({kind:'paste',text:'先分出受控前项'});f.shell.key({kind:'enter'})
    await f.wait('前项真实委派及根回合完成',()=>f.member()!==undefined&&f.manager.runs().find(run=>run.session===f.session())?.state==='idle'&&f.requests().length===2)
    f.shell.key({kind:'paste',text:'U114_NEXT_AFTER_DELEGATION'})
    f.shell.key({kind:'alt+enter'});f.pick('next');f.shell.key({kind:'enter'})
    await f.wait('下一件已可靠接收',()=>f.store.serviceFor(f.session()!).inputs.list().some(one=>one.input.text==='U114_NEXT_AFTER_DELEGATION'&&one.state==='pending'))
    await Bun.sleep(650)
    expect(f.requests().some(call=>requestText(call).includes('U114_NEXT_AFTER_DELEGATION'))).toBe(false)
    expect(f.manager.executors().some(one=>one.session===f.session())).toBe(true)
    memberReply.release()
    await f.wait('委派结束后下一件真正带入',()=>f.requests().some(call=>requestText(call).includes('U114_NEXT_AFTER_DELEGATION')))
    expect(f.delegation()?.state).toBe('rejected')
    await f.wait('下一件已带入回执',()=>f.store.serviceFor(f.session()!).inputs.list().some(one=>one.input.text==='U114_NEXT_AFTER_DELEGATION'&&one.state==='included'))
    expect(f.errors).toEqual([])
  } finally {memberReply.release();await f.close()}
},30000)

test('U114 真实 socket 延迟提交与未确认断线；重传同身份只消费一次', async () => {
  const f = await collaborationRuntime('u114-delayed-disconnect', () => ({ text: '真实请求已完成' }))
  const send = f.client.send.bind(f.client)
  const held: Parameters<typeof send>[0][] = []
  f.client.send = command => { if (command.type === 'input.submit') held.push(command); else send(command) }
  try {
    f.shell.key({kind:'paste',text:'U114_DELAYED_WIRE'});f.shell.key({kind:'enter'})
    await Bun.sleep(250)
    expect(f.calls).toHaveLength(0)
    expect(await f.store.listSessions()).toEqual([])
    expect(f.shell.getView().rows.some(row=>row.kind==='user'&&row.inputState==='提交中')).toBe(true)
    const command=held.shift()!
    send(command);send(command)
    await f.wait('真实请求与实际带入回执',()=>f.events.some(event=>event.kind==='input.settled'&&event.data.stage==='included'))
    expect(f.calls).toHaveLength(1)
    expect(f.store.serviceFor(f.session()!).inputs.list()).toHaveLength(1)
    expect(requestText(f.calls[0])).toContain('U114_DELAYED_WIRE')
    // 本次提交还未进入 wire；真实连接 EOF 后必须显示未确认，而不是伪造失败／受理。
    f.shell.key({kind:'paste',text:'U114_UNCONFIRMED_WIRE'});f.shell.key({kind:'enter'})
    f.client.close()
    await f.wait('真实连接关闭反馈',()=>f.shell.getView().draft==='U114_UNCONFIRMED_WIRE')
    expect([...f.shell.getView().settled,...f.shell.getView().rows].some(row=>row.kind==='user'&&row.inputState==='未确认接收（连接已断开）')).toBe(true)
    expect(f.store.serviceFor(f.session()!).inputs.list().map(row=>row.input.text)).toEqual(['U114_DELAYED_WIRE'])
  } finally {await f.close()}
},30000)

test('U114 入口已退代，仍有效成员卡按持卡者裁决，旧入口代次不吞答复', async () => {
 const { latch } = await import('./run-collaboration-fixture.ts')
 const { writeFileSync, statSync } = await import('node:fs')
 const { join } = await import('node:path')
 const rootReply=latch(), memberReply=latch()
 const f=await collaborationRuntime('u114-member-decision-old-origin',async call=>{
  if(call.model==='entry-model') {
   if(call.index===0)return spawnMember
   await rootReply.promise;return {text:'入口先完成，成员继续'}
  }
  if(call.index===0)return {tool:'agent_message',args:{action:'respond',operationId:'u114-accept',delegation:f.delegation()!.delegationId,response:'accept'}}
  if(call.index===1){await memberReply.promise;return {tool:'exec',args:{cmd:'chmod 700 approved.sh'}}}
  return {text:'成员审批实际执行完成'}
 })
 const path=join(f.workspace,'approved.sh');writeFileSync(path,'#!/bin/sh\n',{mode:0o600})
 const received:Record<string,any>[]=[];let buffer=''
 let socket:Awaited<ReturnType<typeof Bun.connect>>|undefined
 try {
  f.shell.key({kind:'paste',text:'派生成员并保留成员有效审批'});f.shell.key({kind:'enter'})
  await f.wait('入口已有代次且成员 HTTP 在途',()=>f.client.gen()!==null&&f.requests('member-model').length===2)
  const oldGen=f.client.gen()!
  rootReply.release()
  await f.wait('入口退代但成员仍在',()=>f.client.gen()===null&&!f.manager.executors().some(e=>e.session===f.session())&&f.member()!==undefined)
  socket=await Bun.connect({unix:f.manager.socketPath,socket:{data(_s,data){buffer+=data.toString();let end;while((end=buffer.indexOf('\n'))>=0){received.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1)}},close(){},error(_s,error){throw error}}})
  socket.write(JSON.stringify({t:'hello',role:'client',protocol:f.manager.identity.protocol,version:f.manager.identity.version,source:f.manager.identity.source,cwd:f.workspace,session:f.session(),label:'u114-stale-origin-wire'})+'\n')
  await f.wait('独立 socket 已确认所选工作',()=>received.some(m=>m.t==='welcome'))
  memberReply.release()
  await f.wait('成员有效卡到达',()=>f.events.some(e=>e.kind==='tool.decision.request'&&e.data.name==='exec'))
  const pending=f.events.find(e=>e.kind==='tool.decision.request'&&e.data.name==='exec')!
  socket.write(JSON.stringify({t:'cmd',gen:oldGen,cmd:{type:'decision.answer',id:pending.id,decision:'approve'}})+'\n')
  await f.wait('旧入口代次答复交给实际成员',()=>f.requests('member-model').length===3&&(statSync(path).mode&0o777)===0o700)
  if(pending.kind!=='tool.decision.request')throw new Error('缺少成员卡')
  const decisions=await Array.fromAsync(f.store.serviceFor(pending.session!).readEvents(pending.session!))
  expect(decisions.filter(e=>e.kind==='tool.decision'&&e.data.call===pending.data.call)).toHaveLength(1)
  expect(received.filter(m=>m.t==='line'&&String(m.text).includes('命令没生效'))).toEqual([])
  expect(f.manager.executors().some(e=>e.session===f.session())).toBe(false)
 } finally {socket?.end();rootReply.release();memberReply.release();await f.close()}
},30000)
