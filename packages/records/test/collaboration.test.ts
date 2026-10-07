import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Entry, AgentMessagePayload } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { body, fixture, model } from './collaboration-fixture.ts'

async function entries(store: ReturnType<typeof createRecordsStore>, session: string): Promise<Entry[]> {
  return Array.fromAsync(store.readEntries(session))
}

describe('协作记录 · 工作区来源不改写', () => {
  test('NULL 标题壳可登记入口身份；注册与重试均不补绑 sessions.workspace', () => {
    const f = fixture()
    const db = new Database(f.store.paths.database, { readonly: true })
    const other = createRecordsStore({ dataDir: f.dir, workspace: ['/another'] })
    try {
      f.store.setSessionTitle('title-only', '已有普通会话', 20)
      const session = () => db.query<{ workspace: string | null; title: string; at: number }, [string]>(
        'SELECT workspace,title,at FROM sessions WHERE id=?',
      ).get('title-only')
      expect(session()).toEqual({ workspace: null, title: '已有普通会话', at: 20 })
      const input = { operationId: 'title-identity', sessionId: 'title-only', name: '入口', role: '', model, at: 21 }
      const agent = f.records.registerAgent(input)
      expect(agent.workspace).toEqual(['/original'])
      expect(agent.collaborationId).toBeUndefined()
      expect(session()).toEqual({ workspace: null, title: '已有普通会话', at: 20 })
      expect(other.collaboration.registerAgent(input)).toEqual(agent)
      expect(other.collaboration.registerAgent({ ...input, operationId: 'title-identity-again' })).toEqual(agent)
      expect(session()?.workspace).toBeNull()
      expect(db.query<{ count: number }, [string]>('SELECT count(*) AS count FROM collaboration_agents WHERE session=?').get('title-only')?.count).toBe(1)
    } finally { other.close(); db.close(); f.close() }
  })

  test('已知多根从不同构造根首次登记，身份仍完整继承持久根与声明顺序', () => {
    const f = fixture()
    const roots = ['/second-declared', '/first-declared']
    const original = createRecordsStore({ dataDir: f.dir, workspace: roots })
    const db = new Database(f.store.paths.database, { readonly: true })
    try {
      original.serviceFor('known-roots').appendEntry({ kind: 'user', content: { text: '已知归属' }, at: 20 })
      const agent = f.records.registerAgent({ operationId: 'known-identity', sessionId: 'known-roots', name: '入口', role: '', model, at: 21 })
      expect(agent.workspace).toEqual(roots)
      expect(db.query<{ workspace: string }, [string]>('SELECT workspace FROM sessions WHERE id=?').get('known-roots')?.workspace).toBe(JSON.stringify(roots))
      expect(original.collaboration.agentForSession('known-roots')).toEqual(agent)
    } finally { db.close(); original.close(); f.close() }
  })

  for (const targetRoots of [null, ['/different'], ['/second', '/first'], ['/first', '/second']]) {
    test(`spawn 拒绝既存 session（${targetRoots === null ? 'NULL' : targetRoots.join(',')}），无身份/委派/操作半残`, () => {
      const f = fixture()
      const roots = ['/first', '/second']
      const original = createRecordsStore({ dataDir: f.dir, workspace: roots })
      const target = createRecordsStore({ dataDir: f.dir, workspace: targetRoots ?? roots })
      const db = new Database(f.store.paths.database, { readonly: true })
      try {
        const source = { sessionId: 'multi-root', entryId: original.serviceFor('multi-root').appendEntry({
          kind: 'user', content: { text: '独立工作' }, at: 20,
        }) }
        const actor = f.records.registerAgent({ operationId: 'multi-identity', sessionId: source.sessionId, name: '入口', role: '', model, at: 21 })
        const collaboration = f.records.openCollaboration(actor.agentId, { operationId: 'multi-open', origin: source, at: 22 })
        if (targetRoots === null) target.setSessionTitle('existing-target', '只有标题', 23)
        else target.serviceFor('existing-target').appendEntry({ kind: 'user', content: { text: '不能接管' }, at: 23 })
        const counts = () => [
          db.query<{ count: number }, []>('SELECT count(*) AS count FROM collaboration_agents').get()?.count,
          db.query<{ count: number }, []>('SELECT count(*) AS count FROM collaboration_delegations').get()?.count,
          db.query<{ count: number }, []>('SELECT count(*) AS count FROM collaboration_operations').get()?.count,
          db.query<{ count: number }, []>('SELECT count(*) AS count FROM collaboration_messages').get()?.count,
        ]
        const before = counts()
        const input = { operationId: 'spawn-existing', sessionId: 'existing-target', name: '成员', role: '', model,
          body: body('请处理'), scope: '独立部分', source, authorization: [source], at: 24 }
        expect(() => f.records.spawn(actor.agentId, input)).toThrow('spawn requires a new member session')
        expect(counts()).toEqual(before)
        expect(f.records.agentForSession(input.sessionId)).toBeUndefined()
        expect(f.records.listMembers(collaboration.collaborationId).map(a => a.agentId)).toEqual([actor.agentId])
        expect(f.records.listDelegations(collaboration.collaborationId)).toEqual([])
        expect(f.records.operation(input.operationId)).toBeUndefined()
        expect(db.query<{ workspace: string | null }, [string]>('SELECT workspace FROM sessions WHERE id=?').get(input.sessionId)?.workspace)
          .toBe(targetRoots === null ? null : JSON.stringify(targetRoots))
        const fresh = f.records.spawn(actor.agentId, { ...input, sessionId: 'fresh-target' })
        expect(fresh.agent.workspace).toEqual(roots)
        expect(db.query<{ workspace: string }, [string]>('SELECT workspace FROM sessions WHERE id=?').get('fresh-target')?.workspace).toBe(JSON.stringify(roots))
      } finally { db.close(); target.close(); original.close(); f.close() }
    })
  }
})

