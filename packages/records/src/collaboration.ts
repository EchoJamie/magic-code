import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  AgentId, AgentIdentity, AgentMessage, AgentMessagePayload, Collaboration, CollaborationRecords,
  CollaborationWait, DelegateInput, Delegation, EntryReference, ExecutionAdmission,
  InboxItem, MessagePart, OperationResult, SharedConstraint,
} from '@magic/contracts'
import { entryParamsOf } from './entries.ts'
import type { IdSpace } from './ids.ts'

/** All mutations take the SQLite write lock before reading admission or inbox state. */
export function createCollaborationRecords(db: Database, workspace: readonly string[], ids: IdSpace): CollaborationRecords {
  type Binding = SQLQueryBindings
  const get = <T>(sql: string, ...args: Binding[]): T | undefined => db.query<T, Binding[]>(sql).get(...args) ?? undefined
  const all = <T>(sql: string, ...args: Binding[]): T[] => db.query<T, Binding[]>(sql).all(...args)
  const run = (sql: string, ...args: Binding[]) => db.query(sql).run(...args)
  const one = <T>(table: string, id: Binding): T | undefined => {
    const row = get<{ data: string }>(`SELECT data FROM ${table} WHERE id = ?`, id)
    return row ? JSON.parse(row.data) as T : undefined
  }
  const many = <T>(table: string, where: string, ...args: Binding[]): T[] =>
    all<{ data: string }>(`SELECT data FROM ${table} WHERE ${where}`, ...args).map(row => JSON.parse(row.data) as T)
  const tx = <T>(fn: () => T): T => db.transaction(fn).immediate()
  const nextId = () => ids.next()
  const agent = (id: AgentId): AgentIdentity => required(one<AgentIdentity>('collaboration_agents', id), 'agent not found')
  const collaboration = (id: string): Collaboration => required(one<Collaboration>('collaborations', id), 'collaboration not found')
  const delegation = (id: number): Delegation => required(one<Delegation>('collaboration_delegations', id), 'delegation not found')
  const message = (id: number): AgentMessage => required(one<AgentMessage>('collaboration_messages', id), 'message not found')
  const members = (id: string) => many<AgentIdentity>('collaboration_agents', 'collaboration = ? ORDER BY rowid', id)
  const delegations = (id: string) => many<Delegation>('collaboration_delegations', 'collaboration = ? ORDER BY rowid', id)
  const waits = (id: string) => many<CollaborationWait>('collaboration_waits', 'collaboration = ? ORDER BY rowid', id)
  const executions = (id: string) => many<ExecutionAdmission>('collaboration_executions', 'collaboration = ? ORDER BY rowid', id)
  const saveAgent = (a: AgentIdentity) => run('UPDATE collaboration_agents SET collaboration=?, data=? WHERE id=?', a.collaborationId ?? null, JSON.stringify(a), a.agentId)
  const saveCollaboration = (c: Collaboration) => run('UPDATE collaborations SET data=? WHERE id=?', JSON.stringify(c), c.collaborationId)
  const saveDelegation = (d: Delegation) => run('UPDATE collaboration_delegations SET state=?,data=? WHERE id=?', d.state, JSON.stringify(d), d.delegationId)
  const saveWait = (w: CollaborationWait) => run('UPDATE collaboration_waits SET state=?,data=? WHERE id=?', w.state, JSON.stringify(w), w.waitId)
  const saveMessage = (m: AgentMessage) => run('UPDATE collaboration_messages SET data=? WHERE id=?', JSON.stringify(m), m.messageId)
  const saveExecution = (e: ExecutionAdmission) => run('UPDATE collaboration_executions SET state=?,data=? WHERE id=?', e.state, JSON.stringify(e), e.operationId)
  function prior(id: string, actor: string, kind: OperationResult['kind']): OperationResult | undefined {
    nonempty(id, 'operationId')
    const row = get<{ actor: string; result: string }>('SELECT actor,result FROM collaboration_operations WHERE id=?', id)
    if (!row) return undefined
    const result = JSON.parse(row.result) as OperationResult
    if (row.actor !== actor || result.kind !== kind) throw new Error('operation identity conflict')
    return result
  }
  const remember = (id: string, actor: string, result: OperationResult) => run('INSERT INTO collaboration_operations VALUES (?,?,?)', id, actor, JSON.stringify(result))
  const scopeFor = (actor: string): Collaboration => collaboration(required(agent(actor).collaborationId, 'agent has no collaboration'))
  function sameMember(id: string, c: Collaboration): AgentIdentity {
    const a = agent(id)
    if (a.collaborationId !== c.collaborationId) throw new Error('recipient is outside collaboration')
    return a
  }
  function entry(ref: EntryReference, c?: Collaboration, user = false): void {
    const row = get<{ kind: string; payload: string | null }>('SELECT kind,payload FROM entries WHERE session=? AND id=?', ref.sessionId, ref.entryId)
    if (!row) throw new Error('source entry not found')
    if (user && (row.kind !== 'user' || (row.payload && JSON.parse(row.payload).notice === true))) throw new Error('source is not a user instruction')
    if (c && !members(c.collaborationId).some(a => a.sessionId === ref.sessionId)) throw new Error('entry is outside collaboration')
  }
  function requireOpen(c: Collaboration): void {
    if (get<{ value: string }>("SELECT value FROM records_meta WHERE key='collaboration_host_stop'")?.value) throw new Error('host admission closed')
    if (c.state !== 'open') throw new Error('collaboration admission closed')
  }
  function canAct(actor: string, c: Collaboration): void {
    requireOpen(c)
    if (sameMember(actor, c).reachability !== 'active') throw new Error('agent admission closed')
    if (executions(c.collaborationId).some(e => e.agentId === actor && e.state === 'cancel-requested')) throw new Error('agent cancellation settling')
  }
  function canReference(actor: string, ref: EntryReference, c: Collaboration): boolean {
    if (agent(actor).sessionId === ref.sessionId || sameReference(c.origin, ref)) return true
    for (const d of delegations(c.collaborationId)) {
      if (d.assigneeId !== actor && d.delegatorId !== actor) continue
      if (d.authorization.some(source => sameReference(source, ref))) return true
      if (!('messageId' in d.source) && sameReference(d.source, ref)) return true
    }
    // 权限沿消息中明确分享的单条引用传递，不把“认识成员”升级为整段历史读取权。
    return many<AgentMessage>('collaboration_messages', 'collaboration=?', c.collaborationId).some(m =>
      !m.withdrawn && canRead(actor, m) && (
        m.body.some(part => part.kind === 'entry' && sameReference(part.ref, ref)) ||
        m.purpose === 'constraint' && m.userSource !== undefined && sameReference(m.userSource, ref)
      ),
    )
  }
  function requireReference(actor: string, ref: EntryReference, c: Collaboration): void {
    entry(ref, c)
    if (!canReference(actor, ref, c)) throw new Error('entry reference not accessible to sender')
  }
  function validBody(body: readonly MessagePart[], c: Collaboration, actor: string): void {
    if (!Array.isArray(body) || body.length === 0) throw new Error('message body required')
    for (const part of body) {
      if (part.kind === 'entry') requireReference(actor, part.ref, c)
      else if (part.kind === 'text') { if (typeof part.text !== 'string') throw new Error('invalid message text') }
      else if (part.kind === 'blob') nonempty(part.blob, 'blob')
      else throw new Error('invalid message part')
    }
  }
  function addAgent(input: { sessionId: string; name: string; role: string; purpose?: 'consultation'; responsibility?: string; model: AgentIdentity['model']; at: number }, roots: readonly string[], c?: string, createdBy?: string): AgentIdentity {
    nonempty(input.sessionId, 'sessionId'); nonempty(input.model.provider, 'provider'); nonempty(input.model.model, 'model')
    run('INSERT INTO sessions(id,at,workspace) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING', input.sessionId, input.at, JSON.stringify(roots))
    const a: AgentIdentity = { agentId: randomUUID(), ...input, workspace: [...roots], reachability: 'active', ...(c ? { collaborationId: c } : {}), ...(createdBy ? { createdBy } : {}) }
    run('INSERT INTO collaboration_agents VALUES (?,?,?,?)', a.agentId, a.sessionId, c ?? null, JSON.stringify(a))
    return a
  }
  function appendReference(recipient: AgentIdentity, m: AgentMessage, at: number): number {
    const existing = get<{ id: number }>("SELECT id FROM entries WHERE session=? AND kind='agent-message' AND json_extract(payload,'$.messageId')=?", recipient.sessionId, m.messageId)
    if (existing) return existing.id
    const id = nextId()
    const payload: AgentMessagePayload = { messageId: m.messageId, collaborationId: m.collaborationId, senderId: m.senderId }
    const params = entryParamsOf(id, recipient.sessionId, { kind: 'agent-message', content: { text: '' }, payload, source: agent(m.senderId).sessionId, at })
    db.query(`INSERT INTO entries(id,session,kind,content_kind,content_text,content_blob,payload,at,source) VALUES ($id,$session,$kind,$contentKind,$contentText,$contentBlob,$payload,$at,$source)`).run(params)
    return id
  }
  function enqueue(m: AgentMessage, recipient: string): void {
    run('INSERT INTO collaboration_inbox(recipient,message) VALUES (?,?) ON CONFLICT(recipient,message) DO NOTHING', recipient, m.messageId)
  }
  function enqueueConstraints(a: AgentIdentity): void {
    if (!a.collaborationId) return
    for (const constraint of api.listConstraints(a.collaborationId)) {
      if (constraint.active && (!constraint.affectedAgents || constraint.affectedAgents.includes(a.agentId))) enqueue(message(constraint.messageId), a.agentId)
    }
  }
  function createMessage(actor: string, input: Omit<AgentMessage, 'messageId' | 'collaborationId' | 'senderId' | 'withdrawn'>, late = false, root = false): AgentMessage {
    const c = scopeFor(actor)
    if (!late) canAct(actor, c)
    validBody(input.body, c, actor)
    const recipients = [...new Set(input.recipients)]
    if (!recipients.length) throw new Error('explicit recipients required')
    for (const id of recipients) {
      const a = sameMember(id, c)
      if (!late && a.reachability === 'historical') throw new Error('recipient is historical')
    }
    for (const ref of [input.replyTo, input.discussionRoot]) {
      if (ref === undefined) continue
      const m = message(ref)
      if (m.collaborationId !== c.collaborationId || !canRead(actor, m)) throw new Error('message reference not accessible')
    }
    if (input.discussionRoot !== undefined && message(input.discussionRoot).discussionRoot !== input.discussionRoot) throw new Error('invalid discussion root')
    const id = nextId()
    const m: AgentMessage = { ...input, recipients, messageId: id, collaborationId: c.collaborationId, senderId: actor, withdrawn: false, ...(root ? { discussionRoot: id } : {}) }
    run('INSERT INTO collaboration_messages VALUES (?,?,?,?)', id, c.collaborationId, actor, JSON.stringify(m))
    appendReference(agent(actor), m, input.at)
    for (const recipient of recipients) enqueue(m, recipient)
    // 普通告知与回执不解除等待。收到结果仅保存等待事实，唤起仍须过准入。
    if (['reply', 'delivery', 'clarification'].includes(m.purpose)) {
      for (const w of waits(c.collaborationId)) {
        if (w.state !== 'waiting' || !recipients.includes(w.agentId) || !w.forAgents.includes(actor)) continue
        if (w.forMessageId !== undefined && m.replyTo !== w.forMessageId && m.delegationId !== w.forMessageId) continue
        saveWait({ ...w, state: 'resolved', resultMessageId: id, reason: m.purpose })
      }
    }
    return m
  }
  function canRead(actor: string, m: AgentMessage): boolean {
    const a = agent(actor)
    if (a.collaborationId !== m.collaborationId) return false
    const constraint = get<{ data: string }>('SELECT data FROM collaboration_constraints WHERE message=?', m.messageId)
    const shared = constraint ? JSON.parse(constraint.data) as SharedConstraint : undefined
    const discussion = m.discussionRoot !== undefined && get(`SELECT 1 FROM collaboration_messages WHERE collaboration=? AND json_extract(data,'$.discussionRoot')=? AND (sender=? OR EXISTS (SELECT 1 FROM json_each(json_extract(data,'$.recipients')) WHERE value=?))`, m.collaborationId, m.discussionRoot, actor, actor) !== undefined
    return m.senderId === actor || m.recipients.includes(actor) || discussion || !!(shared && (!shared.affectedAgents || shared.affectedAgents.includes(actor)))
  }
  function createDelegation(actor: string, input: DelegateInput): Delegation {
    const c = scopeFor(actor); canAct(actor, c)
    const target = sameMember(input.assigneeId, c)
    if (target.reachability !== 'active') throw new Error('assignee does not accept work')
    nonempty(input.scope, 'scope')
    let authorization = input.authorization
    if (input.parentDelegationId !== undefined) {
      const parent = delegation(input.parentDelegationId)
      if (parent.collaborationId !== c.collaborationId || parent.assigneeId !== actor || parent.state !== 'accepted') throw new Error('parent delegation not active for actor')
      if (!('messageId' in input.source) || input.source.messageId !== parent.delegationId) throw new Error('delegation source must preserve parent')
      authorization = parent.authorization
      if (JSON.stringify(input.authorization) !== JSON.stringify(authorization)) throw new Error('delegation cannot change authorization source')
    } else {
      if (actor !== c.coordinatorId) throw new Error('member delegation requires active parent')
      if ('messageId' in input.source) {
        if (!canRead(actor, message(input.source.messageId))) throw new Error('source not accessible')
      } else {
        entry(input.source, c, true)
        requireReference(actor, input.source, c)
      }
    }
    if (!authorization.length) throw new Error('authorization source required')
    for (const ref of authorization) {
      entry(ref, c, true)
      requireReference(actor, ref, c)
    }
    const m = createMessage(actor, { recipients: [input.assigneeId], purpose: 'delegation', body: input.body, at: input.at })
    const d: Delegation = { delegationId: m.messageId, collaborationId: c.collaborationId, delegatorId: actor, assigneeId: input.assigneeId, source: input.source, authorization, scope: input.scope, state: 'queued', at: input.at, ...(input.parentDelegationId === undefined ? {} : { parentDelegationId: input.parentDelegationId }) }
    saveMessage({ ...m, delegationId: d.delegationId })
    run('INSERT INTO collaboration_delegations VALUES (?,?,?,?,?,?)', d.delegationId, c.collaborationId, d.parentDelegationId ?? null, d.assigneeId, d.state, JSON.stringify(d))
    return d
  }
  const inbox = (id: string, after = 0): InboxItem[] => all<{ position: number; recipient: string; message: number; state: InboxItem['state']; entry: number | null; consumed_at: number | null; included_at: number | null }>('SELECT * FROM collaboration_inbox WHERE recipient=? AND position>? ORDER BY position', id, after).map(row => ({ position: row.position, recipientId: row.recipient, messageId: row.message, state: row.state, ...(row.entry === null ? {} : { entryId: row.entry }), ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }), ...(row.included_at === null ? {} : { includedAt: row.included_at }) }))
  function interrupt(agentId: string, reason: string): CollaborationWait[] {
    const result = many<CollaborationWait>('collaboration_waits', "state='waiting'").filter(w => w.agentId === agentId || w.forAgents.includes(agentId)).map(w => ({ ...w, state: 'interrupted' as const, reason }))
    result.forEach(saveWait); return result
  }
  function closure(root: number): Delegation[] {
    return all<{ data: string }>(`WITH RECURSIVE scope(id) AS (SELECT id FROM collaboration_delegations WHERE id=? UNION ALL SELECT d.id FROM collaboration_delegations d JOIN scope s ON d.parent=s.id) SELECT data FROM collaboration_delegations WHERE id IN (SELECT id FROM scope)`, root).map(r => JSON.parse(r.data) as Delegation)
  }
  const api: CollaborationRecords = {
    registerAgent(input) { return tx(() => {
      const old = prior(input.operationId, input.sessionId, 'identity')
      if (old?.kind === 'identity') return agent(old.agentId)
      const existing = api.agentForSession(input.sessionId)
      const roots = get<{ workspace: string | null }>('SELECT workspace FROM sessions WHERE id=?', input.sessionId)?.workspace
      const a = existing ?? addAgent({ sessionId: input.sessionId, name: input.name, role: input.role, ...(input.responsibility === undefined ? {} : { responsibility: input.responsibility }), model: input.model, at: input.at }, roots ? JSON.parse(roots) as string[] : workspace)
      remember(input.operationId, input.sessionId, { kind: 'identity', agentId: a.agentId }); return a
    }) },
    getAgent(id) { return one('collaboration_agents', id) },
    agentForSession(id) { return many<AgentIdentity>('collaboration_agents', 'session=?', id)[0] },
    updateAgent(id, patch) { return tx(() => {
      const a = { ...agent(id), ...patch }; nonempty(a.model.provider, 'provider'); nonempty(a.model.model, 'model'); saveAgent(a); return a
    }) },
    setReachability(id, state) { tx(() => {
      const a = agent(id)
      if (state === 'active' && a.collaborationId) requireOpen(collaboration(a.collaborationId))
      saveAgent({ ...a, reachability: state })
      if (state === 'active') enqueueConstraints(a)
      if (state === 'historical') interrupt(id, 'agent became historical')
    }) },
    openCollaboration(actor, input) { return tx(() => {
      const old = prior(input.operationId, actor, 'collaboration')
      if (old?.kind === 'collaboration') return collaboration(old.collaborationId)
      const a = agent(actor)
      if (a.collaborationId) {
        const c = collaboration(a.collaborationId)
        if (c.originSessionId !== a.sessionId || JSON.stringify(c.origin) !== JSON.stringify(input.origin)) throw new Error('session already belongs to a collaboration')
        remember(input.operationId, actor, { kind: 'collaboration', collaborationId: c.collaborationId }); return c
      }
      if (input.origin.sessionId !== a.sessionId) throw new Error('origin must belong to coordinator session')
      entry(input.origin, undefined, true)
      const c: Collaboration = { collaborationId: randomUUID(), originSessionId: a.sessionId, origin: input.origin, coordinatorId: actor, defaultModel: a.model, state: 'open', at: input.at }
      requireOpen(c)
      run('INSERT INTO collaborations VALUES (?,?,?)', c.collaborationId, c.originSessionId, JSON.stringify(c))
      saveAgent({ ...a, collaborationId: c.collaborationId })
      remember(input.operationId, actor, { kind: 'collaboration', collaborationId: c.collaborationId }); return c
    }) },
    updateDefaultModel(id, config) { return tx(() => {
      nonempty(config.provider, 'provider'); nonempty(config.model, 'model')
      const c = { ...collaboration(id), defaultModel: config }; saveCollaboration(c); return c
    }) },
    getCollaboration(id) { return one('collaborations', id) },
    collaborationForSession(id) { const a = api.agentForSession(id); return a?.collaborationId ? collaboration(a.collaborationId) : undefined },
    listMembers: members,
    spawn(actor, input) { return tx(() => {
      const old = prior(input.operationId, actor, 'spawn')
      if (old?.kind === 'spawn') return { agent: agent(old.agentId), delegation: delegation(old.delegationId) }
      const c = scopeFor(actor); canAct(actor, c)
      if (api.agentForSession(input.sessionId) || get('SELECT id FROM sessions WHERE id=?', input.sessionId)) throw new Error('spawn requires a new member session')
      const a = addAgent({ sessionId: input.sessionId, name: input.name, role: input.role, ...(input.purpose === undefined ? {} : { purpose: input.purpose }), ...(input.responsibility === undefined ? {} : { responsibility: input.responsibility }), model: input.model, at: input.at }, agent(c.coordinatorId).workspace, c.collaborationId, actor)
      const d = createDelegation(actor, { ...input, assigneeId: a.agentId })
      // 当前约束按引用带入新成员；原消息发送时的 recipients 保持原值。
      enqueueConstraints(a)
      remember(input.operationId, actor, { kind: 'spawn', agentId: a.agentId, delegationId: d.delegationId })
      return { agent: a, delegation: d }
    }) },
    delegate(actor, input) { return tx(() => {
      const old = prior(input.operationId, actor, 'delegation')
      if (old?.kind === 'delegation') return delegation(old.delegationId)
      const d = createDelegation(actor, input)
      remember(input.operationId, actor, { kind: 'delegation', delegationId: d.delegationId }); return d
    }) },
    getDelegation(id) { return one('collaboration_delegations', id) },
    listDelegations: delegations,
    respondToDelegation(actor, input) { return tx(() => {
      const old = prior(input.operationId, actor, 'delegation-response')
      if (old?.kind === 'delegation-response') return { delegation: delegation(old.delegationId), accepted: old.accepted, ...(old.reason ? { reason: old.reason } : {}) }
      const d = delegation(input.delegationId)
      if (d.assigneeId !== actor) throw new Error('only assignee can respond')
      if (input.response === 'accept') canAct(actor, collaboration(d.collaborationId))
      if (!['queued', 'clarification'].includes(d.state)) throw new Error('delegation is not awaiting response')
      let next = d
      let reason = input.reason
      if (input.response === 'accept') {
        if (delegations(d.collaborationId).some(other => other.assigneeId === actor && other.state === 'accepted') || executions(d.collaborationId).some(e => e.agentId === actor && e.state !== 'finished' && e.mode !== 'coordination')) reason = 'agent already has active responsibility'
        else next = { ...d, state: 'accepted', acceptedAt: input.at }
      } else {
        nonempty(input.reason ?? (input.body?.length ? 'body' : ''), 'response reason')
        next = { ...d, state: input.response === 'reject' ? 'rejected' : 'clarification', ...(reason ? { reason } : {}) }
      }
      if (next !== d) {
        saveDelegation(next)
        createMessage(actor, { recipients: [d.delegatorId], purpose: input.response === 'clarify' ? 'clarification' : input.response === 'reject' ? 'decision' : 'receipt', replyTo: d.delegationId, delegationId: d.delegationId, body: input.body ?? [{ kind: 'text', text: input.reason ?? input.response }], at: input.at }, input.response !== 'accept')
        if (input.response === 'reject') for (const w of waits(d.collaborationId)) {
          if (w.state === 'waiting' && w.forAgents.includes(actor) && (w.forMessageId === undefined || w.forMessageId === d.delegationId)) saveWait({ ...w, state: 'interrupted', reason: input.reason ?? 'delegation rejected' })
        }
      }
      const accepted = next.state === 'accepted'
      remember(input.operationId, actor, { kind: 'delegation-response', delegationId: d.delegationId, accepted, ...(reason ? { reason } : {}) })
      return { delegation: next, accepted, ...(reason ? { reason } : {}) }
    }) },
    deliver(actor, input) { return tx(() => {
      const old = prior(input.operationId, actor, 'delivery')
      if (old?.kind === 'delivery') return message(old.messageId)
      const d = delegation(input.delegationId)
      if (d.assigneeId !== actor || d.acceptedAt === undefined || !['accepted', 'cancelled'].includes(d.state)) throw new Error('delegation not accepted by sender')
      if (d.deliveryMessageId !== undefined) throw new Error('delegation already delivered')
      const m = createMessage(actor, { recipients: [d.delegatorId], purpose: 'delivery', body: input.body, replyTo: d.delegationId, delegationId: d.delegationId, at: input.at }, true)
      saveDelegation({ ...d, state: d.state === 'cancelled' ? 'cancelled' : 'delivered', deliveryMessageId: m.messageId, deliveredAt: input.at, ...(input.reason === undefined ? {} : { reason: input.reason }) })
      remember(input.operationId, actor, { kind: 'delivery', messageId: m.messageId }); return m
    }) },
    receiveDelivery(actor, id, at) { return tx(() => {
      const d = delegation(id)
      if (d.delegatorId !== actor || d.deliveryMessageId === undefined) throw new Error('delivery not available to delegator')
      if (d.state === 'received') return d
      const next: Delegation = { ...d, state: d.state === 'cancelled' ? 'cancelled' : 'received', receivedAt: d.receivedAt ?? at }; saveDelegation(next); return next
    }) },
    send(actor, input) { return tx(() => {
      const old = prior(input.operationId, actor, 'message')
      if (old?.kind === 'message') return message(old.messageId)
      if (!['inform', 'question', 'reply', 'receipt', 'decision'].includes(input.purpose)) throw new Error('reserved message purpose')
      if (input.delegationId !== undefined) {
        const d = delegation(input.delegationId)
        if (d.collaborationId !== scopeFor(actor).collaborationId || (d.assigneeId !== actor && d.delegatorId !== actor)) throw new Error('delegation reference not accessible')
      }
      const m = createMessage(actor, { recipients: input.recipients, purpose: input.purpose, body: input.body, at: input.at, ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }), ...(input.discussionRoot === undefined ? {} : { discussionRoot: input.discussionRoot }), ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }) }, false, input.startDiscussion)
      remember(input.operationId, actor, { kind: 'message', messageId: m.messageId }); return m
    }) },
    readMessage(actor, id) { const m = one<AgentMessage>('collaboration_messages', id); return m && canRead(actor, m) ? m : undefined },
    listMessages(actor) {
      const a = agent(actor)
      return a.collaborationId === undefined ? [] : many<AgentMessage>('collaboration_messages', 'collaboration=? ORDER BY rowid', a.collaborationId).filter(m => canRead(actor, m))
    },
    listDiscussion(actor, root) {
      const m = api.readMessage(actor, root)
      if (!m || m.discussionRoot !== root) return []
      return many<AgentMessage>('collaboration_messages', 'collaboration=? ORDER BY rowid', m.collaborationId).filter(item => item.discussionRoot === root && canRead(actor, item))
    },
    inbox(id, after) { agent(id); return inbox(id, after) },
    consumeInbox(id, at, limit) { return tx(() => {
      const a = agent(id)
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('invalid inbox page size')
      const items = inbox(id).filter(item => item.state === 'pending').slice(0, limit)
      return items.map(item => {
        const m = message(item.messageId)
        const entryId = appendReference(a, m, at)
        run("UPDATE collaboration_inbox SET state='consumed',entry=?,consumed_at=? WHERE position=?", entryId, at, item.position)
        return { ...item, state: 'consumed', entryId, consumedAt: at }
      })
    }) },
    markIncluded(id, ids, at) { tx(() => {
      for (const messageId of new Set(ids)) {
        const row = get<{ state: string }>('SELECT state FROM collaboration_inbox WHERE recipient=? AND message=?', id, messageId)
        if (row?.state !== 'consumed') throw new Error('message must be consumed before request inclusion')
        run('UPDATE collaboration_inbox SET included_at=COALESCE(included_at,?) WHERE recipient=? AND message=?', at, id, messageId)
      }
    }) },
    editMessage(actor, id, body) { return tx(() => {
      const m = message(id)
      if (m.senderId !== actor) throw new Error('only sender can edit')
      if (m.withdrawn || ['delegation', 'delivery', 'constraint'].includes(m.purpose) || get("SELECT 1 FROM collaboration_inbox WHERE message=? AND state<>'pending'", id)) return false
      validBody(body, collaboration(m.collaborationId), actor); saveMessage({ ...m, body }); return true
    }) },
    withdrawMessage(actor, id) { return tx(() => {
      const m = message(id)
      if (m.senderId !== actor) throw new Error('only sender can withdraw')
      if (m.withdrawn) return true
      if (['delegation', 'delivery', 'constraint'].includes(m.purpose) || get("SELECT 1 FROM collaboration_inbox WHERE message=? AND state<>'pending'", id)) return false
      saveMessage({ ...m, withdrawn: true }); run("UPDATE collaboration_inbox SET state='withdrawn' WHERE message=?", id); return true
    }) },
    publishConstraint(actor, input) { return tx(() => {
      const old = prior(input.operationId, actor, 'constraint')
      if (old?.kind === 'constraint') return message(old.messageId)
      const c = scopeFor(actor)
      if (c.coordinatorId !== actor) throw new Error('only coordinator publishes shared user constraints')
      entry(input.source, c, true)
      if (input.source.sessionId !== c.originSessionId) throw new Error('shared constraint requires original user entry')
      if (input.replaces !== undefined) {
        const previous = api.listConstraints(c.collaborationId).find(item => item.messageId === input.replaces)
        if (!previous) throw new Error('constraint to replace not found')
        run('UPDATE collaboration_constraints SET data=? WHERE message=?', JSON.stringify({ ...previous, active: false }), input.replaces)
      }
      const recipients = input.affectedAgents ?? members(c.collaborationId).filter(a => a.reachability !== 'historical').map(a => a.agentId)
      const m = createMessage(actor, { recipients, purpose: 'constraint', body: input.body, userSource: input.source, at: input.at })
      const constraint: SharedConstraint = { messageId: m.messageId, collaborationId: c.collaborationId, active: true, ...(input.affectedAgents ? { affectedAgents: [...input.affectedAgents] } : {}) }
      run('INSERT INTO collaboration_constraints VALUES (?,?,?)', m.messageId, c.collaborationId, JSON.stringify(constraint))
      remember(input.operationId, actor, { kind: 'constraint', messageId: m.messageId }); return m
    }) },
    listConstraints(id) { return all<{ data: string }>('SELECT data FROM collaboration_constraints WHERE collaboration=? ORDER BY rowid', id).map(row => JSON.parse(row.data) as SharedConstraint) },
    constraintStatus(id) {
      const m = message(id)
      const c = required(api.listConstraints(m.collaborationId).find(item => item.messageId === id), 'constraint not found')
      return members(m.collaborationId).filter(a => !c.affectedAgents || c.affectedAgents.includes(a.agentId)).map(a => {
        const i = inbox(a.agentId).find(item => item.messageId === id)
        return { agentId: a.agentId, state: i?.includedAt !== undefined ? 'included' : i?.state === 'consumed' ? 'consumed' : 'pending' }
      })
    },
    registerWait(actor, input) { return tx(() => {
      const old = prior(input.operationId, actor, 'wait')
      if (old?.kind === 'wait') return { ok: true, wait: required(one<CollaborationWait>('collaboration_waits', old.waitId), 'wait not found') }
      const c = scopeFor(actor); canAct(actor, c)
      if (!Number.isFinite(input.deadline) || input.deadline <= input.at) throw new Error('wait requires a future finite deadline')
      const targets = [...new Set(input.forAgents)]
      if (!targets.length) throw new Error('wait target required')
      targets.forEach(id => sameMember(id, c))
      if (input.delegationId !== undefined) {
        const d = delegation(input.delegationId)
        if (d.assigneeId !== actor || d.state !== 'accepted') throw new Error('wait must bind active delegation')
      } else if (actor !== c.coordinatorId) throw new Error('member wait requires active delegation')
      if (input.forMessageId !== undefined && !api.readMessage(actor, input.forMessageId)) throw new Error('wait message not accessible')
      const pending = waits(c.collaborationId).filter(w => w.state === 'waiting')
      const pathToActor = (id: string, path: string[]): string[] | undefined => {
        if (id === actor) return [...path, id]
        if (path.includes(id)) return undefined
        for (const edge of pending.filter(w => w.agentId === id).flatMap(w => w.forAgents)) {
          const found = pathToActor(edge, [...path, id]); if (found) return found
        }
        return undefined
      }
      for (const id of targets) { const cycle = pathToActor(id, [actor]); if (cycle) return { ok: false, cycle } }
      const unavailable = targets.find(id => agent(id).reachability === 'historical')
      const found = many<AgentMessage>('collaboration_messages', 'collaboration=? ORDER BY rowid DESC', c.collaborationId).find(m => !m.withdrawn && targets.includes(m.senderId) && m.recipients.includes(actor) && ['reply','delivery','clarification'].includes(m.purpose) && input.forMessageId !== undefined && (m.replyTo === input.forMessageId || m.delegationId === input.forMessageId))
      const w: CollaborationWait = { waitId: nextId(), collaborationId: c.collaborationId, agentId: actor, forAgents: targets, expectation: input.expectation, deadline: input.deadline, at: input.at, state: unavailable ? 'interrupted' : found ? 'resolved' : 'waiting', ...(unavailable ? { reason: 'target is historical' } : {}), ...(found ? { resultMessageId: found.messageId } : {}), ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }), ...(input.forMessageId === undefined ? {} : { forMessageId: input.forMessageId }) }
      run('INSERT INTO collaboration_waits VALUES (?,?,?,?,?)', w.waitId, c.collaborationId, actor, w.state, JSON.stringify(w))
      remember(input.operationId, actor, { kind: 'wait', waitId: w.waitId }); return { ok: true, wait: w }
    }) },
    listWaits: waits,
    expireWaits(at) { return tx(() => {
      const result = many<CollaborationWait>('collaboration_waits', "state='waiting'").filter(w => w.deadline <= at).map(w => ({ ...w, state: 'expired' as const, reason: 'deadline reached' }))
      result.forEach(saveWait); return result
    }) },
    consumeWaitOutcomes(id, at) { return tx(() => {
      agent(id)
      const result = many<CollaborationWait>('collaboration_waits', "agent=? AND state<>'waiting' ORDER BY rowid", id).filter(w => w.handledAt === undefined).map(w => ({ ...w, handledAt: at }))
      result.forEach(saveWait); return result
    }) },
    markWaitOutcomesIncluded(id, ids, at) { tx(() => {
      for (const waitId of new Set(ids)) {
        const w = required(one<CollaborationWait>('collaboration_waits', waitId), 'wait not found')
        if (w.agentId !== id) throw new Error('wait outcome not owned by agent')
        if (w.state === 'waiting' || w.handledAt === undefined) throw new Error('wait outcome must be terminal and consumed before request inclusion')
        if (w.includedAt === undefined) saveWait({ ...w, includedAt: at })
      }
    }) },
    interruptWaits(id, reason) { return tx(() => interrupt(id, reason)) },
    checkAdmission(id, delegationId, mode = 'work') {
      const a = agent(id); const c = scopeFor(id)
      if (get<{ value: string }>("SELECT value FROM records_meta WHERE key='collaboration_host_stop'")?.value) return { allowed: false, reason: 'host admission closed' }
      if (!['open', 'closing'].includes(c.state) || a.reachability !== 'active') return { allowed: false, reason: 'collaboration or agent admission closed' }
      if (delegationId !== undefined) {
        const d = delegation(delegationId)
        if (d.assigneeId !== id || d.collaborationId !== c.collaborationId || d.state !== 'accepted') return { allowed: false, reason: 'delegation not accepted or cancelled' }
      } else if (mode === 'work' && (a.agentId !== c.coordinatorId || delegations(c.collaborationId).some(d => d.assigneeId === id && d.state === 'accepted'))) return { allowed: false, reason: 'active delegation binding required' }
      if (executions(c.collaborationId).some(e => e.agentId === id && e.state === 'cancel-requested')) return { allowed: false, reason: 'cancellation settling' }
      return { allowed: true }
    },
    beginExecution(actor, input) { return tx(() => {
      const old = prior(input.operationId, actor, 'execution')
      if (old?.kind === 'execution') return required(one<ExecutionAdmission>('collaboration_executions', old.operationId), 'execution not found')
      const decision = api.checkAdmission(actor, input.delegationId, input.mode)
      if (!decision.allowed) throw new Error(decision.reason)
      const c = scopeFor(actor)
      if (executions(c.collaborationId).some(e => e.agentId === actor && e.runId === input.runId && e.cancelledAt !== undefined)) throw new Error('execution run was cancelled; use a new run identity')
      if (executions(c.collaborationId).some(e => e.agentId === actor && e.state !== 'finished' && e.runId !== input.runId)) throw new Error('agent already has a running executor')
      const e: ExecutionAdmission = { operationId: input.operationId, agentId: actor, runId: input.runId, kind: input.kind, ...(input.mode === undefined ? {} : { mode: input.mode }), state: 'running', at: input.at, ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }) }
      run('INSERT INTO collaboration_executions VALUES (?,?,?,?,?,?)', e.operationId, actor, c.collaborationId, e.delegationId ?? null, e.state, JSON.stringify(e))
      remember(input.operationId, actor, { kind: 'execution', operationId: input.operationId }); return e
    }) },
    finishExecution(id, reason) { tx(() => {
      const e = required(one<ExecutionAdmission>('collaboration_executions', id), 'execution not found')
      if (e.state !== 'finished') saveExecution({ ...e, state: 'finished', ...(reason ? { reason } : {}) })
    }) },
    listExecutions: executions,
    stop(scope, reason, at) { return tx(() => {
      nonempty(reason, 'stop reason')
      if (scope.kind === 'host') run("INSERT INTO records_meta(key,value) VALUES ('collaboration_host_stop',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", reason)
      const cs = scope.kind === 'host' ? many<Collaboration>('collaborations', '1=1') : [scope.kind === 'collaboration' ? collaboration(scope.collaborationId) : collaboration(delegation(scope.delegationId).collaborationId)]
      const ds = scope.kind === 'delegation' ? closure(scope.delegationId) : cs.flatMap(c => delegations(c.collaborationId))
      const ids = new Set(ds.map(d => d.delegationId))
      const scopeAgents = new Set(ds.map(d => d.assigneeId))
      const acceptedElsewhere = new Set(cs.flatMap(c => delegations(c.collaborationId))
        .filter(d => d.state === 'accepted' && !ids.has(d.delegationId)).map(d => d.assigneeId))
      const es = cs.flatMap(c => executions(c.collaborationId)).filter(e =>
        e.state !== 'finished' && (scope.kind !== 'delegation' || (
          e.delegationId !== undefined ? ids.has(e.delegationId)
            : scopeAgents.has(e.agentId) && !acceptedElsewhere.has(e.agentId)
        )),
      ).map(e => ({ ...e, state: 'cancel-requested' as const, cancelledAt: e.cancelledAt ?? at, reason }))
      // 只撤回 queued B 时，A 的成员和执行者均不属于取消目标；此判据与接受共事务。
      const affected = new Set(scope.kind === 'delegation'
        ? [...ds.filter(d => d.state === 'accepted').map(d => d.assigneeId), ...es.map(e => e.agentId)]
          .filter(id => !acceptedElsewhere.has(id))
        : cs.flatMap(c => members(c.collaborationId).map(a => a.agentId)))
      for (const c of cs) if (scope.kind !== 'delegation' && c.state !== 'closed') saveCollaboration({ ...c, state: 'stopped', reason })
      for (const d of ds) if (!['received', 'rejected', 'cancelled'].includes(d.state)) saveDelegation({ ...d, state: 'cancelled', reason })
      es.forEach(saveExecution)
      for (const id of affected) {
        if (scope.kind !== 'delegation' && agent(id).reachability !== 'historical') saveAgent({ ...agent(id), reachability: 'suspended' })
      }
      for (const c of cs) for (const w of waits(c.collaborationId)) {
        if (w.state === 'waiting' && (scope.kind !== 'delegation' || (w.delegationId !== undefined && ids.has(w.delegationId)) || (w.forMessageId !== undefined && ids.has(w.forMessageId)))) saveWait({ ...w, state: 'interrupted', reason })
      }
      return { agents: [...affected], delegations: [...ids], executions: es }
    }) },
    resume(scope, _at) { tx(() => {
      if (scope.kind === 'host') { run("DELETE FROM records_meta WHERE key='collaboration_host_stop'"); return }
      if (scope.kind === 'collaboration') {
        const c = collaboration(scope.collaborationId)
        if (c.state === 'closed') throw new Error('closed collaboration cannot resume')
        if (executions(c.collaborationId).some(e => e.state !== 'finished')) throw new Error('execution effects still unsettled')
        saveCollaboration({ ...c, state: 'open', reason: undefined })
        saveAgent({ ...agent(c.coordinatorId), reachability: 'active' }); return
      }
      const root = delegation(scope.delegationId); requireOpen(collaboration(root.collaborationId))
      const ds = closure(root.delegationId)
      if (executions(root.collaborationId).some(e => e.state !== 'finished' && ds.some(d => d.delegationId === e.delegationId))) throw new Error('execution effects still unsettled')
      for (const d of ds) if (d.state === 'cancelled') {
        saveDelegation({ ...d, state: d.deliveryMessageId === undefined ? 'queued' : 'delivered', reason: undefined })
        saveAgent({ ...agent(d.assigneeId), reachability: 'active' })
        enqueueConstraints(agent(d.assigneeId))
      }
    }) },
    beginClosing(id, _at) { tx(() => {
      const c = collaboration(id)
      if (c.state === 'open') saveCollaboration({ ...c, state: 'closing' })
    }) },
    closeCollaboration(id, _at) { return tx(() => {
      const c = collaboration(id)
      if (c.state === 'closed') return { closed: true, blockers: [] }
      if (c.state === 'open') saveCollaboration({ ...c, state: 'closing' })
      const blockers = delegations(id).filter(d => !['received', 'rejected', 'cancelled'].includes(d.state) || d.deliveryMessageId !== undefined && d.receivedAt === undefined).map(d => `delegation ${d.delegationId}: ${d.state}`)
      blockers.push(...executions(id).filter(e => e.state !== 'finished').map(e => `execution ${e.operationId}: ${e.state}`))
      if (blockers.length) return { closed: false, blockers }
      saveCollaboration({ ...c, state: 'closed' })
      for (const a of members(id)) { saveAgent({ ...a, reachability: 'historical' }); interrupt(a.agentId, 'collaboration closed') }
      return { closed: true, blockers: [] }
    }) },
    operation(id) {
      const row = get<{ result: string }>('SELECT result FROM collaboration_operations WHERE id=?', id)
      return row ? JSON.parse(row.result) as OperationResult : undefined
    },
  }
  return api
}
function required<T>(value: T | undefined, reason: string): T { if (value === undefined) throw new Error(reason); return value }
function nonempty(value: string, name: string): void { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`) }

function sameReference(left: EntryReference, right: EntryReference): boolean {
  return left.sessionId === right.sessionId && left.entryId === right.entryId
}
