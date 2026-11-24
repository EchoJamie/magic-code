import type { AgentMessage, CollaborationMemberView, CollaborationView, Delegation, SessionId } from '@magic/contracts'
import { sanitizeForDisplay } from '@magic/contracts'
import { MARKS } from './marks.ts'
import type { PickerRow, ShellStatus, ShellView } from '../../view.ts'

const clean = (text: string): string => sanitizeForDisplay(text).replace(/\s+/g, ' ').trim()
export const collaborationRow = (value: string, label: string, meta = '', tone?: PickerRow['tone']): PickerRow => ({
  value, label: clean(label), meta: clean(meta), current: false, oneLine: true,
  ...(tone === undefined ? {} : { tone }),
})
/**
 * **工作那两屏的页签**（`Tab` 在「协作 ↔ 后台命令」之间切）——两屏同构，当前那一段铺反白块。
 *
 * 为什么收在一处：两屏的页签**必须是同一副样子**，否则按 Tab 时整行跳变（改造前就是这样：
 * 一屏叫 `[协作] 整件工作 · 子会话`，另一屏叫 `协作成员  │  [后台命令]`，方括号还落在不同位置）。
 */
export const workTabs = (active: 'collaboration' | 'background'): readonly { readonly label: string; readonly active: boolean }[] => [
  { label: '协作', active: active === 'collaboration' },
  { label: '后台命令', active: active === 'background' },
]
const delegationState: Record<Delegation['state'], string> = {
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
  if (member.delegation?.state === 'clarification') return `需要澄清：${member.delegation.reason ?? member.delegation.scope}`
  if (member.runtime?.backgroundWaiting) return '等待后台结果'
  if (member.runtime?.state === 'running') return member.runtime.action ?? '执行中'
  if (member.runtime?.state === 'unknown') return '运行情况待核实'
  if (member.runtime?.state === 'stopped') return `已停止${member.runtime.reason ? `：${member.runtime.reason}` : ''}`
  if (member.runtime?.lastTurn === 'error') return '上一轮出错，待处理'
  if (member.delegation !== undefined) return `${delegationState[member.delegation.state]}${member.delegation.reason ? `：${member.delegation.reason}` : ''}`
  return member.agent.reachability === 'historical' ? '记录可查看' : '当前空闲'
}

/**
 * 成员行的**记号**——取自 marks.ts 的额定语义位，不造新形：
 *
 * | 成员状态 | 记号 | 额定语义 |
 * | --- | --- | --- |
 * | 执行中 / 等结果 / 等后台 / 停止中 | `●` | 进行中 |
 * | 待审批 / 待澄清 | `◊` | 要你定夺 |
 * | 出错 / 执行中断 | `▲` | 出错 |
 * | 失联待核实 | `■` | 放弃判断 |
 * | 已停止 / 等待超时 | `!` | 没跑成·要你再看一眼 |
 * | 已回报 / 已收下 | `✓` | 成 |
 * | 已拒绝 / 已撤回 | `×` | 败·没跑成 |
 * | 空闲 / 待接下 / 记录 | `○` | 手上没活 |
 *
 * `✓×!` 的额定位置在工具行行尾；成员面板的状态格是**同语义的新位置**（像 `●` 的
 * 跨位先例：说的是同一件事）。裁定记录随实现补进 marks.ts。
 */
function memberMark(member: CollaborationMemberView): string {
  if (consultationEnded(member)) return member.delegation?.state === 'cancelled' ? MARKS.fail : MARKS.ok
  if (member.pendingDecisions > 0) return MARKS.ring
  if (member.runtime?.state === 'stopping') return MARKS.dot
  if (member.agent.reachability === 'suspended') return MARKS.error
  if (member.delegation?.state === 'clarification') return MARKS.ring
  if (member.runtime?.backgroundWaiting) return MARKS.dot
  if (member.runtime?.state === 'running') return MARKS.dot
  if (member.runtime?.state === 'unknown') return MARKS.unknown
  if (member.runtime?.state === 'stopped') return MARKS.warn
  if (member.runtime?.lastTurn === 'error') return MARKS.error
  if (member.delegation !== undefined) {
    switch (member.delegation.state) {
      case 'rejected': case 'cancelled': return MARKS.fail
      case 'delivered': case 'received': return MARKS.ok
      default: return MARKS.idle
    }
  }
  return MARKS.idle
}

/**
 * **成员那一行的语义色**（面板式里才用）——与 `memberState` 同一套先后：先报「要你」，
 * 再报「停了 / 断了」，最后才是「在跑」。
 *
 * 它只管**颜色与那个状态位**，不改任何文案：屏上说的话仍旧出自 `memberState` 一处。
 */
function memberTone(member: CollaborationMemberView): 'run' | 'wait' | 'danger' | 'idle' {
  if (consultationEnded(member)) return 'idle'
  if (member.pendingDecisions > 0) return 'wait'
  if (member.runtime?.state === 'stopping') return 'run'
  if (member.agent.reachability === 'suspended') return 'danger'
  if (member.delegation?.state === 'clarification') return 'wait'
  if (member.runtime?.backgroundWaiting) return 'run'
  if (member.runtime?.state === 'running') return 'run'
  if (member.runtime?.state === 'unknown') return 'danger'
  if (member.runtime?.state === 'stopped') return 'danger'
  if (member.runtime?.lastTurn === 'error') return 'danger'
  if (member.delegation?.state === 'rejected') return 'wait'
  return 'idle'
}