describe('协作记录 · 身份与来源', () => {
  test('单会话身份、操作去重、工作区继承、模型默认独立、重开保持身份', () => {
    const f = fixture()
    try {
      expect(f.records.registerAgent({ operationId: 'same-session', sessionId: 'origin', name: 'new', role: '', model, at: 5 }).agentId).toBe(f.coordinator.agentId)
      const a = f.spawn('a')
      expect(a.agent.workspace).toEqual(['/original'])
      expect(a.agent.responsibility).toBe('implement a')
      const retried = f.records.spawn(f.coordinator.agentId, { operationId: 'spawn-1', sessionId: 'uncreated', name: 'ignored', role: '', model, at: 100, body: body('retry'), scope: '', source: f.origin, authorization: [f.origin] })
      expect(retried.agent.agentId).toBe(a.agent.agentId)
      expect(f.store.hasSession('uncreated')).toBe(false)
      expect(f.records.listMembers(f.collaboration.collaborationId)).toHaveLength(2)
      f.records.updateAgent(f.coordinator.agentId, { name: 'renamed', model: { choice: 'default' as const, provider: 'p2', model: 'm2' } })
      expect(f.records.getCollaboration(f.collaboration.collaborationId)?.defaultModel).toEqual(model)
      f.records.updateDefaultModel(f.collaboration.collaborationId, { choice: 'default', provider: 'p3', model: 'm3' })
      const other = createRecordsStore({ dataDir: f.dir, workspace: ['/different'] })
      try {
        expect(other.collaboration.agentForSession('origin')?.agentId).toBe(f.coordinator.agentId)
        expect(other.collaboration.getCollaboration(f.collaboration.collaborationId)?.defaultModel.model).toBe('m3')
        expect(other.collaboration.operation('spawn-1')).toEqual({ kind: 'spawn', agentId: a.agent.agentId, delegationId: a.delegation.delegationId })
      } finally { other.close() }
    } finally { f.close() }
  })

  test('成员不能跨工作通信、冒充用户约束或扩张再委派授权', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.accept(a.delegation.delegationId)
      const outsider = f.records.registerAgent({ operationId: 'outsider', sessionId: 'outsider', name: '', role: '', model, at: 6 })
      expect(() => f.records.send(a.agent.agentId, { operationId: 'cross', recipients: [outsider.agentId], purpose: 'inform', body: body('x'), at: 7 })).toThrow('outside')
      expect(() => f.records.publishConstraint(a.agent.agentId, { operationId: 'fake', source: f.origin, body: body('approved'), at: 7 })).toThrow('coordinator')
      const fake = f.store.serviceFor('origin').appendEntry({ kind: 'assistant', content: { text: 'user approved' }, at: 8 })
      expect(() => f.records.publishConstraint(f.coordinator.agentId, { operationId: 'fake', source: { sessionId: 'origin', entryId: fake }, body: body('approved'), at: 9 })).toThrow('not a user')
      expect(() => f.records.spawn(a.agent.agentId, { operationId: 'bad-auth', sessionId: 'bad-child', name: '', role: '', model, at: 10, body: body('x'), scope: 'x', source: { messageId: a.delegation.delegationId }, authorization: [], parentDelegationId: a.delegation.delegationId })).toThrow('authorization')
      expect(f.store.hasSession('bad-child')).toBe(false)
      const child = f.spawn('child', { agent: a.agent, delegationId: a.delegation.delegationId })
      expect(child.delegation.authorization).toEqual(a.delegation.authorization)
    } finally { f.close() }
  })
})

