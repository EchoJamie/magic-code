/** 从公开会话入口取得下一次模型请求，用于验证真实记录的上下文送达。 */
import type { KnowledgeRecords, ModelRequest, RecordsService } from '@magic/contracts'
import { createConversationSession } from '@magic/conversation'
import { createFauxGateway, makeFauxSink, makeFauxToolRuntime } from '@magic/faux'
import { createStamper } from '../src/agent-assembly/events.ts'

export async function requestFromStoredSession(input: {
  records: RecordsService
  session: string
  cwd: string
  text: string
  knowledge?: KnowledgeRecords
}): Promise<ModelRequest> {
  const stamper = createStamper({ records: input.records, session: input.session, now: Date.now })
  const sink = makeFauxSink()
  const gateway = createFauxGateway({ stamper, turns: [{ text: '已核对当前材料' }] })
  const service = createConversationSession({ records: input.records, session: input.session,
    ...(input.knowledge === undefined ? {} : { knowledge: input.knowledge }),
    prompt: { cwd: input.cwd, platform: 'darwin', date: '2026-10-26' },
    stamper, sink, gateway, tools: makeFauxToolRuntime(),
  })
  try {
    service.submit({ text: input.text })
    const deadline = Date.now() + 2_000
    while (service.busy() && Date.now() < deadline) await Bun.sleep(2)
    if (service.busy()) throw new Error('等待会话请求完成超时')
    const errors = sink.byKind('error')
    if (errors.length > 0) throw new Error(errors.map(event => event.data.message).join('\n'))
    if (gateway.requests.length !== 1) throw new Error(`应有一次模型请求，实际 ${gateway.requests.length} 次`)
    return gateway.requests[0]!
  } finally { await service.shutdown() }
}
