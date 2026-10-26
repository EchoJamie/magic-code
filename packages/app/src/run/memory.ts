import type { EventDataOf, MemorySourceRead, SessionReferenceList } from '@magic/contracts'
import { createMaterialReader, readSessionCatalog, substantiveEntries } from '@magic/conversation'
import type { RecordsStore } from '@magic/records'

export async function memoryWorkspace(store: RecordsStore, session: string | undefined, fallback: readonly string[]): Promise<readonly string[]> {
  if (session === undefined) return fallback
  const metadata = (await store.listSessions({ ids: [session] }))[0]
  if (metadata === undefined) throw new Error('会话已不可读取')
  return metadata.workspace ?? []
}

/** TUI 与原生详情共用记录读面；不装配 Agent，也不改变会话归档或提醒状态。 */
export async function readMemory(store: RecordsStore, session: string | undefined, workspace: readonly string[] = []): Promise<Omit<EventDataOf['memory.state'], 'requestId'>> {
  if (session === undefined) return { workspace }
  if (!store.hasSession(session)) throw new Error('会话已不可读取')
  const metadata = (await store.listSessions({ ids: [session] }))[0]
  const memory = store.serviceFor(session).memory.read()
  // 先用完整序列识别内务配对，再切检查边界，避免把边界后的孤立结果误认成业务。
  const entries = await Array.fromAsync(store.readEntries(session))
  const unprocessed = substantiveEntries(entries).some(entry => entry.id > (memory.inspectedThrough ?? 0))
  const references: NonNullable<EventDataOf['memory.state']['references']>[number][] = []
  for (const input of store.serviceFor(session).inputs.list()) {
    if (input.state !== 'consumed' && input.state !== 'included') continue
    for (const ref of input.input.refs ?? []) {
      if (ref.kind !== 'session' || ref.through === undefined) continue
      const entries = await store.readEntriesBack(ref.source, ref.through + 1, 12)
      references.push({ inputRef: input.ref, title: ref.marker, source: ref.source, through: ref.through,
        sources: entries.filter(entry => entry.kind !== 'tool-call').map(entry => ({ session: ref.source, entry: entry.id })) })
    }
  }
  return { session, workspace: metadata?.workspace ?? workspace, memory, unprocessed, references }
}

export async function readMemorySource(store: RecordsStore, command: Omit<MemorySourceRead, 'type' | 'requestId'>): Promise<NonNullable<EventDataOf['memory.source']['page']>> {
  if (command.session !== undefined && !store.hasSession(command.session)) throw new Error('浏览会话已不可读取')
  const records = command.session === undefined ? undefined : store.serviceFor(command.session)
  const source = command.source
  if ([command.item, command.inputRef, command.knowledge].filter(value => value !== undefined).length !== 1) throw new Error('请指定一份明确的来源依据')
  let allowed = false
  if (command.item !== undefined && command.inputRef === undefined) {
    const item = records?.memory.read().items.find(item => item.id === command.item)
    allowed = item?.sources.some(one => one.session === source.session && one.entry === source.entry && one.part === source.part && (source.offset ?? 0) >= (one.offset ?? 0)) === true
  } else if (command.inputRef !== undefined && command.item === undefined) {
    const input = records?.inputs.get(command.inputRef)
    allowed = input?.input.refs?.some(ref => ref.kind === 'session' && ref.source === source.session && ref.through !== undefined && source.entry <= ref.through) === true
  } else if (command.knowledge !== undefined && command.item === undefined && command.inputRef === undefined) {
    const item = store.knowledge.read(command.knowledge)
    allowed = item?.sources.some(one => one.session === source.session && one.entry === source.entry && one.part === source.part && (source.offset ?? 0) >= (one.offset ?? 0)) === true
  }
  if (!allowed) throw new Error('该来源不在所选事项或已受理引用的允许范围内')
  if (!store.hasSession(source.session)) throw new Error('来源会话已不可读取')
  return createMaterialReader({ records: records ?? store.serviceFor(source.session), session: command.session ?? '', allowedSources: [source] })({ ...source, ...(command.limit === undefined ? {} : { limit: command.limit }) })
}

export async function readReferenceSessions(store: RecordsStore, command: SessionReferenceList): Promise<EventDataOf['session.references']> {
  const catalog = await readSessionCatalog(store, undefined, {})
  const needle = command.query.trim().toLocaleLowerCase()
  const matches = catalog.map(session => {
    const agent = store.collaboration.agentForSession(session.id)
    const work = store.collaboration.collaborationForSession(session.id)
    const member = agent === undefined || work === undefined || session.id === work.originSessionId ? undefined : {
      name: agent.name,
      originSession: work.originSessionId,
      originTitle: catalog.find(one => one.id === work.originSessionId)?.title ?? '未命名工作',
    }
    return { ...session, ...(member === undefined ? {} : { member }) }
  }).filter(session => needle === '' || [session.title ?? '', ...(session.workspace ?? []), session.member?.name ?? '', session.member?.originTitle ?? ''].some(value => value.toLocaleLowerCase().includes(needle)))
  const offset = command.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('会话目录分页位置无效')
  const rows = matches.slice(offset, offset + 40)
  return { requestId: command.requestId, query: command.query, offset, rows, ...(offset + rows.length < matches.length ? { next: offset + rows.length } : {}) }
}