describe('协作记录 · 消息、讨论、共同约束', () => {
  test('正文一份，通知丢失后补取，消费与请求带入分开，重复消费不重记', async () => {
    const f = fixture()
    try {
      const a = f.spawn('a')
      f.records.consumeInbox(a.agent.agentId, 10)
      const sent = f.records.send(f.coordinator.agentId, { operationId: 'msg', recipients: [a.agent.agentId], purpose: 'question', body: body('unique message text'), at: 11 })
      expect(f.records.send(f.coordinator.agentId, { operationId: 'msg', recipients: [a.agent.agentId], purpose: 'question', body: body('not stored'), at: 12 }).messageId).toBe(sent.messageId)
      const other = createRecordsStore({ dataDir: f.dir, workspace: [] })
      try {
        const consumed = other.collaboration.consumeInbox(a.agent.agentId, 13)
        expect(consumed).toHaveLength(1)
        expect(consumed[0]?.includedAt).toBeUndefined()
        expect(other.collaboration.consumeInbox(a.agent.agentId, 14)).toEqual([])
        other.collaboration.markIncluded(a.agent.agentId, [sent.messageId], 15)
        expect(other.collaboration.inbox(a.agent.agentId).at(-1)?.includedAt).toBe(15)
        const received = (await entries(other, 'a')).filter(e => e.kind === 'agent-message')
        expect(received).toHaveLength(2)
        expect(received.at(-1)?.source).toBe('origin')
        expect(received.at(-1)?.content).toEqual({ text: '' })
        expect((received.at(-1)?.payload as AgentMessagePayload).messageId).toBe(sent.messageId)
        expect(other.collaboration.readMessage(a.agent.agentId, sent.messageId)?.body).toEqual(body('unique message text'))
        const db = new Database(f.store.paths.database, { readonly: true })
        try {
          expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM entries WHERE content_text LIKE '%unique message text%' OR payload LIKE '%unique message text%'").get()?.count).toBe(0)
          expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM collaboration_messages WHERE data LIKE '%unique message text%'").get()?.count).toBe(1)
        } finally { db.close() }
      } finally { other.close() }
    } finally { f.close() }
  })

  test('持久序号独立于跨发送方消息 id；已消费消息不可编辑或撤回', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.records.consumeInbox(a.agent.agentId, 10)
      const m1 = f.records.send(f.coordinator.agentId, { operationId: 'm1', recipients: [a.agent.agentId], purpose: 'inform', body: body('first'), at: 11 })
      const m2 = f.records.send(f.coordinator.agentId, { operationId: 'm2', recipients: [a.agent.agentId], purpose: 'inform', body: body('second'), at: 12 })
      // 将两个合法引用按相反 id 入队，模拟不同发送方先取号后提交。
      const db = new Database(f.store.paths.database)
      try { db.run('UPDATE collaboration_inbox SET message=CASE message WHEN ? THEN ? ELSE ? END WHERE recipient=? AND message IN (?,?)', [m1.messageId, -1, m1.messageId, a.agent.agentId, m1.messageId, m2.messageId]); db.run('UPDATE collaboration_inbox SET message=? WHERE message=-1', [m2.messageId]) } finally { db.close() }
      const first = f.records.consumeInbox(a.agent.agentId, 13, 1)[0]!
      expect(first.messageId).toBe(m2.messageId)
      expect(f.records.inbox(a.agent.agentId, first.position).map(i => i.messageId)).toEqual([m1.messageId])
      expect(f.records.editMessage(f.coordinator.agentId, m2.messageId, body('changed'))).toBe(false)
      expect(f.records.withdrawMessage(f.coordinator.agentId, m2.messageId)).toBe(false)
      expect(f.records.editMessage(f.coordinator.agentId, m1.messageId, body('changed'))).toBe(true)
      expect(f.records.withdrawMessage(f.coordinator.agentId, m1.messageId)).toBe(true)
      expect(f.records.consumeInbox(a.agent.agentId, 14)).toEqual([])
    } finally { f.close() }
  })

  test('局部讨论仅实际参与人可读；有效共同约束覆盖晚加入者并区分带入', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); const b = f.spawn('b')
      const root = f.records.send(f.coordinator.agentId, { operationId: 'discussion', recipients: [a.agent.agentId], purpose: 'question', body: body('design?'), at: 20, startDiscussion: true })
      f.records.send(a.agent.agentId, { operationId: 'answer', recipients: [f.coordinator.agentId], purpose: 'decision', body: body('reason'), at: 21, replyTo: root.messageId, discussionRoot: root.messageId })
      expect(f.records.listDiscussion(a.agent.agentId, root.messageId)).toHaveLength(2)
      expect(f.records.listDiscussion(b.agent.agentId, root.messageId)).toEqual([])
      const constraint = f.records.publishConstraint(f.coordinator.agentId, { operationId: 'constraint', source: f.origin, body: body('public interfaces unchanged'), at: 22 })
      const c = f.spawn('c')
      expect(f.records.readMessage(c.agent.agentId, constraint.messageId)?.recipients).not.toContain(c.agent.agentId)
      expect(f.records.inbox(c.agent.agentId).some(i => i.messageId === constraint.messageId)).toBe(true)
      f.records.consumeInbox(a.agent.agentId, 23)
      expect(f.records.constraintStatus(constraint.messageId).find(s => s.agentId === a.agent.agentId)?.state).toBe('consumed')
      f.records.markIncluded(a.agent.agentId, [constraint.messageId], 24)
      expect(f.records.constraintStatus(constraint.messageId).find(s => s.agentId === a.agent.agentId)?.state).toBe('included')
      expect(f.records.constraintStatus(constraint.messageId).find(s => s.agentId === c.agent.agentId)?.state).toBe('pending')
    } finally { f.close() }
  })
})

