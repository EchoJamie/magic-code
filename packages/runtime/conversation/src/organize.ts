import type { Entry, EventSink, EventStamper, ModelGateway, ModelMessage, RecordsService, SessionId, ToolRuntime, ToolSpec, WorkingNotes } from '@magic/contracts'
import { callMemoryModel } from './memory-model.ts'
import { materialTextOf } from './material.ts'
import { readPlanOf } from './plan.ts'

export const NOTE_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'glob'])
export const substantiveEntries = (entries: readonly Entry[]): readonly Entry[] => entries.filter(entry => entry.kind !== 'summary' && entry.kind !== 'continuation')
export class PreparationFailure extends Error {
  constructor(readonly kind: 'capacity' | 'changed' | 'incomplete', message: string) { super(message) }
}
export const preparationReserve = (inputBudget: number) => Math.max(512, Math.ceil(inputBudget * .15))
export type PreparationCapacity = { readonly inputBudget?: number; readonly maxOutputTokens?: number; readonly identity?: string }
export type PreparationDeps = {
  readonly records: RecordsService; readonly session: SessionId
  readonly notes: WorkingNotes; readonly tools: (notes: WorkingNotes) => ToolRuntime
  readonly gateway: ModelGateway; readonly capacity: PreparationCapacity
  readonly sink: EventSink; readonly stamper: EventStamper; readonly now: () => number
  readonly checkBasis: () => void
  readonly saved: () => void
}
export const noteSignature = (files: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))

