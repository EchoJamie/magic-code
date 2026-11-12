import type { AgentId, AgentMessage, CollaborationMemberView, CollaborationView, Delegation, SessionId } from '@magic/contracts'
import { sanitizeForDisplay } from '@magic/contracts'
import type { PickerRow, ShellStatus, ShellView } from '../../view.ts'

const clean = (text: string): string => sanitizeForDisplay(text).replace(/\s+/g, ' ').trim()
export const collaborationRow = (value: string, label: string, meta = ''): PickerRow => ({
  value, label: clean(label), meta: clean(meta), current: false, oneLine: true,
})
export const delegationState: Record<Delegation['state'], string> = {
  queued: '待接下', clarification: '需要澄清', accepted: '已接下', rejected: '已拒绝',
  delivered: '已回报，待核验', received: '结果已收下', cancelled: '已撤回',
}

const consultationEnded = (member: CollaborationMemberView): boolean => member.agent.purpose === 'consultation' && member.delegation !== undefined && ['delivered', 'received', 'cancelled'].includes(member.delegation.state)

export function memberState(member: CollaborationMemberView): string {
  if (consultationEnded(member) && member.delegation !== undefined) {
    return member.delegation.state === 'cancelled' ? `已撤回${member.delegation.reason ? `：${member.delegation.reason}` : ''}`
      : member.delegation.reason ?? (member.delegation.state === 'received' ? '建议已收下，采纳需核验' : '已完成，建议待核验')
  }
  if (member.pendingDecisions > 0) return `需要你：${member.runtime?.action ?? `${member.pendingDecisions} 项操作待审批`}`
  if (member.runtime?.state === 'stopping') return '正在停止，收尾待确认'
  if (member.agent.reachability === 'suspended') return '执行中断，待处理'
  if (member.waiting?.state === 'waiting') return `等待：${member.waiting.expectation}`
  if (member.waiting?.state === 'expired') return `等待超时：${member.waiting.expectation}`
  if (member.delegation?.state === 'clarification') return `需要澄清：${member.delegation.reason ?? member.delegation.scope}`
  if (member.runtime?.backgroundWaiting) return '等待后台结果'
  if (member.runtime?.state === 'running') return member.runtime.action ?? '执行中'
  if (member.runtime?.state === 'unknown') return '运行情况待核实'
  if (member.runtime?.state === 'stopped') return `已停止${member.runtime.reason ? `：${member.runtime.reason}` : ''}`
  if (member.runtime?.lastTurn === 'error') return '上一轮出错，待处理'
  if (member.delegation !== undefined) return `${delegationState[member.delegation.state]}${member.delegation.reason ? `：${member.delegation.reason}` : ''}`
  return member.agent.reachability === 'historical' ? '记录可查看' : '当前空闲'
}

