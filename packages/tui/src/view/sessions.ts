import type { RunRow, RunState, SessionId, SessionSummary } from '@magic/contracts'
import type { PickerRow } from '../view.ts'
import { clockLabel, elapsedLabel } from './time.ts'
// ══ 选择器（`/resume` · `/model`）════════════════════════════════════

export type SessionScope = 'all' | 'here'

export type SessionListInput = {
  readonly catalog: readonly SessionSummary[]
  readonly active: SessionId | null
  readonly here?: readonly string[] | undefined

  /** 运行事实（管理者推来的那一份）——按会话对号入座。 */
  readonly runs: readonly RunRow[]
  readonly scope: SessionScope
  readonly query: string
}

/**
 * 活跃那几段的**次序**（需要你在最前）——设计那一句「先显示『需要你』和『执行中』」。
 *
 * `stopped` / `idle` 不在这一列：它们说的是**没在跑**的会话，归历史那一段（不然
 * 「历史」两个字就没有着落了——每一条会话都曾经跑过）。
 */
const ACTIVE_ORDER: readonly RunState[] = ['waiting', 'running', 'stopping', 'unknown']

/** 活跃那几段的头——**动作口吻**（那一段要回答的是「我得做什么」）。 */
const ACTIVE_HEAD: Readonly<Record<string, string>> = {
  waiting: '需要你',
  running: '执行中',
  stopping: '正在收尾',
  unknown: '状态待确认',
}

/**
 * 这一行归**活跃那一段**吗（需要你 / 执行中 / 收尾中 / 待确认）——列表与详情据此分工：
 * 活跃那一段的行**副文案写的是动作**，故它那一行不需要详情再念一遍动作。
 */
export function inActiveSection(state: RunState): boolean {
  return ACTIVE_ORDER.includes(state)
}

/** 六行状态的字面——**列表与详情念的是这一份**（设计那张表左栏的词）。 */
export function runStateLabel(state: RunState): string {
  switch (state) {
    case 'running':
      return '执行中'
    case 'waiting':
      return '等待你'
    case 'stopping':
      return '停止中'
    case 'stopped':
      return '已停止'
    case 'idle':
      return '当前空闲'
    case 'unknown':
      return '状态待确认'
  }
}

export function runSummary(rows: readonly RunRow[], opening?: string): string | undefined {

  const others = rows.filter((row) => row.session !== opening)

  const count = (state: RunState): number => others.filter((row) => row.state === state).length
  const said: string[] = []
  if (count('waiting') > 0) said.push(`${count('waiting')} 项需要你`)
  if (count('running') > 0) said.push(`${count('running')} 项执行中`)
  if (count('stopping') > 0) said.push(`${count('stopping')} 项正在收尾`)
  if (count('unknown') > 0) said.push(`${count('unknown')} 项状态待确认`)
  return said.length === 0 ? undefined : `${said.join(' · ')} —— /resume 看它们`
}

/** 工作区的一眼分辨（末一段路径）——**别的项目**的行在副文案里点名它。 */
function shortWorkspace(workspace: readonly string[]): string {
  const first = workspace[0] ?? ''

  const parts = first.split('/').filter((part) => part !== '')
  return parts[parts.length - 1] ?? first
}

/** 这一条的运行事实（没有就是没有——**不编**）。 */
function runOf(runs: readonly RunRow[], session: SessionId): RunRow | undefined {
  return runs.find((row) => row.session === session)
}

/** 活跃组已显示状态，副文案只补当前动作与不同工作区。 */
function activeMeta(row: RunRow, elsewhere: boolean): string {
  const what = row.action ?? row.progress?.what ?? ''
  const where = elsewhere ? shortWorkspace(row.workspace) : ''
  return [what, where].filter(piece => piece !== '').join(' · ')
}

function sessionDetails(session: SessionSummary): readonly string[] {
  return [`会话：${session.title ?? '（无标题）'}`, `状态：${session.archived ? '已归档' : session.terminalOpen ? '终端已打开' : '普通'}`, `工作区：${session.workspace?.join(' · ') ?? '未记录'}`, `最近交代：${session.recentInput ?? '未记录'}`, `进展：${session.recentProgress ?? '未记录'}`]
}