describe('协作记录 · 委派责任与等待', () => {
  test('接受前不执行；一次接受一个；澄清、拒绝、交付和核验分别落账', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); const id = a.delegation.delegationId
      expect(f.records.checkAdmission(a.agent.agentId, id).allowed).toBe(false)
      expect(f.records.respondToDelegation(a.agent.agentId, { operationId: 'clarify', delegationId: id, response: 'clarify', reason: 'need API', at: 11 }).delegation.state).toBe('clarification')
      expect(f.accept(id).accepted).toBe(true)
      expect(f.records.checkAdmission(a.agent.agentId, id).allowed).toBe(true)
      const second = f.records.delegate(f.coordinator.agentId, { operationId: 'second', assigneeId: a.agent.agentId, scope: 'second', body: body('second'), source: f.origin, authorization: [f.origin], at: 12 })
      expect(f.accept(second.delegationId).accepted).toBe(false)
      expect(f.records.getDelegation(second.delegationId)?.state).toBe('queued')
      f.records.beginExecution(a.agent.agentId, { operationId: 'model', delegationId: id, runId: 'run-a', kind: 'model', at: 13 })
      expect(() => f.records.beginExecution(a.agent.agentId, { operationId: 'duplicate-run', delegationId: id, runId: 'run-b', kind: 'model', at: 13 })).toThrow('executor')
      const delivery = f.records.deliver(a.agent.agentId, { operationId: 'delivery', delegationId: id, body: body('result'), at: 14 })
      expect(f.records.getDelegation(id)?.state).toBe('delivered')
      expect(f.accept(second.delegationId).accepted).toBe(false)
      f.records.finishExecution('model')
      expect(f.records.readMessage(f.coordinator.agentId, delivery.messageId)?.delegationId).toBe(id)
      expect(() => f.records.receiveDelivery(a.agent.agentId, id, 15)).toThrow('delegator')
      expect(f.records.receiveDelivery(f.coordinator.agentId, id, 15).receivedAt).toBe(15)
      expect(f.records.respondToDelegation(a.agent.agentId, { operationId: 'reject-second', delegationId: second.delegationId, response: 'reject', reason: 'not suitable', at: 16 }).delegation.state).toBe('rejected')
      expect(f.records.closeCollaboration(f.collaboration.collaborationId, 17)).toEqual({ closed: true, blockers: [] })
      expect(f.records.getAgent(a.agent.agentId)?.reachability).toBe('historical')
    } finally { f.close() }
  })

  test('等待循环给具体链；先到结果可读；回执不解除等待；期限只产生一次事实', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); const b = f.spawn('b'); f.accept(a.delegation.delegationId); f.accept(b.delegation.delegationId)
      const ask = f.records.send(a.agent.agentId, { operationId: 'ask', recipients: [b.agent.agentId], purpose: 'question', body: body('API?'), at: 20 })
      const waiting = f.records.registerWait(a.agent.agentId, { operationId: 'wait-a', forAgents: [b.agent.agentId], forMessageId: ask.messageId, delegationId: a.delegation.delegationId, expectation: 'API', deadline: 100, at: 21 })
      expect(waiting.ok).toBe(true)
      const cycle = f.records.registerWait(b.agent.agentId, { operationId: 'wait-b', forAgents: [a.agent.agentId], delegationId: b.delegation.delegationId, expectation: 'API', deadline: 100, at: 22 })
      expect(cycle).toEqual({ ok: false, cycle: [b.agent.agentId, a.agent.agentId, b.agent.agentId] })
      f.records.send(b.agent.agentId, { operationId: 'receipt', recipients: [a.agent.agentId], purpose: 'receipt', body: body('seen'), replyTo: ask.messageId, at: 23 })
      expect(f.records.listWaits(f.collaboration.collaborationId)[0]?.state).toBe('waiting')
      const reply = f.records.send(b.agent.agentId, { operationId: 'reply', recipients: [a.agent.agentId], purpose: 'reply', body: body('API ready'), replyTo: ask.messageId, at: 24 })
      expect(f.records.listWaits(f.collaboration.collaborationId)[0]?.resultMessageId).toBe(reply.messageId)
      const already = f.records.registerWait(a.agent.agentId, { operationId: 'already', forAgents: [b.agent.agentId], forMessageId: ask.messageId, delegationId: a.delegation.delegationId, expectation: 'API', deadline: 100, at: 25 })
      expect(already.ok && already.wait.state).toBe('resolved')
      const timeout = f.records.registerWait(b.agent.agentId, { operationId: 'timeout', forAgents: [f.coordinator.agentId], delegationId: b.delegation.delegationId, expectation: 'decision', deadline: 50, at: 26 })
      expect(timeout.ok).toBe(true)
      expect(f.records.expireWaits(49)).toEqual([])
      expect(f.records.expireWaits(50).map(w => w.reason)).toEqual(['deadline reached'])
      expect(f.records.expireWaits(51)).toEqual([])
      f.records.registerWait(b.agent.agentId, { operationId: 'exit-wait', forAgents: [a.agent.agentId], delegationId: b.delegation.delegationId, expectation: 'more', deadline: 100, at: 52 })
      f.records.setReachability(a.agent.agentId, 'historical')
      expect(f.records.listWaits(f.collaboration.collaborationId).at(-1)?.reason).toBe('agent became historical')
    } finally { f.close() }
  })

  test('按委派来源闭包停止；其他排队责任保留；迟到结果保存但不可复活', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.accept(a.delegation.delegationId)
      const child = f.spawn('child', { agent: a.agent, delegationId: a.delegation.delegationId }); f.accept(child.delegation.delegationId)
      const unrelated = f.spawn('unrelated'); f.accept(unrelated.delegation.delegationId)
      const queued = f.records.delegate(f.coordinator.agentId, { operationId: 'queue', assigneeId: a.agent.agentId, body: body('other'), scope: 'other', source: f.origin, authorization: [f.origin], at: 20 })
      f.records.beginExecution(a.agent.agentId, { operationId: 'tool-a', delegationId: a.delegation.delegationId, runId: 'a', kind: 'tool', at: 21 })
      f.records.beginExecution(child.agent.agentId, { operationId: 'tool-child', delegationId: child.delegation.delegationId, runId: 'child', kind: 'tool', at: 21 })
      const stop = f.records.stop({ kind: 'delegation', delegationId: a.delegation.delegationId }, 'withdrawn', 22)
      expect([...stop.delegations].sort()).toEqual([a.delegation.delegationId, child.delegation.delegationId].sort())
      expect(stop.executions).toHaveLength(2)
      expect(f.records.getDelegation(queued.delegationId)?.state).toBe('queued')
      expect(f.records.checkAdmission(unrelated.agent.agentId, unrelated.delegation.delegationId).allowed).toBe(true)
      expect(() => f.accept(queued.delegationId)).toThrow('cancellation')
      const late = f.records.deliver(a.agent.agentId, { operationId: 'late', delegationId: a.delegation.delegationId, body: body('late result'), at: 23 })
      expect(f.records.getDelegation(a.delegation.delegationId)?.state).toBe('cancelled')
      expect(f.records.checkAdmission(a.agent.agentId, a.delegation.delegationId).allowed).toBe(false)
      expect(f.records.readMessage(f.coordinator.agentId, late.messageId)).toBeDefined()
      expect(f.records.receiveDelivery(f.coordinator.agentId, a.delegation.delegationId, 24).state).toBe('cancelled')
      f.records.finishExecution('tool-a'); f.records.finishExecution('tool-child')
      expect(f.accept(queued.delegationId).accepted).toBe(true)
    } finally { f.close() }
  })

  test('宿主停止跨连接持久；重开仅查询；明确继续按范围开放，不重放旧执行', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.accept(a.delegation.delegationId)
      f.records.beginExecution(a.agent.agentId, { operationId: 'exec', delegationId: a.delegation.delegationId, runId: 'a', kind: 'model', at: 15 })
      f.records.stop({ kind: 'host' }, 'App exit', 20)
      const reopened = createRecordsStore({ dataDir: f.dir, workspace: [] })
      try {
        const r = reopened.collaboration
        expect(r.checkAdmission(f.coordinator.agentId).allowed).toBe(false)
        expect(() => f.spawn('forbidden')).toThrow('host')
        expect(r.beginExecution(a.agent.agentId, { operationId: 'exec', delegationId: a.delegation.delegationId, runId: 'a', kind: 'model', at: 21 }).state).toBe('cancel-requested')
        r.resume({ kind: 'host' }, 22)
        expect(r.checkAdmission(f.coordinator.agentId).allowed).toBe(false)
        expect(() => r.resume({ kind: 'collaboration', collaborationId: f.collaboration.collaborationId }, 23)).toThrow('unsettled')
        r.finishExecution('exec', 'unknown effect retained')
        r.resume({ kind: 'collaboration', collaborationId: f.collaboration.collaborationId }, 24)
        expect(r.checkAdmission(f.coordinator.agentId).allowed).toBe(true)
        expect(r.checkAdmission(a.agent.agentId, a.delegation.delegationId).allowed).toBe(false)
        r.resume({ kind: 'delegation', delegationId: a.delegation.delegationId }, 25)
        expect(r.getDelegation(a.delegation.delegationId)?.state).toBe('queued')
        expect(r.listExecutions(f.collaboration.collaborationId)[0]?.state).toBe('finished')
      } finally { reopened.close() }
    } finally { f.close() }
  })

  test('整体收尾先关派生，未收下结果与在途执行明确阻塞收尾', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.accept(a.delegation.delegationId)
      const id = f.collaboration.collaborationId
      f.records.beginClosing(id, 15)
      expect(() => f.spawn('no-new-work')).toThrow('closed')
      expect(f.records.checkAdmission(a.agent.agentId, a.delegation.delegationId).allowed).toBe(true)
      f.records.beginExecution(a.agent.agentId, { operationId: 'inflight', delegationId: a.delegation.delegationId, runId: 'a', kind: 'tool', at: 16 })
      f.records.deliver(a.agent.agentId, { operationId: 'delivery', delegationId: a.delegation.delegationId, body: body('done'), at: 17 })
      expect(f.records.closeCollaboration(id, 18).blockers).toHaveLength(2)
      f.records.receiveDelivery(f.coordinator.agentId, a.delegation.delegationId, 19)
      expect(f.records.closeCollaboration(id, 20).blockers).toHaveLength(1)
      f.records.finishExecution('inflight')
      expect(f.records.closeCollaboration(id, 21).closed).toBe(true)
    } finally { f.close() }
  })
})