export function collaborationSummary(snapshot: CollaborationView | undefined): string | undefined {
  if (snapshot?.collaboration === undefined) return undefined
  if (snapshot.members.length <= 1 && snapshot.delegations.length === 0) return undefined
  const consultationOnly = snapshot.members.filter(one => one.agent.agentId !== snapshot.collaboration?.coordinatorId).every(one => one.agent.purpose === 'consultation')
  const label = consultationOnly ? '咨询 Arcane' : '协作'
  const state = snapshot.collaboration.state
  if (state === 'closed') return `${label} · 已收尾，结果可查看`
  const members = snapshot.members.filter(one => !consultationEnded(one) && one.agent.reachability !== 'historical')
  const running = members.filter((one) => one.runtime?.state === 'running' && !one.runtime.backgroundWaiting && (!one.runtime.background || one.runtime.action !== undefined)).length
  const needs = members.filter((one) => one.pendingDecisions > 0 || one.delegation?.state === 'clarification')
  const waiting = members.filter((one) => one.runtime?.backgroundWaiting).length
  const stopping = members.some((one) => one.runtime?.state === 'stopping')
  const blocked = members.filter((one) => (one.agent.reachability === 'suspended' && one.delegation?.state !== 'cancelled') || one.runtime?.state === 'unknown' || one.runtime?.lastTurn === 'error' || one.delegation?.state === 'rejected')
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
  return [...background, summary, clean(`输入给：当前会话${tabHint}`)]
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
  if (members.some((member) => (member.runtime?.state === 'running' && !member.runtime.backgroundWaiting && (!member.runtime.background || member.runtime.action !== undefined)) || member.runtime?.state === 'stopping')) {
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
/**
 * 成员行——**Claude 式左流**：记号（色随状态）＋ 名字 ＋ 一段**内容**。
 *
 * 内容 ＝ 动作 / 原因 / 范围 / 数量——**不含状态词**：状态由记号与色说（●在跑
 * ◊要你 ▲坏了 !没跑成 ✓成了 ×没成 ○没活），行文不重复记号已经说过的话
 * （2026-11-22 用户裁定：尽量少用状态词汇，不要文字状态描述）。
 */
export function memberRows(snapshot: CollaborationView, currentSession?: SessionId | null): readonly PickerRow[] {
  const priority = (member: CollaborationMemberView): number => member.pendingDecisions > 0 ? 0 : member.delegation?.state === 'clarification' ? 1 : 2
  return [...snapshot.members]
    .filter((one) => currentSession == null || one.agent.sessionId !== currentSession)
    .sort((a, b) => priority(a) - priority(b))
    .map((one) => {
      const mark = memberMark(one)
      const content = memberContent(one)
      return {
        value: one.agent.agentId,
        label: content === '' ? one.agent.name : `${one.agent.name} · ${content}`,
        meta: '', current: false, oneLine: true,
        mark, tone: memberTone(one),
      }
    })
}

/** 行上「·」后面那一段——**只放内容**：它正在干什么 / 为什么停 / 哪条范围。 */
function memberContent(member: CollaborationMemberView): string {
  if (consultationEnded(member)) {
    if (member.delegation?.state === 'cancelled') return member.delegation.reason ?? ''
    return member.delegation?.scope ?? ''
  }
  if (member.pendingDecisions > 0) return member.runtime?.action ?? `${member.pendingDecisions} 项`
  if (member.agent.reachability === 'suspended') return ''
  if (member.delegation?.state === 'clarification') return member.delegation.reason ?? member.delegation.scope
  if (member.runtime?.backgroundWaiting) return `后台 ${member.runtime.background ?? 0} 个`
  if (member.runtime?.state === 'running') return member.runtime.action ?? member.delegation?.scope ?? ''
  if (member.runtime?.state === 'stopped') return member.runtime.reason ?? ''
  if (member.delegation !== undefined) {
    switch (member.delegation.state) {
      case 'rejected': return member.delegation.reason ?? ''
      case 'cancelled': return member.delegation.reason ?? ''
      case 'delivered': case 'received': return member.delegation.scope
      default: return ''
    }
  }
  return ''
}

/** 协作消息并入正文——**信封式**：谁 · 什么 · 首行摘要 · 共几行；收悉回执不上屏。 */
export function messageRows(snapshot: CollaborationView | undefined, messages: readonly AgentMessage[]): readonly {
  readonly key: string; readonly lines: readonly string[]
}[] {
  const purpose: Record<AgentMessage['purpose'], string> = { inform: '告知', question: '提问', reply: '回复', delegation: '委派', clarification: '澄清', delivery: '交付', receipt: '收悉', constraint: '用户共同要求', decision: '决定' }
  return messages.flatMap((message) => {
    // 收悉是协议回执（「accept」一声），对人不带信息——罗列它就是把流水当正文。
    if (message.purpose === 'receipt') return []
    const bodyLines = message.body.flatMap((part) => part.kind === 'text' ? part.text.split('\n').map(sanitizeForDisplay)
      : part.kind === 'entry' ? [`记录引用：${part.label ?? part.ref.sessionId} #${part.ref.entryId}`] : ['附件引用（正文未展开）'])
    const sender = message.userSource === undefined ? snapshot?.members.find((one) => one.agent.agentId === message.senderId)?.agent.name ?? '协作成员' : '用户'
    const first = bodyLines.find(line => line.trim() !== '') ?? ''
    const preview = first.length > 48 ? `${first.slice(0, 48)}…` : first
    const parts = [
      `${sender} · ${purpose[message.purpose]}${message.withdrawn ? '（已撤回）' : ''}`,
      ...(preview === '' ? [] : [preview]),
      ...(bodyLines.length > 1 ? [`全文 ${bodyLines.length} 行`] : []),
    ]
    return [{ key: `am:${message.messageId}`, lines: [clean(parts.join(' · '))] }]
  })
}

