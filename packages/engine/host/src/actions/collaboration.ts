import type {
  AgentId, AgentIdentity, AgentModelConfig, CollaborationRecords, CollaborationReply,
  CollaborationRequest, ModelSwitchRequest, EntryReference, MessagePart, StopResult,
} from '@magic/contracts'

export type CollaborationActionsDeps = {
  readonly modelChoices?: (session: string) => Promise<unknown>
  readonly records: CollaborationRecords
  readonly now: () => number
  readonly origin: (agent: AgentIdentity) => Promise<EntryReference>
  readonly resolveModel: (input: { readonly session: string; readonly defaults: AgentModelConfig; readonly role?: string; readonly model?: ModelSwitchRequest }) => Promise<AgentModelConfig>
  /** 已登记身份后才启动，启动失败必须可查。 */
  readonly start: (agent: AgentIdentity) => Promise<void>
  readonly wake: (agentId: AgentId) => void
  readonly cancel: (stopped: StopResult) => Promise<void>
  readonly changed: () => void
  /**
   * **逃逸口写面**（P27）——需要主会话回来的事实（问题待答/交付待认收）写进
   * attention 读面；`clear` ＝ 该事实已了结（认收/放弃/消费）后撤下提醒。
   */
  readonly escapeAttention?: (sessionId: string, item: { id: string; kind: 'needs-you'; fact: string; detail?: string }) => void
  readonly clearAttention?: (sessionId: string, ids: readonly string[]) => void
}

