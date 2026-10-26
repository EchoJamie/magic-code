import type { Command, KernelEvent, Knowledge, EventDataOf, MemoryItem, MemorySourceRead } from '@magic/contracts'
import type { Picker, PickerRow } from './view.ts'
import type { DraftRef } from './components/inline.ts'

export type MemoryPage = {
  readonly session?: string
  readonly mode: 'work' | 'knowledge' | 'item' | 'source' | 'forget'
  readonly request?: string
  readonly focus?: string
  readonly item?: MemoryItem
  readonly knowledge?: Knowledge
  readonly references?: EventDataOf['memory.state']['references']
  readonly reference?: NonNullable<EventDataOf['memory.state']['references']>[number]
  readonly items?: readonly MemoryItem[]
  readonly knowledgeItems?: readonly Knowledge[]
  readonly next?: number
  readonly source?: Omit<MemorySourceRead, 'type' | 'requestId'>
  readonly forget?: Extract<Command, { type: 'knowledge.forget' | 'knowledge.forget-result' }>
}
const row = (value: string, label: string, meta = ''): PickerRow => ({ value, label, meta, current: false })
const evidence = { fact: '事实', hypothesis: '假设', unresolved: '未决' }
const progress = { pending: '待进行', in_progress: '进行中', completed: '已完成' }
const materialKind: Record<string, string> = { user: '用户', assistant: '助手', 'tool-call': '工具调用', 'tool-result': '工具结果', 'agent-message': '协作消息', summary: '会话摘要', 'system-notice': '系统通知' }
const materialSpeaker = (speaker: string) => materialKind[speaker] ?? (speaker.startsWith('agent:') ? `协作成员 ${speaker.slice(6)}` : speaker)
const state = { active: '有效', resolved: '已解决', invalid: '失效', pending: '待确认', forgotten: '已遗忘' }
const scope = (item: Knowledge) => item.scope.kind === 'user' ? '用户通用' : `项目：${item.scope.workspace.join(' · ') || '无工作区'}`

