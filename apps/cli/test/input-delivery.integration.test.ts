import { expect, test } from 'bun:test'
import { collaborationRuntime, latch, requestText, spawnMember } from './run-collaboration-fixture.ts'

test('下一件等待真实委派结束，保留当前消费意图，结束事件后实际请求带入', async () => {
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
    // 目的位（下一件）经命令直接落账——外壳的 option+回车现在走「另一种提交方式」，不再弹选择器
    f.client.send({ type: 'input.submit', text: 'U114_NEXT_AFTER_DELEGATION', purpose: 'next' })
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

test('真实 socket 延迟提交与未确认断线；重传同身份只消费一次', async () => {
  const f = await collaborationRuntime('u114-delayed-disconnect', () => ({ text: '真实请求已完成' }))
  const send = f.client.send.bind(f.client)
  const held: Parameters<typeof send>[0][] = []
  f.client.send = command => { if (command.type === 'input.submit') held.push(command); else send(command) }
  try {
    f.shell.key({kind:'paste',text:'U114_DELAYED_WIRE'});f.shell.key({kind:'enter'})
    await Bun.sleep(250)
    expect(f.calls).toHaveLength(0)
    expect(await f.store.listSessions()).toEqual([])
    expect(f.shell.getView().queued.some(one=>one.text.includes('U114_DELAYED_WIRE'))).toBe(true)
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
    expect(f.shell.getView().queued.some(one=>one.text.includes('U114_UNCONFIRMED_WIRE')&&one.ack!==true)).toBe(false)
    expect(f.store.serviceFor(f.session()!).inputs.list().map(row=>row.input.text)).toEqual(['U114_DELAYED_WIRE'])
  } finally {await f.close()}
},30000)


test('与咨询集成：真实 socket 的待处理操作不越过只读顾问边界', async()=>{
 const pending=latch()
 const f=await collaborationRuntime('u114-consultation-pending-readonly',async call=>{
  if(call.model==='entry-model')return call.index===0?{tool:'consult_arcane',args:{operationId:'readonly-input',question:'只读查证'}}:{text:'原工作保持责任'}
  await pending.promise;return {text:'只读建议'}
 })
 try{
  f.shell.key({kind:'paste',text:'请只读顾问查证'});f.shell.key({kind:'enter'})
  await f.wait('顾问在途',()=>f.requests('descendant-model').length===1 && f.requests().length===2)
  const member=f.member()!,inputs=f.store.serviceFor(member.sessionId).inputs
  const row=inputs.accept({ref:'readonly-pending',text:'顾问不可消费的受控待处理夹具',purpose:'next'},Date.now())
  f.client.send({type:'input.manage',action:'list',member:member.agentId})
  await f.wait('只读列举已回传',()=>f.events.some(event=>event.kind==='input.pending'&&event.session===member.sessionId&&event.data.inputs.some(one=>one.ref===row.ref)))
  for(const action of ['edit','withdraw','continue'] as const){
   const before=f.lines.filter(line=>line.includes('咨询详情只供查看')).length
   f.client.send({type:'input.manage',member:member.agentId,ref:row.ref,revision:row.revision,...(action==='edit'?{action,input:{text:'不应保存'}}:{action})})
   await f.wait(action+'明确拒绝',()=>f.lines.filter(line=>line.includes('咨询详情只供查看')).length>before)
   expect(inputs.get(row.ref)).toEqual(row)
   expect(f.requests()).toHaveLength(2)
  }
  expect(f.errors).toEqual([])
 }finally{pending.release();await f.close()}
},20000)