describe('协作记录 · 宿主接缝', () => {
  test('coordination 只开放接受判断；work 仍要求已接受绑定，接受动作本身可在判断实例内完成', () => {
    const f = fixture()
    try {
      const a = f.spawn('a')
      expect(f.records.checkAdmission(a.agent.agentId).allowed).toBe(false)
      expect(f.records.checkAdmission(a.agent.agentId, undefined, 'coordination').allowed).toBe(true)
      f.records.beginExecution(a.agent.agentId, { operationId: 'judge', runId: 'judge', kind: 'tool', mode: 'coordination', at: 15 })
      expect(() => f.records.beginExecution(a.agent.agentId, { operationId: 'work', runId: 'judge', kind: 'tool', at: 16 })).toThrow('binding')
      expect(f.accept(a.delegation.delegationId).accepted).toBe(true)
      expect(f.records.checkAdmission(a.agent.agentId, a.delegation.delegationId).allowed).toBe(true)
      f.records.stop({ kind: 'host' }, 'stop', 17)
      expect(f.records.checkAdmission(a.agent.agentId, undefined, 'coordination').allowed).toBe(false)
      expect(() => f.records.beginExecution(a.agent.agentId, { operationId: 'after-stop-coordination', runId: 'judge', kind: 'model', mode: 'coordination', at: 18 })).toThrow('closed')
    } finally { f.close() }
  })

  test('跨连接追加协作引用后，普通条目和事件取号继续向前，不倒退到旧窗口', async () => {
    const f = fixture()
    try {
      const a = f.spawn('a')
      const own = f.store.serviceFor('a')
      const first = own.appendEntry({ kind: 'assistant', content: { text: 'start' }, at: 10 })
      const remote = createRecordsStore({ dataDir: f.dir, workspace: [] })
      try { remote.collaboration.consumeInbox(a.agent.agentId, 11) } finally { remote.close() }
      const consumed = f.records.inbox(a.agent.agentId)[0]!.entryId!
      const last = own.appendEntry({ kind: 'assistant', content: { text: 'after communication' }, at: 12 })
      expect(first).toBeLessThan(consumed)
      expect(consumed).toBeLessThan(last)
      expect(own.nextId()).toBeGreaterThan(last)
      expect((await entries(f.store, 'a')).map(e => e.id)).toEqual([first, consumed, last])
    } finally { f.close() }
  })

  test('等待终态独立回报，不伪造发送者；领取后跨重开不重复；旧停点不复活', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.accept(a.delegation.delegationId)
      f.records.registerWait(a.agent.agentId, { operationId: 'expired', forAgents: [f.coordinator.agentId], delegationId: a.delegation.delegationId, expectation: 'answer', deadline: 20, at: 15 })
      const before = f.records.inbox(a.agent.agentId).length
      f.records.expireWaits(20)
      expect(f.records.inbox(a.agent.agentId)).toHaveLength(before)
      expect(f.records.consumeWaitOutcomes(a.agent.agentId, 21)[0]?.reason).toBe('deadline reached')
      const reopened = createRecordsStore({ dataDir: f.dir, workspace: [] })
      try { expect(reopened.collaboration.consumeWaitOutcomes(a.agent.agentId, 22)).toEqual([]) } finally { reopened.close() }
      f.records.registerWait(a.agent.agentId, { operationId: 'interrupted', forAgents: [f.coordinator.agentId], delegationId: a.delegation.delegationId, expectation: 'answer', deadline: 50, at: 23 })
      f.records.stop({ kind: 'host' }, 'host stopped', 24)
      expect(f.records.consumeWaitOutcomes(a.agent.agentId, 25)[0]?.state).toBe('interrupted')
      expect(f.records.checkAdmission(a.agent.agentId, undefined, 'coordination').allowed).toBe(false)
      expect(f.records.expireWaits(99)).toEqual([])
    } finally { f.close() }
  })
})

