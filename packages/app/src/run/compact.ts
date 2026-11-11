import type { CompactCommand, CompactState, KernelEvent } from '@magic/contracts'
import type { RecordsStore } from '@magic/data'

type Request = Extract<CompactCommand, { type: 'compact.request' }>
const active = (state: CompactState['state']) => state === 'pending' || state === 'running'

/** 请求事实沿会话事件保存；内存只持有本次调用的取消柄与完成句柄。 */
export function createCompactController(input: {
  store: RecordsStore
  now(): number
  publish(event: Extract<KernelEvent, { kind: 'compact.state' }>): void
}) {
  const flights = new Map<string, { request: Request; controller: AbortController; done: Promise<void> }>()
  const write = (session: string, state: CompactState): CompactState => {
    const records = input.store.serviceFor(session)
    const event = { session, id: records.nextId(), at: input.now(), turn: null, kind: 'compact.state' as const, data: state }
    records.appendEvent(event)
    input.publish(event)
    return state
  }
  const states = async (session: string) => {
    const found = new Map<string, CompactState>()
    if (input.store.hasSession(session)) for await (const event of input.store.serviceFor(session).readEvents(session)) {
      if (event.kind === 'compact.state') found.set(event.data.requestId, event.data)
    }
    return found
  }
  async function query(session: string, requestId: string): Promise<CompactState> {
    const state = (await states(session)).get(requestId)
    if (state === undefined) return { requestId, state: 'unknown', reason: '尚未查到该请求的受理事实；未自动重发' }
    if (active(state.state) && flights.get(session)?.request.requestId !== requestId) return write(session, { ...state, state: 'interrupted', reason: '执行已中断；原请求不会自动重放' })
    return state
  }
  return {
    query,
    active: (session: string) => flights.has(session),
    async request(request: Request, run: (signal: AbortSignal, started: () => void) => Promise<CompactState>): Promise<CompactState> {
      if (!input.store.hasSession(request.session)) return { requestId: request.requestId, state: 'no-material', reason: '没有可压缩的会话；未建立新会话' }
      const known = (await states(request.session)).get(request.requestId)
      if (known) return query(request.session, request.requestId)
      if (input.store.isSessionArchived(request.session)) return { requestId: request.requestId, state: 'failed', reason: '会话已归档，请先明确恢复；本次未受理' }
      const previous = flights.get(request.session)
      if (previous?.request.requestId === request.requestId) return query(request.session, request.requestId)
      if (previous) return { requestId: request.requestId, state: 'failed', reason: `该会话已有压缩请求 ${previous.request.requestId}；本次未受理` }
      const controller = new AbortController()
      // 受理后的运行只排在完整交互边界；关闭客户端不取消这份 Engine 责任。
      const accepted = write(request.session, { requestId: request.requestId, ...(request.focus === undefined ? {} : { focus: request.focus }), accepted: true, state: 'pending' })
      const flight = { request, controller, done: Promise.resolve() }
      flights.set(request.session, flight)
      flight.done = (async () => {
        try {
          const outcome = await run(controller.signal, () => {
            if (!controller.signal.aborted) write(request.session, { ...accepted, state: 'running' })
          })
          const committed = (await states(request.session)).get(request.requestId)
          // 成功由摘要事务发布，绝不在这里补造一个可能与摘要分离的成功事件。
          if (committed?.state === 'completed') {
            for await (const event of input.store.serviceFor(request.session).readEvents(request.session)) if (event.kind === 'compact.state' && event.data.requestId === request.requestId && event.data.state === 'completed') input.publish(event)
            return
          }
          if (outcome.state === 'completed') write(request.session, { ...accepted, ...committed, state: 'failed', reason: '压缩未取得原子发布的成功终态，请查询记录' })
          else write(request.session, { ...accepted, ...committed, ...outcome, ...(outcome.notesSaved || committed?.notesSaved ? { notesSaved: true } : {}) })
        } catch (error) {
          const committed = (await states(request.session)).get(request.requestId)
          if (committed?.state !== 'completed') write(request.session, { ...accepted, ...committed, state: controller.signal.aborted ? 'cancelled' : 'failed', reason: controller.signal.aborted ? '本次压缩已取消' : String(error) })
        } finally { if (flights.get(request.session) === flight) flights.delete(request.session) }
      })()
      return accepted
    },
    async cancel(session: string, requestId: string): Promise<CompactState> {
      const flight = flights.get(session)
      if (flight?.request.requestId === requestId) {
        flight.controller.abort()
        await flight.done
      }
      return query(session, requestId)
    },
    async recover(): Promise<void> {
      for (const session of await input.store.listSessions()) for (const state of (await states(session.id)).values()) {
        if (active(state.state) && flights.get(session.id)?.request.requestId !== state.requestId) write(session.id, { ...state, state: 'interrupted', reason: 'Engine 已重启；原请求不会自动重放' })
      }
    },
    async close(): Promise<void> {
      for (const flight of flights.values()) flight.controller.abort()
      await Promise.all([...flights.values()].map(flight => flight.done))
    },
  }
}