/** 用例编排；持久裁决留在 records，运行归宿主，不复制 AgentLoop。 */
export function createCollaborationActions(deps: CollaborationActionsDeps) {
  const records = deps.records
  return {
    async request(actorId: AgentId, request: CollaborationRequest): Promise<CollaborationReply> {
      try {
        const actor = records.getAgent(actorId)
        if (actor === undefined) throw new Error('执行身份不存在')
        if (actor.purpose === 'consultation') throw new Error('咨询执行者不能调用协作或再次咨询')
        const generated = request.generatedFrom === undefined ? {} : { generatedFrom: request.generatedFrom }
        if ('operationId' in request) request = { ...request, operationId: `${actorId}:${request.operationId}` }
        const at = deps.now()
        if (request.action === 'registerIdentity') {
          // 执行者连回登记（registry 段）：身份由宿主核对（连接绑定的 actorId 与载荷 session 一致），
          // 认不出即拒——不新建成员、不展开协作；普通会话（无协作）的执行者同样登记。
          if (request.session !== actor.sessionId) throw new Error('执行身份与连接不符，未登记')
          return { ok: true, value: { agentId: actorId, name: actor.name } }
        }
        let collaboration = actor.collaborationId === undefined ? undefined : records.getCollaboration(actor.collaborationId)
        let initialModel: AgentModelConfig | undefined
        if (request.action === 'list') {
          const choices = await deps.modelChoices?.(actor.sessionId)
          return { ok: true, value: collaboration === undefined ? { self: actor, members: [], choices } : {
            self: actor, choices,
            collaboration,
            members: records.listMembers(collaboration.collaborationId),
            delegations: records.listDelegations(collaboration.collaborationId),
          } }
        }
        if (collaboration === undefined) {
          if (request.action !== 'spawn' && request.action !== 'consult') throw new Error('这条会话尚未展开协作')
          // 配置未通过时尚无实际派生，原会话仍保持普通工作。
          initialModel = await deps.resolveModel({ session: actor.sessionId, defaults: actor.model,
            ...(request.action === 'consult' ? { model: { choice: 'arcane', reasoning: request.reasoning ?? { mode: 'default' } } as ModelSwitchRequest } : {
              ...(request.role === undefined ? {} : { role: request.role }),
              ...(request.model === undefined ? {} : { model: request.model }),
            }),
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
        if (actorId !== collaboration.coordinatorId && accepted === undefined && ['spawn', 'consult', 'delegate', 'close'].includes(request.action)) throw new Error('先明确接受本次委派，再执行工作或继续派生')
        const source = accepted === undefined ? collaboration.origin : { messageId: accepted.delegationId }
        const authorization = accepted?.authorization ?? [collaboration.origin]
        const scope = accepted === undefined ? {} : { parentDelegationId: accepted.delegationId }
        let value: unknown
        let knowledge: readonly import('@magic/contracts').KnowledgeReference[] = []
        switch (request.action) {
          case 'consult':
          case 'spawn': {
            const consulting = request.action === 'consult'
            const existing = records.operation(request.operationId)
            if (existing?.kind === 'spawn') {
              const agent = records.getAgent(existing.agentId)!
              const delegation = records.getDelegation(existing.delegationId)!
              if ((agent.purpose === 'consultation') !== consulting) throw new Error('operationId 已用于另一种派生用途')
              value = consulting ? { consultationId: delegation.delegationId, advisorAgentId: agent.agentId, state: delegation.state } : { agent, delegation }
              break
            }
            const model = initialModel ?? await deps.resolveModel({ session: actor.sessionId, defaults: collaboration.defaultModel,
              ...(request.action === 'consult' ? { model: { choice: 'arcane', reasoning: request.reasoning ?? { mode: 'default' } } as ModelSwitchRequest } : {
                ...(request.role === undefined ? {} : { role: request.role }),
                ...(request.model === undefined ? {} : { model: request.model }),
              }),
            })
            const spawned = records.spawn(actorId, {
              ...generated,
              operationId: request.operationId, at, sessionId: crypto.randomUUID(),
              ...(request.action === 'consult' ? {
                name: '咨询 Arcane', role: '', purpose: 'consultation' as const, responsibility: '只读查证并提供建议，原执行者负责核验和实施',
                scope: request.question, body: [{ kind: 'text' as const, text: request.question }, ...(request.body ?? [])],
              } : { name: request.name, role: request.role ?? '', responsibility: request.responsibility, scope: request.scope,
                body: request.modelReason === undefined ? request.body : [...request.body, { kind: 'text' as const, text: `模型选择：${model.choice[0]!.toUpperCase() + model.choice.slice(1)}；任务理由：${request.modelReason}` }],
              }), model, source, authorization, ...scope,
            })
            if (consulting) {
              const response = records.respondToDelegation(spawned.agent.agentId, { operationId: `${request.operationId}:accept`,
                at, delegationId: spawned.delegation.delegationId, response: 'accept' })
              if (!response.accepted) throw new Error(response.reason ?? '咨询未能受理')
            }
            try {
              await deps.start(spawned.agent)
              deps.wake(spawned.agent.agentId)
            } catch (error) {
              const reason = `成员启动失败：${messageOf(error)}`
              if (consulting) {
                const message = records.deliver(spawned.agent.agentId, { operationId: `${request.operationId}:failed`, at: deps.now(),
                  delegationId: spawned.delegation.delegationId, reason: `咨询未完成：${reason}`, body: [{ kind: 'text', text: `咨询未完成：${reason}` }] })
                for (const recipient of message.recipients) deps.wake(recipient)
              } else records.respondToDelegation(spawned.agent.agentId, {
                operationId: `${request.operationId}:failed`, at: deps.now(),
                delegationId: spawned.delegation.delegationId, response: 'reject', reason,
              })
              records.setReachability(spawned.agent.agentId, 'suspended')
              throw new Error(reason)
            }
            value = consulting ? { consultationId: spawned.delegation.delegationId, advisorAgentId: spawned.agent.agentId, state: 'started' } : spawned
            break
          }
          case 'delegate': {
            const delegation = records.delegate(actorId, { operationId: request.operationId, at,
              ...generated,
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
            knowledge = message.body.flatMap(part => part.knowledge ?? [])
            break
          }
          case 'respond': {
            const response = records.respondToDelegation(actorId, {
              ...generated,
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
              ...generated, delegationId: request.delegation, body })
            // **逃逸口**（P27）：交付给主会话＝「别的会话需要你回来」——写进 attention 读面。
            const delivered = records.getDelegation(request.delegation)
            if (deps.escapeAttention !== undefined && delivered !== undefined) {
              const delegator = records.getAgent(delivered.delegatorId)
              const originSession = delegator?.sessionId ?? collaboration.originSessionId
              deps.escapeAttention(originSession, { id: `collab-deliver:${request.delegation}`, kind: 'needs-you', fact: `${actor.name} 已交付，待主会话认收`, detail: request.conclusion })
            }
            // **已取消的委派（停止后迟到的交付）只保存、不唤醒**——同分支准入注释的那条线：
            // 「停止后仍允许保存原委派结果……**不借迟到结果恢复执行**」。唤醒会让入口新一代
            // 带着交付材料发起模型调用，工作就在用户未明确继续时复活了。收件留在账本里，
            // 用户明确继续时由收件消费路径读到，结果不丢。
            if (records.getDelegation(request.delegation)?.state !== 'cancelled') {
              for (const recipient of message.recipients) deps.wake(recipient)
            }
            value = message
            knowledge = message.body.flatMap(part => part.knowledge ?? [])
            break
          }
          case 'receive': value = records.receiveDelivery(actorId, request.delegation, at); break
          case 'read': {
            const messages = request.discussion === true ? records.listDiscussion(actorId, request.message)
              : [records.readMessage(actorId, request.message)].filter((message): message is import('@magic/contracts').AgentMessage => message !== undefined)
            value = request.discussion === true ? messages : messages[0]
            knowledge = messages.flatMap(message => message.body.flatMap(part => part.knowledge ?? []))
            break
          }
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
              : { kind: 'delegation', delegationId: request.delegation }, request.reason, at, request.generatedFrom)
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
          // —— 执行宿主边界的账本写（T1.1 增补 · registry 段）——
          // 身份由宿主按连接绑定（actorId 来自 session 解析），载荷不自报；回执按 operationId 走 collaboration.reply。
          case 'consumeInbox':
            value = records.consumeInbox(actorId, request.at, request.limit)
            break
          case 'markIncluded':
            records.markIncluded(actorId, request.messageIds, request.at)
            value = { included: request.messageIds.length }
            break
          case 'beginExecution':
            value = records.beginExecution(actorId, {
              operationId: request.operationId, at: request.at, ...generated,
              ...(request.delegationId === undefined ? {} : { delegationId: request.delegationId }),
              runId: request.runId, kind: request.kind, ...(request.mode === undefined ? {} : { mode: request.mode }),
            })
            break
          case 'finishExecution':
            records.finishExecution(request.execution, request.reason)
            value = { finished: request.execution }
            break
          case 'publishConstraint':
            value = records.publishConstraint(actorId, {
              operationId: request.operationId, at: request.at, ...generated, source: request.source, body: request.body,
              ...(request.affectedAgents === undefined ? {} : { affectedAgents: request.affectedAgents }),
              ...(request.replaces === undefined ? {} : { replaces: request.replaces }),
            })
            break
        }
        deps.changed()
        return { ok: true, value, ...(knowledge.length ? { knowledge } : {}) }
      } catch (error) {
        deps.changed()
        return { ok: false, reason: messageOf(error) }
      }
    },
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
