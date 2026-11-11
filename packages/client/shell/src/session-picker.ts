import type { Command, SessionId } from '@magic/contracts'
import type { Picker, PickerRow, ShellView } from './view.ts'
import { STOP_KEYS_HINT } from './view.ts'
import { inActiveSection, runDetail, sessionHint, sessionRows, type SessionScope } from './view/sessions.ts'

type SessionPicker = Picker & { readonly source: 'session' }

/** 会话目录的筛选与焦点；归档事实仍取自控制协议。 */
export function createSessionPicker(ui: {
  readonly view: Pick<ShellView, 'catalog' | 'runs' | 'sessionId' | 'collaboration'>
  readonly picker: SessionPicker | null
  readonly workspaceRoots?: readonly string[]
  present: (picker: SessionPicker) => void
  notify: (message: string) => void
  send: (command: Command) => void
}) {
  const { present, notify, send } = ui
  let sessionScope: SessionScope = 'all'
  let sessionQuery = ''
  let sessionArchived = false
  let sessionFocus: string | undefined
  const sessionPositions = new Map<boolean, { id?: string; selected: number; detailTop?: number }>()

  const querySessions = (): void => {
    notify('正在读取会话目录…')
    send({ type: 'session.list', archived: sessionArchived })
  }

  /** 那一屏的行（**一处算**——开、筛、运行事实变了这三条路都走它）。 */
  const sessionPickerRows = (): readonly PickerRow[] =>
    sessionRows({
      catalog: ui.view.catalog
        .filter(session => session.archived === sessionArchived)
        .filter((session) =>
          session.id === ui.view.collaboration?.originSession ||
          !ui.view.collaboration?.members.some((one) => one.agent.sessionId === session.id)),
      active: ui.view.sessionId,
      here: ui.workspaceRoots,
      runs: ui.view.runs.filter((run) =>
        run.session === ui.view.collaboration?.originSession ||
        !ui.view.collaboration?.members.some((one) => one.agent.sessionId === run.session)),
      scope: sessionScope,
      query: sessionQuery,
    })

  const sessionPickerHint = (rows: readonly PickerRow[]): string | undefined => {
    const selected = rows[ui.picker?.selected ?? 0]
    const run = selected === undefined ? undefined : ui.view.runs.find((one) => one.session === selected.value)
    // 两件**各说各的**，故都在：筛的是什么（筛词）与**这一屏收窄到哪儿**（范围）。
    // 只说一半的话，用户看着一张短表不知道另一半去哪了（收窄的那一条最常见）
    const head = [
      sessionQuery === '' ? '' : `筛选「${sessionQuery}」`,
      `${sessionArchived ? '已归档' : '普通'} · ${sessionScope === 'here' ? '本工作区' : '全部工作区'} · Tab 换范围 · Shift+Tab 换视图`,
      ui.view.collaboration?.collaboration !== undefined && selected?.value === ui.view.sessionId ? '→ 查看本次协作' : '',
    ]
      .filter((piece) => piece !== '')
      .join(' · ')
    if (run !== undefined) {
      // 活跃那一段里，状态与动作都已经在「组头 ＋ 副文案」上了——详情只补别处没说过的
      const detail = runDetail(run, Date.now(), { inActiveSection: inActiveSection(run.state) })
      const actions = inActiveSection(run.state) ? STOP_KEYS_HINT : ''
      return [head, detail, actions].filter((piece) => piece !== '').join(' · ')
    }
    const tail =
      rows.length === 0
        ? ui.view.catalog.length === 0 ? '工作目录为空——交代一句就开张' : sessionQuery !== '' ? '没有名称匹配——修改筛词' : '本范围没有工作——Tab 切换范围'
        : sessionHint(ui.view.catalog, ui.workspaceRoots)
    const said = [head, tail].filter((piece) => piece !== undefined && piece !== '').join(' · ')
    // **一句都没有就不给这一格**（`undefined`，不是空串）：空串会照样占一行
    // ——屏上凭空多一条空白（真帧上量出来的）
    return said === '' ? undefined : said
  }

  /** `/resume`——目录已到手，开它（行：活跃在前、再按工作区分组，见 `sessionRows`）。 */
  const openSessionPicker = (): void => {
    // **开一屏就是一屏新的**：筛词与范围从零起（它们是「我这一次要找哪一条」的临时状态，
    // 不是一条该被记住的偏好——下次打开时用户要的是全貌，而全貌第一条正是「需要你」）
    sessionScope = 'all'
    sessionQuery = ''
    sessionArchived = false
    sessionPositions.clear()
    sessionFocus = undefined
    const rows = sessionPickerRows()
    const hint = sessionPickerHint(rows)
    present({
      source: 'session',
      title: sessionArchived ? '已归档 · Enter 查看记录' : '普通 · Enter 接回',
      // 选中项＝**当前那条**——分组之后行序变了，故在**分好组的行**里找它。
      // 空列表仍保留范围、筛词与返回入口。
      selected: Math.max(0, rows.findIndex((row) => row.value === ui.view.sessionId)),
      rows,
      filter: sessionQuery,
      ...(hint === undefined ? {} : { hint }),
    })
  }

  const refreshSessionPicker = (): void => {
    const picker = ui.picker
    if (picker === null) return
    const rows = sessionPickerRows()
    const keep = sessionFocus ?? picker.rows[picker.selected]?.value
    const found = rows.findIndex((row) => row.value === keep)
    if (found !== -1) sessionFocus = undefined
    const hint = sessionPickerHint(rows)
    present({
      ...picker,
      source: 'session',
      title: sessionArchived ? '已归档 · Enter 查看记录' : '普通 · Enter 接回',
      rows,
      selected: found === -1 ? Math.min(picker.selected, Math.max(0, rows.length - 1)) : found,
      filter: sessionQuery,
      ...(hint === undefined ? {} : { hint }),
    })
  }

  const toggleArchived = (): void => {
    const picker = ui.picker
    if (picker === null) return
    sessionPositions.set(sessionArchived, { id: picker.rows[picker.selected]?.value, selected: picker.selected, detailTop: picker.detailTop })
    sessionArchived = !sessionArchived
    const position = sessionPositions.get(sessionArchived)
    sessionFocus = position?.id
    present({ ...picker, selected: position?.selected ?? 0, detailTop: position?.detailTop ?? 0 })
    refreshSessionPicker()
    querySessions()
  }
  return {
    get archived() { return sessionArchived },
    ordinary: () => { sessionArchived = false },
    restored: (session: SessionId) => {
      sessionArchived = false
      sessionFocus = session
    },
    open: openSessionPicker,
    refresh: refreshSessionPicker,
    query: querySessions,
    filter: (query: string) => {
      sessionQuery = query
      refreshSessionPicker()
    },
    toggleScope: () => {
      sessionScope = sessionScope === 'all' ? 'here' : 'all'
      refreshSessionPicker()
    },
    toggleArchived,
  }
}