/** 按可用容量合并连续材料；每批使用真实工具取回正文，全部保存后才返回覆盖候选。 */
export async function prepareContinuation(deps: PreparationDeps, entries: readonly Entry[], signal?: AbortSignal, focus?: string): Promise<Readonly<Record<string, string>>> {
  const budget = deps.capacity.inputBudget ?? 16000
  const reserve = preparationReserve(budget)
  let inputRatio = .5
  let expected = { ...await deps.notes.snapshot() }
  async function unchanged() {
    signal?.throwIfAborted()
    if (noteSignature(await deps.notes.snapshot()) !== noteSignature(expected)) throw new PreparationFailure('changed', '准备期间笔记发生外部修改，原覆盖保留')
    deps.checkBasis()
  }
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  type Source = { entry: Entry; material: Awaited<ReturnType<typeof materialTextOf>>; offset: number; end: number; provided: number; read: boolean }
  const page = (source: Source, start = source.offset, end = source.end) => ({
    source: { session: deps.session, entry: source.entry.id, offset: start }, speaker: source.material.speaker, kind: source.entry.kind, recordedAt: new Date(source.entry.at).toISOString(),
    text: source.material.text.slice(start, end), total: source.material.text.length, complete: end === source.material.text.length,
    ...(end < source.end ? { next: end } : {}), segmentEnd: source.end,
  })
  const materials = new Map<number, Awaited<ReturnType<typeof materialTextOf>>>()
  let index = 0, offset = 0
  let materialBudget: number | undefined
  while (index < entries.length) {
    await unchanged()
    const notes = deps.notes.fork(Math.max(1, Math.floor((budget - reserve) / inputRatio / 3)))
    const tools = deps.tools(notes)
    const specs: ToolSpec[] = [
      ...tools.definitions().filter(tool => NOTE_TOOLS.has(tool.name)),
      { name: 'plan_read', summary: '读取本会话独立计划；计划由普通工作轮次独立维护', parameters: { type: 'object', properties: {}, additionalProperties: false }, danger: { level: 'light' } },
      { name: 'history_read', summary: '读取本批来源原文；只传 entry 即读取该记录的本批完整范围。返回 next 时须从该位置继续，不能以内容重复为由省略未读部分', parameters: { type: 'object', properties: { entry: { type: 'integer' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } }, required: ['entry'], additionalProperties: false }, danger: { level: 'light' } },
    ]
    const instruction = `这是当前模型的独立接续准备，不是业务轮次。只维护自身笔记 ${notes.directory}，通常从 MEMORY.md 读取，有主题时沿链接读取。使用 read/ls 实际取回已有笔记，并用 plan_read 了解当前计划。\n` +
      '用 history_read 按下列位置读取本批全部真实来源；本批之外不可读取，后续材料由宿主继续提供。可在一次响应中调用多个读取工具。\n' +
      '笔记供后续继续工作：保留当前目标、有效要求、决定与必要理由、全部未决点、已做及未验范围、继续入口和必要来源。沿用已有准确内容，只补充遗漏、修正有依据的变化；后批保留前批认识，已有内容无需改变时可原样保存。只写任务结论与必要依据，不写本次整理报告、读写沿革、工具调用流水或旧笔记快照；重复事实合并。计划通过 plan_read 单独取得，笔记只留计划背后的理由和条件，不复制整份计划。\n' +
      '用户要求以原始交代和明确纠正为准。仅在来源明确反驳旧笔记时纠正；本批没有重述某条旧认识不构成反证。助手或成员提出的做法、推测与旧计划保留其来源和性质，未经用户确认不得变成用户要求、授权或额外确认条件。只记录材料中实际未解决的问题，不为补齐栏目发明待办。按原文保留事实的对象、时间用途、条件及确定程度；日期或数字相同不表示同一件事，仅在明确纠正同一对象时替换旧值，证据不足保留原义，不补造解释。\n' +
      '本次准备的工具范围、只读计划、分批步骤和整理重点只约束这次辅助调用，不写入工作笔记，也不成为后续工作的限制。业务仍按用户原有目标、授权和最新交代继续，计划在普通工作中独立更新。\n' +
      `全部来源读完后用 write/edit 保存接续材料；保存失败不得声称完成。准备完本批后直接结束。工具正文有界，节选按实际 next 继续；必要来源写成 Markdown 链接，地址由 history_read 返回的 source.session 与 source.entry 组成，例如 [原始交代](${deps.session}#${entries[0]!.id})，不要把“会话”或“记录”写进地址。` + (focus ? `\n本次整理关注：${focus}；保留其他有效要求与原有授权，不把关注指令本身存成长期要求。` : '')
    const location = (source: Source) => `会话 ${deps.session}，记录 ${source.entry.id}（${source.material.speaker}/${source.entry.kind}），字符 [${source.offset},${source.end})，该记录共 ${source.material.text.length} 字符。`
    // 正文至少经历读取结果及保存参数两次，另留一次笔记接续的空间；实际往返仍逐次核容量。
    const available = Math.max(0, (budget - reserve - bytes({ messages: instruction, tools: specs }) * inputRatio) / 3)
    const allowance = Math.min(materialBudget ?? available, available)
    const sources: Source[] = []
    let cost = 0, nextIndex = index, nextOffset = offset
    while (nextIndex < entries.length) {
      const entry = entries[nextIndex]!
      let material = materials.get(entry.id)
      if (!material) { material = await materialTextOf(entry, deps.records, deps.session); materials.set(entry.id, material) }
      const source: Source = { entry, material, offset: nextOffset, end: material.text.length, provided: nextOffset, read: material.text.length === 0 }
      const estimate = (end: number) => { source.end = end; return bytes([location(source), page(source)]) * inputRatio }
      let end = material.text.length
      if (cost + estimate(end) > allowance) {
        let low = nextOffset, high = end
        while (low < high) {
          const middle = Math.ceil((low + high) / 2)
          if (cost + estimate(middle) <= allowance) low = middle
          else high = middle - 1
        }
        end = low
        if (end === nextOffset && sources.length) break
        // 最小的一条空记录或一个字符仍须实际尝试，不能因分批估算直接放弃。
        if (end === nextOffset) end = Math.min(material.text.length, nextOffset + 1)
      }
      cost += estimate(end); sources.push(source)
      if (end < material.text.length) { nextOffset = end; break }
      nextIndex++; nextOffset = 0
    }
    const preparation = crypto.randomUUID()
    const messages: ModelMessage[] = [
      { role: 'system', content: instruction + '\n' + sources.map(location).join('\n') },
      { role: 'user', content: '请按上述范围完成本批接续准备：先通过工具读取真实材料，再保存工作笔记。' },
    ]
    const record = (message: ModelMessage) => deps.records.appendEntry({ kind: 'continuation', content: { text: '' }, payload: { preparation, message }, at: deps.now() })
    const complete = () => sources.every(source => source.read && source.provided >= source.end)
    let readNotes = false, readPlan = false, savedAfterRead = false, started = false
    const pending = () => [
      ...sources.filter(source => !source.read || source.provided < source.end).map(source => `记录 ${source.entry.id} 字符 [${source.provided},${source.end}) 尚未读取，用 history_read(entry=${source.entry.id}, offset=${source.provided}) 继续`),
      ...(!readNotes ? ['尚未读取已有笔记（空目录可用 ls 确认）'] : []),
      ...(!readPlan ? ['尚未用 plan_read 读取独立计划'] : []),
    ]
    try {
      for (;;) {
        await unchanged()
        const requestBytes = bytes({ messages, tools: specs })
        if (Math.ceil(requestBytes * inputRatio) + reserve > budget) throw new PreparationFailure('capacity', '当前模型的输入预算不足以完成接续往返；原覆盖保留')
        if (!started) { for (const message of messages) record(message); started = true }
        const { text, reasoning, result, failure } = await callMemoryModel({ ...deps, purpose: 'compact', request: { messages, tools: specs }, ...(signal ? { signal } : {}) })
        const calls = result.toolCalls ?? []
        const assistant: ModelMessage = { role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}),
          ...(reasoning ? { reasoning } : {}), ...(result.reasoningState ? { reasoningState: result.reasoningState } : {}) }
        if (text || reasoning || calls.length || result.reasoningState) { messages.push(assistant); record(assistant) }
        if (failure || !result.complete || (result.finishReason !== 'stop' && result.finishReason !== 'tool-calls')) throw new PreparationFailure(failure?.tier === 'context-limit' || result.finishReason === 'length' ? 'capacity' : 'incomplete', failure?.message ?? '接续准备没有完整结束')
        if (result.usage?.inputTokens !== undefined) inputRatio = Math.max(inputRatio, result.usage.inputTokens / requestBytes)
        if (!calls.length) {
          if (!complete() || !readNotes || !readPlan || !savedAfterRead) throw new PreparationFailure('incomplete', [...pending(), ...(!savedAfterRead ? ['尚未在本批读取完成后保存笔记'] : []), '原覆盖保留'].join('；'))
          break
        }
        let interrupted: unknown
        for (const call of calls) {
          let ok = false, output: string
          try {
            if (interrupted !== undefined) throw interrupted
            await unchanged()
            if (call.name === 'plan_read') {
              output = JSON.stringify(readPlanOf(deps.records, deps.session)); readPlan = true; ok = true
            } else if (call.name === 'history_read') {
              const source = sources.find(source => source.entry.id === call.args.entry)
              if (!source) throw new Error('来源不在本次冻结材料范围')
              const start = call.args.offset ?? source.offset, length = call.args.limit ?? Math.max(1, source.end - source.offset)
              if (!Number.isSafeInteger(start) || (start as number) < source.offset || (start as number) > source.end || !Number.isSafeInteger(length) || (length as number) < 1) throw new Error('来源不在本次冻结材料范围')
              const finish = Math.min(source.end, (start as number) + (length as number))
              output = JSON.stringify(page(source, start as number, finish))
              source.read = true
              if ((start as number) <= source.provided) source.provided = Math.max(source.provided, finish)
              ok = true
            } else if (NOTE_TOOLS.has(call.name)) {
              if (typeof call.args.path !== 'string' || notes.resolve(call.args.path) === undefined) throw new Error('辅助调用只能访问本会话笔记，不可执行业务工具')
              const before = notes.saved()
              const result = await tools.invoke(call, signal ? { signal } : {})
              ok = result.ok; output = result.output
              if (notes.saved() > before) {
                deps.saved(); expected = { ...expected, ...notes.writes() }
                savedAfterRead ||= ok && complete() && readNotes && readPlan
                const remaining = pending()
                if (remaining.length) output += `\n笔记已保存，本批接续准备尚未完成：${remaining.join('；')}。读取完成后再次保存接续材料。`
              }
              if (ok && (call.name === 'read' || (call.name === 'ls' && Object.keys(expected).length === 0))) readNotes = true
            } else throw new Error(`接续准备不允许工具 ${call.name}`)
          } catch (error) {
            output = error instanceof Error ? error.message : String(error)
            if (error instanceof PreparationFailure || signal?.aborted) interrupted = error
          }
          const result: ModelMessage = { role: 'tool', callId: call.id, name: call.name, ok, output }
          messages.push(result); record(result)
        }
        if (interrupted !== undefined) throw interrupted
      }
      await unchanged()
      for (let done = index; done < nextIndex; done++) materials.delete(entries[done]!.id)
      index = nextIndex; offset = nextOffset; materialBudget = undefined
    } catch (error) {
      if (error instanceof PreparationFailure && error.kind === 'capacity') {
        if (sources.length > 1 || sources[0]!.end - sources[0]!.offset > 1) { materialBudget = Math.floor(Math.min(allowance, cost) / 2); continue }
        throw new PreparationFailure('capacity', `最小来源范围仍无法完成接续：${error.message}`)
      }
      throw error
    }
  }
  await unchanged()
  return expected
}