test('讨论邀请授权回查但不伪造原收件；发送给自己仅一条引用；普通条目口不能伪造协作来源', async () => {
  const f = fixture()
  try {
    const a = f.spawn('a'); const b = f.spawn('b')
    const root = f.records.send(f.coordinator.agentId, { operationId: 'topic', recipients: [a.agent.agentId], purpose: 'question', body: body('topic'), startDiscussion: true, at: 11 })
    expect(f.records.readMessage(b.agent.agentId, root.messageId)).toBeUndefined()
    f.records.send(a.agent.agentId, { operationId: 'invite', recipients: [b.agent.agentId], purpose: 'question', body: body('join this topic'), discussionRoot: root.messageId, at: 12 })
    expect(f.records.listDiscussion(b.agent.agentId, root.messageId)).toHaveLength(2)
    expect(f.records.readMessage(b.agent.agentId, root.messageId)?.recipients).toEqual([a.agent.agentId])
    expect(f.records.inbox(b.agent.agentId).some(i => i.messageId === root.messageId)).toBe(false)
    const self = f.records.send(f.coordinator.agentId, { operationId: 'self', recipients: [f.coordinator.agentId], purpose: 'inform', body: body('self'), at: 13 })
    f.records.consumeInbox(f.coordinator.agentId, 14)
    expect((await entries(f.store, 'origin')).filter(e => e.payload && 'messageId' in e.payload && e.payload.messageId === self.messageId)).toHaveLength(1)
    expect(() => f.store.serviceFor('origin').appendEntry({ kind: 'agent-message', content: { text: '' }, payload: { messageId: root.messageId, collaborationId: f.collaboration.collaborationId, senderId: b.agent.agentId }, source: 'b', at: 15 })).toThrow('send/consume')
  } finally { f.close() }
})

test('显式继续保留运行停止墓碑，旧 run 不可用新操作 id 重启；局部停止涵盖接受判断', () => {
  const f = fixture()
  try {
    const a = f.spawn('a')
    f.records.beginExecution(a.agent.agentId, { operationId: 'bootstrap', runId: 'old-run', kind: 'model', mode: 'coordination', at: 11 })
    expect(f.records.stop({ kind: 'delegation', delegationId: a.delegation.delegationId }, 'stop bootstrap', 12).executions).toHaveLength(1)
    f.records.finishExecution('bootstrap')
    f.records.resume({ kind: 'delegation', delegationId: a.delegation.delegationId }, 13)
    expect(() => f.records.beginExecution(a.agent.agentId, { operationId: 'stale-command', runId: 'old-run', kind: 'model', mode: 'coordination', at: 14 })).toThrow('cancelled')
    expect(f.records.beginExecution(a.agent.agentId, { operationId: 'new-command', runId: 'new-run', kind: 'model', mode: 'coordination', at: 15 }).state).toBe('running')
  } finally { f.close() }
})