/** 阅读层只保留已读投影与操作身份；数据和修订仍来自 Engine。 */
export function createMemoryPicker(ui: {
  readonly picker: Picker | null
  readonly session: string | null
  readonly archived: boolean
  present(picker: Picker): void
  push(): void
  back(): void
  correct(ref: Omit<Extract<DraftRef, { kind: 'memory' }>, 'start' | 'end'>): void
  send(command: Command): void
}) {
  const pendingForgets = new Map<string, MemoryPage>()
  const pendingRows = (session: string | undefined) => [...pendingForgets].filter(([, page]) => page.session === session)
    .map(([request, page]) => row(`pending-forget:${request}`, `查询遗忘结果：${page.knowledge?.topic ?? ''}`, '沿原请求查询，不重复提交'))
  const show = (page: MemoryPage, rows: readonly PickerRow[], options: Partial<Picker> = {}) => ui.present({ source: 'memory', memory: page, title: '记忆 · 只读查看', rows, selected: page.focus === undefined ? 0 : rows.findIndex(row => row.value === page.focus), hint: 'Enter 查看 · Esc 返回', ...options })
  const query = (page: MemoryPage, text = '', offset?: number) => {
    const requestId = crypto.randomUUID()
    const previous = ui.picker
    show({ ...page, request: requestId, focus: offset === undefined && previous?.memory?.mode === page.mode && (previous.filter ?? '') === text ? previous.rows[previous.selected]?.value : undefined }, previous?.memory?.mode === page.mode ? previous.rows : [row('refresh', '重新读取')], { title: page.mode === 'knowledge' ? '适用知识 · 输入关键词筛选' : '工作记忆', filter: page.mode === 'knowledge' ? text : undefined, hint: '正在读取 · Esc 返回', selected: previous?.selected ?? 0 })
    ui.send(page.mode === 'knowledge' ? { type: 'knowledge.query', requestId, session: page.session, query: { query: text, offset } } : { type: 'memory.read', requestId, session: page.session })
  }
  const open = () => query({ mode: ui.session === null ? 'knowledge' : 'work', ...(ui.session === null ? {} : { session: ui.session }) })
  const detail = (page: MemoryPage) => {
    const item = page.knowledge ?? page.item
    if (!item) return
    const knowledge = page.knowledge
    const lines = knowledge ? [knowledge.conclusion, `适用条件：${knowledge.conditions}`, `范围：${scope(knowledge)}`] : [page.item!.text, page.item!.detail ?? '', page.item!.scope ?? '', ...(page.item!.progress ? [`进展：${progress[page.item!.progress]}`] : [])]
    show({ ...page, mode: 'item', request: undefined }, [
      ...(!ui.archived ? [row('correct', '纠正这条', '加入普通交代草稿，尚不发送')] : []),
      ...(knowledge ? [row('forget', '忘记这条', '需要明确确认')] : []),
      ...item.sources.map((source, index) => row(`source:${index}`, `来源 ${index + 1}`, `${source.session} · 记录 ${source.entry}${source.part === undefined ? '' : ` · 段 ${source.part}`}`)),
      row('back', '返回'),
    ], { title: knowledge?.topic ?? '工作事项', detail: [...lines.filter(Boolean), `${evidence[item.evidence]} · ${state[item.status]} · 修订 ${item.revision}`, `对象 ${item.id}`] })
  }
  const source = (page: MemoryPage, request: NonNullable<MemoryPage['source']>) => {
    const requestId = crypto.randomUUID()
    show({ ...page, mode: 'source', source: request, request: requestId }, [row('retry-source', '重新读取'), row('back', '返回')], { title: '来源原文', hint: '正在读取 · Esc 返回', detail: ui.picker?.memory?.mode === 'source' ? ui.picker.detail : undefined })
    ui.send({ type: 'memory.source', requestId, ...request })
  }
  const confirm = (page: MemoryPage) => {
    const knowledge = page.knowledge!
    show({ ...page, mode: 'forget', request: undefined, forget: undefined }, [row('back', '返回'), row('confirm-forget', '确认忘记这条')], { title: '忘记所选知识', detail: [knowledge.topic, scope(knowledge), knowledge.conclusion, `修订 ${knowledge.revision}`, '退出后续使用并失效依赖；原始对话和来源不删除。'], hint: '默认返回 · 仅确认后执行' })
  }
  return {
    open,
    filter(text: string) { const page = ui.picker?.memory; if (page?.mode === 'knowledge') query(page, text) },
    select(value: string): void {
      const picker = ui.picker, page = picker?.memory
      if (!picker || !page) return
      if (value.startsWith('pending-forget:')) {
        const pending = pendingForgets.get(value.slice(15))
        if (pending?.forget) { ui.push(); show(pending, [row('check-forget', '查询原请求结果'), row('back', '返回')], { title: '遗忘结果尚未确认', detail: [pending.knowledge?.topic ?? ''] }); ui.send({ ...pending.forget, type: 'knowledge.forget-result' }) }
        return
      }
      if (value === 'back') { ui.back(); return }
      if (value === 'knowledge') { ui.push(); query({ session: page.session, mode: 'knowledge' }); return }
      if (value === 'refresh') { query(page, picker.filter); return }
      if (value === 'more') { ui.push(); query(page, picker.filter, page.next); return }
      if (value.startsWith('reference:')) {
        const reference = page.references?.[Number(value.slice(10))]
        if (reference) { ui.push(); show({ ...page, mode: 'item', reference }, [
          ...reference.sources.map((source, index) => row(`reference-source:${index}`, `记录 ${source.entry}`, source.session)), row('back', '返回'),
        ], { title: reference.title, detail: [`固定读取到记录 ${reference.through}；最近材料入口，原说话人身份保持不变。`, `来源会话 ${reference.source}`] }) }
        return
      }
      if (value.startsWith('reference-source:') && page.reference) {
        const entry = page.reference.sources[Number(value.slice(17))]
        if (entry) { ui.push(); source(page, { session: page.session, inputRef: page.reference.inputRef, source: entry }) }
        return
      }
      if (value.startsWith('item:')) {
        const id = value.slice(5), item = page.items?.find(one => one.id === id), knowledge = page.knowledgeItems?.find(one => one.id === id)
        if (item || knowledge) { ui.push(); detail({ session: page.session, mode: 'item', item, knowledge }) }
        return
      }
      if (value === 'correct') {
        const item = page.knowledge ?? page.item
        if (!item) return
        ui.correct({ kind: 'memory', source: item.id, scope: page.knowledge?.scope ?? { kind: 'session', session: page.session! }, revision: item.revision, marker: `@纠正[${page.knowledge?.topic ?? page.item!.text.slice(0, 30)}]` })
        return
      }
      if (value === 'forget') { ui.push(); confirm(page); return }
      if (value === 'review-forget') { confirm(page); return }
      if (value === 'confirm-forget' && page.knowledge) {
        const command = { type: 'knowledge.forget' as const, requestId: crypto.randomUUID(), session: page.session, id: page.knowledge.id, scope: page.knowledge.scope, expectedRevision: page.knowledge.revision }
        const pending = { ...page, request: command.requestId, forget: command }
        pendingForgets.set(command.requestId, pending)
        show(pending, [row('check-forget', '查询原请求结果'), row('back', '返回')], { title: '遗忘处理中', detail: picker.detail })
        ui.send(command); return
      }
      if (value === 'check-forget' && page.forget) { ui.send({ ...page.forget, type: 'knowledge.forget-result' }); return }
      if (value.startsWith('source:')) {
        const entry = (page.knowledge ?? page.item)?.sources[Number(value.slice(7))]
        if (entry) { ui.push(); source(page, { session: page.session, source: entry, ...(page.knowledge ? { knowledge: page.knowledge.id } : { item: page.item!.id }) }) }
        return
      }
      if (value === 'retry-source' && page.source) source(page, page.source)
      if (value === 'next-source' && page.source && page.next !== undefined) { ui.push(); source(page, { ...page.source, source: { ...page.source.source, offset: page.next } }) }
    },
    receive(event: KernelEvent): boolean {
      if (event.kind === 'knowledge.forgotten' && ['completed', 'changed'].includes(event.data.result?.status ?? '')) pendingForgets.delete(event.data.requestId)
      const picker = ui.picker, page = picker?.memory
      if (!picker || !page || !['memory.state', 'memory.source', 'knowledge.state', 'knowledge.forgotten'].includes(event.kind)) return false
      if (!('requestId' in event.data) || event.data.requestId !== page.request) return false
      if ('error' in event.data && event.data.error) { ui.present({ ...picker, hint: `读取失败：${event.data.error} · 已保留已读内容` }); return true }
      if (event.kind === 'memory.state') {
        const items = event.data.memory?.items ?? []
        show({ ...page, items, references: event.data.references }, [...pendingRows(page.session), ...items.map(item => row(`item:${item.id}`, item.text, `${evidence[item.evidence]} · ${state[item.status]}`)), ...(event.data.references ?? []).map((ref, index) => row(`reference:${index}`, ref.title, `已受理引用 · 截至记录 ${ref.through}`)), row('knowledge', '适用知识'), row('refresh', '刷新')], { title: '工作记忆', hint: `${items.length === 0 ? '尚无已整理事项 · ' : ''}${event.data.unprocessed ? '有尚未整理的新内容 · ' : ''}Esc 返回` })
      } else if (event.kind === 'knowledge.state' && event.data.page) {
        const items = event.data.page.items
        show({ ...page, knowledgeItems: items, next: event.data.page.next }, [...pendingRows(page.session), ...items.map(item => row(`item:${item.id}`, item.topic, `${scope(item)} · ${state[item.status]}`)), ...(event.data.page.next === undefined ? [] : [row('more', '下一页')]), row('refresh', '刷新')], { title: '适用知识 · 输入关键词筛选', filter: picker.filter ?? '', filterCaret: picker.filterCaret, hint: items.length === 0 ? (picker.filter ? '没有匹配知识 · Esc 返回' : '尚无适用知识 · Esc 返回') : 'Enter 查看 · Esc 返回' })
      } else if (event.kind === 'memory.source' && event.data.page) {
        const material = event.data.page
        show({ ...page, next: material.next }, [...(material.next === undefined ? [] : [row('next-source', '继续阅读')]), row('retry-source', '重新读取'), row('back', '返回')], { title: `来源 · ${[...new Set([materialSpeaker(material.speaker), materialKind[material.kind] ?? material.kind])].join(' · ')}`, detail: [material.text], hint: `${material.complete ? '材料已读至末尾' : '当前为节选，可继续阅读'} · PgUp/PgDn 滚动 · Esc 返回` })
      } else if (event.kind === 'knowledge.forgotten') {
        const result = event.data.result
        if (result?.status === 'completed') {
          ui.back()
          if (ui.picker?.memory?.mode === 'item') ui.back()
          const list = ui.picker
          if (list?.memory?.mode === 'knowledge' || list?.memory?.mode === 'work') {
            const rows = list.rows.filter(row => row.value !== `pending-forget:${event.data.requestId}` && (list.memory?.mode !== 'knowledge' || row.value !== `item:${page.knowledge?.id}`))
            ui.present({ ...list, memory: { ...list.memory, knowledgeItems: list.memory.knowledgeItems?.filter(item => item.id !== page.knowledge?.id) }, rows, selected: Math.min(list.selected, Math.max(0, rows.length - 1)), hint: '已忘记所选知识；原始对话与来源保留。' })
          }
        }
        else if (result?.status === 'changed' && result.current) show({ ...page, knowledge: result.current }, [row('back', '返回'), row('review-forget', '查看新版并重新确认')], { title: '对象已改变，本次未遗忘', detail: [result.current.conclusion, `当前修订 ${result.current.revision}`] })
        else ui.present({ ...picker, hint: result?.status === 'processing' ? '原请求仍在处理中' : '结果尚未确认；请查询原请求，不要重复提交' })
      }
      return true
    },
    reconnected(): void { for (const page of pendingForgets.values()) if (page.forget) ui.send({ ...page.forget, type: 'knowledge.forget-result' }) },
    disconnected(): void { const picker = ui.picker; if (picker?.source === 'memory') ui.present({ ...picker, hint: '连接已断开；已读内容可能过期。恢复连接后可刷新或查询原请求。' }) },
  }
}
