import type {
  AgentId, AgentIdentity, AgentModelConfig, CollaborationRecords, CollaborationReply,
  CollaborationRequest, EntryReference, MessagePart, StopResult,
} from '@magic/contracts'

export type CollaborationActionsDeps = {
  readonly records: CollaborationRecords
  readonly now: () => number
  readonly origin: (agent: AgentIdentity) => Promise<EntryReference>
  readonly resolveModel: (input: { readonly defaults: AgentModelConfig; readonly role?: string; readonly model?: Partial<AgentModelConfig> }) => Promise<AgentModelConfig>
  /** 已登记身份后才启动，启动失败必须可查。 */
  readonly start: (agent: AgentIdentity) => Promise<void>
  readonly wake: (agentId: AgentId) => void
  readonly cancel: (stopped: StopResult) => Promise<void>
  readonly changed: () => void
}

/** 用例编排；持久裁决留在 records，运行归宿主，不复制 AgentLoop。 */
export function createCollaborationActions(deps: CollaborationActionsDeps) {
  const records = deps.records
  return {
    async request(actorId: AgentId, request: CollaborationRequest): Promise<CollaborationReply> {
      try {
        const actor = records.getAgent(actorId)
        if (actor === undefined) throw new Error('执行身份不存在')
        if ('operationId' in request) request = { ...request, operationId: `${actorId}:${request.operationId}` }
        const at = deps.now()
        let collaboration = actor.collaborationId === undefined ? undefined : records.getCollaboration(actor.collaborationId)
        let initialModel: AgentModelConfig | undefined
        if (request.action === 'list') {
          return { ok: true, value: collaboration === undefined ? { self: actor, members: [] } : {
            self: actor,
            collaboration,
            members: records.listMembers(collaboration.collaborationId),
            delegations: records.listDelegations(collaboration.collaborationId),
            waits: records.listWaits(collaboration.collaborationId),
          } }
        }
        if (collaboration === undefined) {
          if (request.action !== 'spawn') throw new Error('这条会话尚未展开协作')
          // 配置未通过时尚无实际派生，原会话仍保持普通工作。
          initialModel = await deps.resolveModel({ defaults: actor.model,
            ...(request.role === undefined ? {} : { role: request.role }),
            ...(request.model === undefined ? {} : { model: request.model }),
          })
          collaboration = records.openCollaboration(actorId, {
            operationId: `collaboration:${actorId}`, at, origin: await deps.origin(actor),
          })
        }
        const id = collaboration.collaborationId
        const accepted = records.listDelegations(id).find(d => d.assigneeId === actorId && d.state === 'accepted')
        const authorized = records.checkAdmission(actorId, accepted?.delegationId, 'coordination')
        // 停止后仍允许保存原委派结果与只读，不借迟到结果恢复执行。
        if (!authorized.allowed && !['deliver', 'read'].includes(request.action)) throw new Error(authorized.reason)
        if (actorId !== collaboration.coordinatorId && accepted === undefined && ['spawn', 'delegate', 'close'].includes(request.action)) throw new Error('先明确接受本次委派，再执行工作或继续派生')
        const source = accepted === undefined ? collaboration.origin : { messageId: accepted.delegationId }
        const authorization = accepted?.authorization ?? [collaboration.origin]
        const scope = accepted === undefined ? {} : { parentDelegationId: accepted.delegationId }
        let value: unknown
        switch (request.action) {
          case 'spawn': {
            const existing = records.operation(request.operationId)
            if (existing?.kind === 'spawn') {
              value = { agent: records.getAgent(existing.agentId), delegation: records.getDelegation(existing.delegationId) }
              break
            }
            const model = initialModel ?? await deps.resolveModel({ defaults: collaboration.defaultModel,
              ...(request.role === undefined ? {} : { role: request.role }),
              ...(request.model === undefined ? {} : { model: request.model }),
            })
            const spawned = records.spawn(actorId, {
              operationId: request.operationId, at, sessionId: crypto.randomUUID(),
              name: request.name, role: request.role ?? '', responsibility: request.responsibility,
              model, scope: request.scope, body: request.body, source, authorization, ...scope,
            })
            try {
              await deps.start(spawned.agent)
              deps.wake(spawned.agent.agentId)
            } catch (error) {
              const reason = `成员启动失败：${messageOf(error)}`
              records.respondToDelegation(spawned.agent.agentId, {
                operationId: `${request.operationId}:failed`, at: deps.now(),
                delegationId: spawned.delegation.delegationId, response: 'reject', reason,
              })
              records.setReachability(spawned.agent.agentId, 'suspended')
              throw new Error(reason)
            }
            value = spawned
            break
          }
          case 'delegate': {
            const delegation = records.delegate(actorId, { operationId: request.operationId, at,
              assigneeId: request.recipient, scope: request.scope, body: request.body, source, authorization, ...scope })
            deps.wake(request.recipient)
            value = delegation
            break
          }
          case 'send': {
            const recipients = request.recipients.length > 0 || request.discussionRoot === undefined ? request.recipients
              : [...new Set(records.listDiscussion(actorId, request.discussionRoot).flatMap(m => [m.senderId, ...m.recipients]))].filter(id => id !== actorId)
            const message = records.send(actorId, { ...request, recipients, at,
              ...(accepted === undefined ? {} : { delegationId: accepted.delegationId }),
            })
            if (message.purpose === 'question' || message.purpose === 'reply') {
              for (const recipient of message.recipients) deps.wake(recipient)
            }
            value = { message, delivery: message.recipients.map(agentId => ({ agentId, state: 'received' })) }
            break
          }
          case 'respond': {
            const response = records.respondToDelegation(actorId, {
              operationId: request.operationId, at, delegationId: request.delegation,
              response: request.response, ...(request.reason === undefined ? {} : { reason: request.reason }),
            })
            if (request.response !== 'accept') deps.wake(response.delegation.delegatorId)
            value = response
            break
          }
          case 'deliver': {
            const body: readonly MessagePart[] = [{ kind: 'text', text: JSON.stringify({
              conclusion: request.conclusion, artifacts: request.artifacts, verified: request.verified, unresolved: request.unresolved,
            }) }]
            const message = records.deliver(actorId, { operationId: request.operationId, at,
              delegationId: request.delegation, body })
            for (const recipient of message.recipients) deps.wake(recipient)
            value = message
            break
          }
          case 'receive': value = records.receiveDelivery(actorId, request.delegation, at); break
          case 'read': value = request.discussion === true
            ? records.listDiscussion(actorId, request.message)
            : records.readMessage(actorId, request.message); break
          case 'wait':
            if (!Number.isFinite(request.deadline) || request.deadline <= at) throw new Error('等待截止时间必须在未来')
            value = records.registerWait(actorId, { operationId: request.operationId, at,
              forAgents: request.agents, expectation: request.expectation, deadline: request.deadline,
              ...(request.message === undefined ? {} : { forMessageId: request.message }),
              ...(accepted === undefined ? {} : { delegationId: accepted.delegationId }),
            })
            break
          case 'stop': {
            if (request.delegation === undefined && actorId !== collaboration.coordinatorId) throw new Error('整体停止由原入口承接')
            if (request.delegation !== undefined) {
              const target = records.getDelegation(request.delegation)
              if (target === undefined || target.collaborationId !== id ||
                (actorId !== collaboration.coordinatorId && target.delegatorId !== actorId && target.assigneeId !== actorId)) {
                throw new Error('不能停止不属于自己责任范围的委派')
              }
            }
            const stopped = records.stop(request.delegation === undefined
              ? { kind: 'collaboration', collaborationId: id }
              : { kind: 'delegation', delegationId: request.delegation }, request.reason, at)
            await deps.cancel(stopped)
            value = stopped
            break
          }
          case 'close':
            if (actorId !== collaboration.coordinatorId) throw new Error('整体收尾由原入口承接')
            records.beginClosing(id, at)
            value = { closing: true, note: '已停止新派生；说明整合结果后结束本轮，宿主将按已收下结果和实际在途事实核销。',
              pending: records.listDelegations(id).filter(d => !['received', 'rejected', 'cancelled'].includes(d.state)) }
            break
        }
        deps.changed()
        return { ok: true, value }
      } catch (error) {
        deps.changed()
        return { ok: false, reason: messageOf(error) }
      }
    },
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