test('追加引用失败时消费位置一起回滚，失败受理无孤儿成员、操作或半条收件', () => {
  const f = fixture()
  try {
    const a = f.spawn('a')
    const db = new Database(f.store.paths.database)
    try {
      db.exec("CREATE TRIGGER fail_inbox_entry BEFORE INSERT ON entries WHEN NEW.kind='agent-message' AND NEW.session='a' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
      expect(() => f.records.consumeInbox(a.agent.agentId, 10)).toThrow('injected write failure')
      expect(f.records.inbox(a.agent.agentId)[0]?.state).toBe('pending')
      expect(f.records.inbox(a.agent.agentId)[0]?.entryId).toBeUndefined()
      db.exec('DROP TRIGGER fail_inbox_entry')
      expect(f.records.consumeInbox(a.agent.agentId, 11)).toHaveLength(1)
      expect(() => f.records.send(f.coordinator.agentId, { operationId: 'invalid-recipient', recipients: [a.agent.agentId, 'missing'], purpose: 'inform', body: body('not accepted'), at: 12 })).toThrow('not found')
      expect(f.records.operation('invalid-recipient')).toBeUndefined()
      expect(f.records.inbox(a.agent.agentId)).toHaveLength(1)
    } finally { db.close() }
  } finally { f.close() }
})

test('明确重新启用的成员补取当前共同约束，不修改原消息发送时收件集合', () => {
  const f = fixture()
  try {
    const a = f.spawn('a')
    f.records.setReachability(a.agent.agentId, 'historical')
    const constraint = f.records.publishConstraint(f.coordinator.agentId, { operationId: 'changed-while-away', source: f.origin, body: body('current constraint'), at: 12 })
    expect(constraint.recipients).not.toContain(a.agent.agentId)
    f.records.setReachability(a.agent.agentId, 'active')
    expect(f.records.inbox(a.agent.agentId).some(i => i.messageId === constraint.messageId)).toBe(true)
    expect(f.records.readMessage(a.agent.agentId, constraint.messageId)?.recipients).not.toContain(a.agent.agentId)
  } finally { f.close() }
})

test('listMessages 返回授权可见的发出、收件与关联讨论，不漏半场也不泄露无关会话', () => {
  const f = fixture()
  try {
    const a = f.spawn('a'); const b = f.spawn('b'); const c = f.spawn('c')
    const ask = f.records.send(f.coordinator.agentId, { operationId: 'list-ask', recipients: [a.agent.agentId], purpose: 'question', body: body('ask'), startDiscussion: true, at: 11 })
    const reply = f.records.send(a.agent.agentId, { operationId: 'list-reply', recipients: [f.coordinator.agentId], purpose: 'reply', body: body('answer'), replyTo: ask.messageId, discussionRoot: ask.messageId, at: 12 })
    const privateMessage = f.records.send(f.coordinator.agentId, { operationId: 'list-private', recipients: [b.agent.agentId], purpose: 'inform', body: body('private to b'), at: 13 })
    const invitation = f.records.send(a.agent.agentId, { operationId: 'list-invite', recipients: [c.agent.agentId], purpose: 'question', body: body('join discussion'), discussionRoot: ask.messageId, at: 14 })
    const shared = f.records.publishConstraint(f.coordinator.agentId, { operationId: 'list-shared', source: f.origin, body: body('shared'), at: 15 })
    const ownIds = f.records.listMessages(a.agent.agentId).map(m => m.messageId)
    expect(ownIds).toEqual([a.delegation.delegationId, ask.messageId, reply.messageId, invitation.messageId, shared.messageId])
    expect(ownIds).not.toContain(privateMessage.messageId)
    const invitedIds = f.records.listMessages(c.agent.agentId).map(m => m.messageId)
    expect(invitedIds).toEqual([c.delegation.delegationId, ask.messageId, reply.messageId, invitation.messageId, shared.messageId])
    expect(f.records.inbox(c.agent.agentId).some(i => i.messageId === reply.messageId)).toBe(false)
    const coordinatorIds = f.records.listMessages(f.coordinator.agentId).map(m => m.messageId)
    expect(coordinatorIds).toContain(ask.messageId)
    expect(coordinatorIds).toContain(reply.messageId)
    const standalone = f.records.registerAgent({ operationId: 'list-standalone', sessionId: 'standalone', name: '', role: '', model, at: 16 })
    expect(f.records.listMessages(standalone.agentId)).toEqual([])
    const reopened = createRecordsStore({ dataDir: f.dir, workspace: [] })
    try { expect(reopened.collaboration.listMessages(a.agent.agentId).map(m => m.messageId)).toEqual(ownIds) } finally { reopened.close() }
  } finally { f.close() }
})

describe('协作引用授权 · 不因同工作开放成员全部历史', () => {
  test('猜成员 entryId、越权编辑或借委派来源洗授权均拒绝；明确分享只能转发那一条', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); const b = f.spawn('b'); const c = f.spawn('c')
      const aRecords = f.store.serviceFor('a')
      const sharedRef = { sessionId: 'a', entryId: aRecords.appendEntry({ kind: 'user', content: { text: '可分享这一条' }, at: 11 }) }
      const privateRef = { sessionId: 'a', entryId: aRecords.appendEntry({ kind: 'user', content: { text: '不得猜读的另一条' }, at: 12 }) }
      expect(() => f.records.send(b.agent.agentId, { operationId: 'guess-history', recipients: [b.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref: privateRef }], at: 13 })).toThrow('not accessible')
      expect(f.records.operation('guess-history')).toBeUndefined()
      expect(() => f.records.delegate(f.coordinator.agentId, { operationId: 'launder-source', assigneeId: b.agent.agentId, scope: 'bad source', source: privateRef, authorization: [f.origin], body: body('bad'), at: 13 })).toThrow('not accessible')
      expect(() => f.records.delegate(f.coordinator.agentId, { operationId: 'launder-auth', assigneeId: b.agent.agentId, scope: 'bad authorization', source: f.origin, authorization: [privateRef], body: body('bad'), at: 13 })).toThrow('not accessible')
      const editable = f.records.send(b.agent.agentId, { operationId: 'editable', recipients: [c.agent.agentId], purpose: 'inform', body: body('original'), at: 13 })
      expect(() => f.records.editMessage(b.agent.agentId, editable.messageId, [{ kind: 'entry', ref: privateRef }])).toThrow('not accessible')
      expect(f.records.readMessage(c.agent.agentId, editable.messageId)?.body).toEqual(body('original'))
      f.records.send(a.agent.agentId, { operationId: 'share-one', recipients: [b.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref: sharedRef }], at: 14 })
      const forwarded = f.records.send(b.agent.agentId, { operationId: 'forward-one', recipients: [c.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref: sharedRef }], at: 15 })
      expect(f.records.readMessage(c.agent.agentId, forwarded.messageId)?.body).toEqual([{ kind: 'entry', ref: sharedRef }])
      expect(() => f.records.send(c.agent.agentId, { operationId: 'expand-forward', recipients: [c.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref: privateRef }], at: 16 })).toThrow('not accessible')
      expect(() => f.records.send(c.agent.agentId, { operationId: 'forward-origin', recipients: [b.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref: f.origin }], at: 16 })).not.toThrow()
    } finally { f.close() }
  })

  test('委派授权与局部共同约束只开放明确来源；无关成员不能猜读同会话相邻记录', () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); const b = f.spawn('b')
      const records = f.store.serviceFor('origin')
      const authorized = { sessionId: 'origin', entryId: records.appendEntry({ kind: 'user', content: { text: '明确给 b 的授权材料' }, at: 11 }) }
      const constraint = { sessionId: 'origin', entryId: records.appendEntry({ kind: 'user', content: { text: '仅影响 b 的约束' }, at: 12 }) }
      const privateRef = { sessionId: 'origin', entryId: records.appendEntry({ kind: 'user', content: { text: '未分享的原入口记录' }, at: 13 }) }
      f.records.delegate(f.coordinator.agentId, { operationId: 'authorization-source', assigneeId: b.agent.agentId, scope: 'narrow', body: body('read authorized'), source: authorized, authorization: [authorized], at: 14 })
      expect(() => f.records.send(b.agent.agentId, { operationId: 'use-authorization', recipients: [b.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref: authorized }], at: 15 })).not.toThrow()
      f.records.publishConstraint(f.coordinator.agentId, { operationId: 'narrow-constraint', source: constraint, body: [{ kind: 'entry', ref: constraint }], affectedAgents: [b.agent.agentId], at: 16 })
      expect(() => f.records.send(b.agent.agentId, { operationId: 'use-constraint', recipients: [b.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref: constraint }], at: 17 })).not.toThrow()
      expect(() => f.records.send(a.agent.agentId, { operationId: 'guess-constraint', recipients: [a.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref: constraint }], at: 18 })).toThrow('not accessible')
      expect(() => f.records.send(b.agent.agentId, { operationId: 'expand-origin-session', recipients: [b.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref: privateRef }], at: 19 })).toThrow('not accessible')
    } finally { f.close() }
  })
})