export function collaborationSummary(snapshot: CollaborationView | undefined): string | undefined {
  if (snapshot?.collaboration === undefined) return undefined
  if (snapshot.members.length <= 1 && snapshot.delegations.length === 0) return undefined
  const consultationOnly = snapshot.members.filter(one => one.agent.agentId !== snapshot.collaboration?.coordinatorId).every(one => one.agent.purpose === 'consultation')
  const label = consultationOnly ? '咨询 Arcane' : '协作'
  const state = snapshot.collaboration.state
  if (state === 'closed') return `${label} · 已收尾，结果可查看`
  const members = snapshot.members.filter(one => !consultationEnded(one))
  const running = members.filter((one) => one.runtime?.state === 'running' && !one.runtime.backgroundWaiting && (!one.runtime.background || one.runtime.action !== undefined)).length
  const needs = members.filter((one) => one.pendingDecisions > 0 || one.delegation?.state === 'clarification')
  const waiting = members.filter((one) => one.waiting?.state === 'waiting' || one.runtime?.backgroundWaiting).length
  const stopping = members.some((one) => one.runtime?.state === 'stopping')
  const blocked = members.filter((one) => one.agent.reachability === 'suspended' || one.waiting?.state === 'expired' || one.runtime?.state === 'unknown' || one.runtime?.lastTurn === 'error' || one.delegation?.state === 'rejected')
  const coordinator = members.find((one) => one.agent.agentId === snapshot.collaboration?.coordinatorId)
  const interrupted = coordinator === undefined || coordinator.agent.reachability !== 'active' || coordinator.runtime?.state === 'stopped' || coordinator.runtime?.state === 'unknown' || coordinator.runtime?.lastTurn === 'error'
  const facts = [
    needs.length ? `需要你：${needs.map((one) => `${one.agent.name}（${memberState(one).replace(/^需要你：|^需要澄清：/, '')}）`).join('、')}` : '',
    blocked.length ? `受阻：${blocked.map((one) => `${one.agent.name}（${memberState(one)}）`).join('、')}` : '',
    interrupted && state === 'open' ? '协调承接待核实' : '',
    running ? `${running} 位执行中` : '',
    waiting ? `${waiting} 位等待结果` : '',
    stopping ? '停止收尾中' : '',
    state === 'stopped' ? '已请求停止，查看停点' : state === 'closing' ? '正在核对收尾' : '',
  ].filter(Boolean)
  return clean(`${label} · ${facts.join(' · ') || '暂无执行，结果待整合'}`)
}

const workState: Record<'open' | 'closing' | 'stopped' | 'closed', string> = {
  open: '进行中', closing: '收尾中', stopped: '已停止', closed: '已收尾',
}

export function collaborationHeader(view: ShellView): readonly string[] {
  const summary = collaborationSummary(view.collaboration)
  const background = view.background?.unknown ? ['后台命令数量待确认 · /ps'] : view.background?.commands.length ? [`${view.background.commands.length} 个后台命令运行中 · /ps`] : []
  if (summary === undefined) return background
  const snapshot = view.collaboration!
  const tabHint = view.dock.kind === 'input' ? ' · Tab 查看工作详情' : ''
  const member = currentMember(view)
  if (member !== undefined) {
    const parent = snapshot.members.find((one) => one.agent.agentId === member.agent.createdBy)?.agent.name
    const delegation = member.delegation === undefined ? '' : ` · 委派：${member.delegation.scope}（${delegationState[member.delegation.state]}）`
    const state = snapshot.collaboration === undefined ? '' : ` · 整件：${workState[snapshot.collaboration.state]}`
    return [
      ...background,
      clean(`子会话 · 由 ${parent ?? '主会话'} 派生 · ${member.agent.name}（${member.agent.role}）· 模型 ${member.agent.model.provider}/${member.agent.model.model}`),
      clean(`${delegation.replace(/^ · /, '')} · 运行：${memberState(member)}${state}`),
      summary,
      clean(`输入给：${member.agent.name}（由 ${parent ?? '主会话'} 派生）${tabHint}`),
    ]
  }
  const delivered = snapshot.members.filter((one) =>
    one.agent.agentId !== snapshot.collaboration?.coordinatorId && one.agent.purpose !== 'consultation'
    && one.agent.reachability === 'active').length
  return [...background, summary, clean(`输入给：整件工作（共同补充）${delivered > 0 ? ` · 将送达 ${delivered} 位成员` : ''}${tabHint}`)]
}

/** 仅投影屏上的整体状态；控制范围仍由明确命令决定。 */
export function collaborationStatus(view: ShellView): ShellStatus {
  if (view.status.state === 'lost') return view.status
  const waiting = (view.background?.waiting.length ?? 0) > 0
  const status: ShellStatus = waiting ? { ...view.status, state: 'background', amount: null } : view.status
  if (view.collaboration?.collaboration === undefined) return status
  const members = view.collaboration.members.filter(one => !consultationEnded(one))
  const needs = members.reduce((sum, member) => sum + member.pendingDecisions, 0)
  if (needs > 0) return { ...view.status, state: 'waiting', amount: `${needs} 项` }
  if (members.some((member) => (member.runtime?.state === 'running' && !member.runtime.backgroundWaiting && (!member.runtime.background || member.runtime.action !== undefined)) || member.runtime?.state === 'stopping' || (member.waiting?.state === 'waiting' && !waiting))) {
    return { ...view.status, state: 'working', amount: null }
  }
  return status
}