export function sessionRows(input: SessionListInput): readonly PickerRow[] {
  const { catalog, active, here, runs, scope, query } = input
  const mine = here === undefined ? null : identityOf(here)
  const needle = query.trim().toLowerCase()

  const titleOf = (session: SessionSummary): string => session.title ?? '（无标题）'
  const visible = catalog.filter(
    (session) => needle === '' || titleOf(session).toLowerCase().includes(needle),
  )

  const isMine = (session: SessionSummary): boolean =>
    session.workspace !== undefined && mine !== null && identityOf(session.workspace) === mine
  const out: PickerRow[] = []
  const shown = new Set<SessionId>()
  // —— ① 活跃那一段（按状态分组；组内最近的在前）——
  for (const state of ACTIVE_ORDER) {
    const group = visible
      .filter((session) => runOf(runs, session.id)?.state === state)
      // 「只看本工作区」也管这一段（它是一句**范围**，不是「历史那一段的开关」）；
      // 当下这一条**永远留着**——用户正看着它，哪怕它是别的项目的
      .filter((session) => scope === 'all' || isMine(session) || session.id === active)
      .sort((left, right) => (runOf(runs, right.id)?.since ?? 0) - (runOf(runs, left.id)?.since ?? 0))
    for (const session of group) {
      const row = runOf(runs, session.id) as RunRow
      const elsewhere = session.workspace !== undefined && mine !== null && !isMine(session)
      out.push({
        label: titleOf(session),
        meta: [
          activeMeta(row, elsewhere),
          session.id === active ? '正在用' : '',
        ]
          .filter((piece) => piece !== '')
          .join(' · '),
        current: session.id === active,
        value: session.id,
        detail: sessionDetails(session),
        group: ACTIVE_HEAD[state],
        // **一项一行**（设计 · 终端交互：「候选每项一行，名称/简述同排；窄窗先保住名称、
        // 再截断简述」）——窄窗下让**名称**活着，状态/动作被截
        oneLine: true,
      })
      shown.add(session.id)
    }
  }
  // —— ② 历史那几段（按工作区分组，本工作区在前）——

  const rest = visible.filter((session) => !shown.has(session.id))
  const found = new Map<string, Group>()
  const groups: Group[] = []
  for (const session of rest) {
    const key = identityOf(session.workspace)
    let group = found.get(key)
    if (group === undefined) {
      const known = session.workspace !== undefined // 归属记着＝判得实；缺席＝无从判断
      group = {
        head: headOf(session.workspace),
        mine: known && key === mine, // 判得实才算「这儿」
        // 判得实才算「别处」：归属缺席的、以及「不知道自己在哪儿」的，都不压暗
        elsewhere: known && mine !== null && key !== mine,
        rows: [],
      }
      found.set(key, group)
      groups.push(group)
    }
    const row = runOf(runs, session.id)
    group.rows.push({
      label: titleOf(session),
      meta: [row === undefined ? '' : runStateLabel(row.state), session.id === active ? '正在用' : '']
        .filter((piece) => piece !== '')
        .join(' · '),
      current: session.id === active,
      value: session.id,
      detail: sessionDetails(session),
      oneLine: true,
    })
  }
  // 本工作区那组在前，其余照**出现序**（＝目录的序：组里最近一条的时间先后）。
  // 「只看本工作区」⇒ 只留判得实属于这儿的那一组（归属缺席的**不冒充**属于这儿）。

  const ordered = [...groups.filter((group) => group.mine), ...groups.filter((group) => !group.mine)]

  const kept = scope === 'here' ? ordered.filter((group) => group.mine) : ordered
  return [
    ...out,
    ...kept.flatMap((group) =>
      group.rows.map((row) => ({ ...row, group: group.head, faint: group.elsewhere })),
    ),
  ]
}

export function runDetail(
  row: RunRow,
  now: number,
  options: { readonly inActiveSection?: boolean } = {},
): string {
  const said: string[] = []
  const active = options.inActiveSection === true
  // **活跃那一段**：组头就是状态、行的副文案就是动作——详情再念一遍＝同一句话说两遍。
  // 故它从「多久」说起。**历史那一段**没有那两格（组头是工作区、副文案只写状态），
  // 状态与缘由就得由详情带上。
  if (!active) said.push(runStateLabel(row.state))
  if (row.state === 'stopped' && row.reason !== undefined) said.push(row.reason)
  if (row.state !== 'stopped' && row.lastTurn === 'aborted') said.push('上一轮被中断')
  if (row.state !== 'stopped' && row.lastTurn === 'error') said.push('上一轮出错了')
  if (row.background !== undefined) said.push(`还有 ${row.background} 条后台命令在跑`)
  if (row.action !== undefined && !active) said.push(row.action)
  said.push(`已持续 ${elapsedLabel(now - row.since)}`)
  if (row.progress !== undefined) {
    // 有「此刻在做的事」时不再复述进展（那多半就是同一件事的开头）——
    // 详情这一行不是越长越好，**每一截都要说得上它比别处多说了什么**
    if (row.action === undefined) said.push(`最近进展 ${clockLabel(row.progress.at)} ${row.progress.what}`)
  }
  if (row.output !== undefined) {
    const sample = row.output.sample.replace(/\s+/g, ' ').trim()
    said.push(
      sample === ''
        ? `最近输出 ${clockLabel(row.output.at)}`
        : `最近输出 ${clockLabel(row.output.at)} ${sample.length > 48 ? `${sample.slice(-48)}` : sample}`,
    )
  }
  return said.join(' · ')
}

export function sessionHint(
  catalog: readonly SessionSummary[],
  here?: readonly string[],
): string | undefined {
  if (here === undefined || here.length === 0 || catalog.length === 0) return undefined
  const mine = identityOf(here)
  // 判据与分组同一把尺子（`identityOf`）：归属缺席的（列加上之前落账的）不算「这儿」的
  const hasHere = catalog.some(
    (session) => session.workspace !== undefined && identityOf(session.workspace) === mine,
  )
  return hasHere ? undefined : `本工作区：${headOf(here)}`
}

/** 一组（同一个工作区的那些行）——分组头 ＋ 是不是「这儿」/「别处」。 */
type Group = {
  readonly head: string
  readonly mine: boolean
  readonly elsewhere: boolean
  readonly rows: PickerRow[]
}

/**
 * 工作区的**身份**——那组根**照序**序列化（序即语义：`[0]` 是默认根）。
 *
 * 用 JSON 而不是拿个分隔符拼起来：无歧义、**可打印**（`['/a','/b']` 与 `['/a /b']`
 * 不会撞成同一个），且恒以 `[` 开头——与「缺席」那个哨兵永不同形。
 */
function identityOf(workspace?: readonly string[]): string {
  return workspace === undefined ? UNRECORDED : JSON.stringify(workspace)
}

/** 分组头——工作区的路径（多根＝整组报出来，` · ` 隔开）；缺席时如实说「未记录」。 */
function headOf(workspace?: readonly string[]): string {
  return workspace === undefined ? UNRECORDED_HEAD : workspace.join(' · ')
}

/** 归属缺席那一组的键与头（列加上之前落账的会话）——**如实说不知道**，不编。 */
const UNRECORDED = 'unrecorded'
const UNRECORDED_HEAD = '（工作区未记录）'
