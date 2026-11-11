import type { ModelRequest, ModelGateway, EventStamper, KernelEvent, Entry } from '@magic/contracts'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { createRecordsStore } from '@magic/data'
import { createWorkingNotes, createWorkspaceService, createSandbox } from '@magic/resources'
import { createToolRuntime } from '@magic/tools'
import { createConversationSession } from '@magic/conversation'
import { createStamper } from '@magic/assembly'
import { tempDir, removeDir } from './tmp.ts'
import { join } from 'node:path'

/** 仅驱动真实工具往返的确定性夹具；不能证明真实模型的总结或任务效果。 */
export function continuationTurn(request: ModelRequest, summarize: (text: string, speaker: string) => string = text => text): FauxTurn {
  const system = request.messages[0]
  if (system?.role !== 'system' || typeof system.content !== 'string' || !system.content.startsWith('这是当前模型的独立接续准备')) return { text: '已处理普通输入' }
  const directory = /只维护自身笔记 (.+)，通常/.exec(system.content)![1]!
  const ranges = [...system.content.matchAll(/，记录 (\d+)（[^\n]+?字符 \[(\d+),(\d+)\)/g)].map(match => ({ entry: Number(match[1]), offset: Number(match[2]), end: Number(match[3]) }))
  const results = request.messages.filter(message => message.role === 'tool')
  if (results.some(result => (result.name === 'write' || result.name === 'edit') && result.ok)) return { text: '本段笔记已保存', thinking: '真实保存已确认' }
  if (results.some(result => !result.ok)) return { text: '本段无法完成' }
  const sources = results.filter(result => result.name === 'history_read')
  if (!sources.length) return { thinking: '先取真实材料', toolCalls: [
    ...ranges.map(({ entry, offset }) => ({ name: 'history_read', args: { entry, offset } })),
    { name: 'plan_read', args: {} },
    { name: 'ls', args: { path: directory } },
  ] }
  const path = join(directory, 'MEMORY.md')
  const listing = results.find(result => result.name === 'ls')!
  const reads = results.filter(result => result.name === 'read')
  if (listing.output.includes('MEMORY.md') && !reads.length) return { toolCalls: [{ name: 'read', args: { path } }] }
  const next = reads.length ? /继续读取 offset=(\d+)/.exec(reads.at(-1)!.output) : undefined
  if (next) return { toolCalls: [{ name: 'read', args: { path, offset: Number(next[1]) } }] }
  const prior = reads.map(result => result.output.slice(result.output.indexOf('\n') + 1)).join('')
  let content = prior
  for (const source of sources) {
    const page = JSON.parse(source.output) as { text: string; speaker: string; source: { session: string; entry: number; offset: number } }
    const marker = ` [来源](${page.source.session}#${page.source.entry})`
    const text = summarize(page.text, page.speaker)
    content = page.source.offset > 0 && content.endsWith(marker)
      ? content.slice(0, -marker.length) + text + marker
      : content + (content ? '\n' : '') + `${page.speaker}：${text}${marker}`
  }
  return { toolCalls: [{ name: 'write', args: { path, content } }] }
}

export function notesFixture(options: {
  turn?: (request: ModelRequest, count: number) => FauxTurn
  gateway?: (gateway: ModelGateway) => ModelGateway
  budget?: number
  near?: number
  material?: readonly string[]
} = {}) {
  const dir = tempDir('magic-continuation-'), session = 'work'
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] }), records = store.serviceFor(session)
  for (const [index, text] of (options.material ?? ['用户要求与未验证范围', '已检查输入，焦点未验', '继续核对']).entries()) {
    records.appendEntry({ kind: index % 2 ? 'assistant' : 'user', content: { text }, at: index + 1 })
  }
  const notes = createWorkingNotes(dir, session)
  const stamper: EventStamper = createStamper({ records, session, now: Date.now })
  const events: KernelEvent[] = [], requests: ModelRequest[] = []
  const sink = { emit(event: KernelEvent) { records.appendEvent(event); events.push(event) } }
  const base: ModelGateway = { stream(request, input) {
    requests.push(structuredClone(request))
    const turn = options.turn?.(request, requests.length) ?? continuationTurn(request)
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, input)
  } }
  const gateway = options.gateway?.(base) ?? base
  const workspace = createWorkspaceService({ roots: [dir] }), sandbox = createSandbox({ workspace })
  const toolRuntime = (current = notes) => createToolRuntime({ workspace, sandbox, notes: current,
    gate: { decide: async () => 'reject' }, stamper, sink: { emit() {} }, blobs: records.blobs, trashAvailable: false })
  const service = createConversationSession({ session, records, notes, noteTools: toolRuntime, tools: toolRuntime(), gateway, stamper, sink,
    capacity: () => ({ inputBudget: options.budget ?? 32000, maxOutputTokens: 4096, identity: 'test-current' }),
    context: { nearEntries: options.near ?? 1 }, prompt: { cwd: dir, platform: 'darwin', date: '2026-10-27' } })
  return { dir, session, store, records, notes, service, requests, events, stamper, sink,
    compact: (id = 'compact', signal = new AbortController().signal) => service.compact({ requestId: id }, signal, () => {}),
    async close() { await service.shutdown(); store.close(); removeDir(dir) },
  }
}

export function continuationCounts(entries: readonly Entry[], requests: readonly ModelRequest[]) {
  const messages = entries.flatMap(entry => entry.kind === 'continuation' && entry.payload && 'message' in entry.payload ? [entry.payload] : [])
  return {
    contexts: new Set(messages.map(row => row.preparation)).size,
    requests: requests.length,
    saves: messages.filter(({ message }) => message.role === 'tool' && (message.name === 'write' || message.name === 'edit') && message.ok).length,
    coverages: entries.filter(entry => entry.kind === 'summary' && entry.payload && 'notesSaved' in entry.payload && entry.payload.notesSaved).length,
  }
}