test('局部停止排队 B 保留撤回闭包，不取消同成员已接受 A 或其无绑定协调执行', () => {
  const f = fixture()
  try {
    const a = f.spawn('a'); f.accept(a.delegation.delegationId)
    const queued = f.records.delegate(f.coordinator.agentId, { operationId: 'queued-b', assigneeId: a.agent.agentId, body: body('B'), scope: 'B', source: f.origin, authorization: [f.origin], at: 11 })
    f.records.beginExecution(a.agent.agentId, { operationId: 'active-a', delegationId: a.delegation.delegationId, runId: 'active-run', kind: 'tool', at: 12 })
    f.records.beginExecution(a.agent.agentId, { operationId: 'coordination-a', runId: 'active-run', kind: 'model', mode: 'coordination', at: 12 })
    const stopped = f.records.stop({ kind: 'delegation', delegationId: queued.delegationId }, 'withdraw queued B', 13)
    expect(stopped.delegations).toEqual([queued.delegationId])
    expect(stopped.agents).toEqual([])
    expect(stopped.executions).toEqual([])
    expect(f.records.getDelegation(queued.delegationId)?.state).toBe('cancelled')
    expect(f.records.getDelegation(a.delegation.delegationId)?.state).toBe('accepted')
    expect(f.records.listExecutions(f.collaboration.collaborationId).map(e => e.state)).toEqual(['running', 'running'])
    expect(f.records.checkAdmission(a.agent.agentId, a.delegation.delegationId).allowed).toBe(true)
    expect(f.records.beginExecution(a.agent.agentId, { operationId: 'next-a', delegationId: a.delegation.delegationId, runId: 'active-run', kind: 'tool', at: 14 }).state).toBe('running')
    const stopActive = f.records.stop({ kind: 'delegation', delegationId: a.delegation.delegationId }, 'withdraw active A', 15)
    expect(stopActive.agents).toEqual([a.agent.agentId])
    expect(stopActive.executions).toHaveLength(3)
  } finally { f.close() }
})