/**
 * 当前会话若是派生出来的子会话，返回它对应的成员。
 *
 * 主会话（协作入口）不算子会话——它的成员行就是协调者本身，切换与返回都由
 * `session.open` 完成（见 `shell.ts` 的 `openSession`）。
 */
export function currentMember(view: Pick<ShellView, 'collaboration' | 'sessionId'>): CollaborationMemberView | undefined {
  const snapshot = view.collaboration
  if (snapshot?.collaboration === undefined || view.sessionId === null) return undefined
  const member = snapshot.members.find((one) => one.agent.sessionId === view.sessionId)
  return member === undefined || member.agent.agentId === snapshot.collaboration.coordinatorId ? undefined : member
}

/** 某一会话是否是一条派生子会话（入口／协调者不算）。 */
export function memberForSession(snapshot: CollaborationView | undefined, session: SessionId | null): CollaborationMemberView | undefined {
  if (snapshot?.collaboration === undefined || session === null) return undefined
  const member = snapshot.members.find((one) => one.agent.sessionId === session)
  return member === undefined || member.agent.agentId === snapshot.collaboration.coordinatorId ? undefined : member
}

/**
 * 协作视图里的平铺列表。
 *
 * 当前会话**不在列表里**（D68）：主会话时不列主会话，子会话时不列当前子会话；
 * 当前会话用 `Ctrl+O` 看。派生关系只用「由 xx 派生」写在副文案里，不缩进。
 */
export function memberRows(snapshot: CollaborationView, currentSession?: SessionId | null): readonly PickerRow[] {
  const coordinator = snapshot.collaboration?.coordinatorId
  const nameOf = (id: AgentId | undefined): string =>
    snapshot.members.find((one) => one.agent.agentId === id)?.agent.name ?? '协调'
  const priority = (member: CollaborationMemberView): number => member.pendingDecisions > 0 ? 0 : member.waiting || member.delegation?.state === 'clarification' ? 1 : 2
  return [...snapshot.members]
    .filter((one) => currentSession == null || one.agent.sessionId !== currentSession)
    .sort((a, b) => priority(a) - priority(b))
    .map((one) => {
      const origin = one.agent.agentId === coordinator || one.agent.createdBy === undefined
        ? '主会话'
        : `由 ${nameOf(one.agent.createdBy)} 派生`
      return collaborationRow(
        one.agent.agentId, one.agent.name, `${memberState(one)} · ${origin} · ${one.delegation?.scope ?? one.agent.role}`,
      )
    })
}

/** 协作消息的正文行——按来源标识，并入会话正文（不再有单独讨论入口）。 */
export function messageRows(snapshot: CollaborationView | undefined, messages: readonly AgentMessage[]): readonly {
  readonly key: string; readonly lines: readonly string[]
}[] {
  const purpose: Record<AgentMessage['purpose'], string> = { inform: '告知', question: '提问', reply: '回复', delegation: '委派', clarification: '澄清', delivery: '交付', receipt: '收悉', constraint: '用户共同要求', decision: '决定' }
  return messages.map((message) => ({
    key: `am:${message.messageId}`,
    lines: [
      `${message.userSource === undefined ? snapshot?.members.find((one) => one.agent.agentId === message.senderId)?.agent.name ?? '协作成员' : '用户'} · ${purpose[message.purpose]}${message.withdrawn ? '（已撤回）' : ''}`,
      ...message.body.flatMap((part) => part.kind === 'text' ? part.text.split('\n').map(sanitizeForDisplay)
        : part.kind === 'entry' ? [`记录引用：${part.label ?? part.ref.sessionId} #${part.ref.entryId}`] : ['附件引用（正文未展开）']),
    ],
  }))
}

