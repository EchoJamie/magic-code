import { normalizeDataDir } from './paths.ts'
import type { NativeProjection, NativeRequest, NativeResponse, NativeWork, ServiceIdentity, StopPhase, Wire } from '@magic/contracts'
import type { RecordsStore } from '@magic/records'
import type { Link } from './wire.ts'

export type NativeServerOptions = {
  readonly record?: (level: 'debug' | 'warn', event: string, request: string) => void
  readonly identity: ServiceIdentity
  readonly store: RecordsStore
  readonly accepting: () => boolean
  readonly works: () => Promise<readonly NativeWork[]>
  readonly configuration?: () => NativeProjection['configuration']
  readonly engineStop?: (request: string, idleOnly: boolean) => Promise<void>
  readonly stop: (session: string, gen: number, report: (phase: StopPhase, note?: string) => void) => void
  readonly runtime?: { read(): Promise<Pick<Extract<NativeResponse, { t: 'native.runtime.result' }>, 'mcp' | 'canChangeData'>>; reconnect(session: string, gen: number, name: string): Promise<string> }
  readonly log?: (message: string) => void
}

/** 工作观察与 Engine 控制共用已核验身份的连接。 */
export function createNativeServer(options: NativeServerOptions) {
  const observers = new Set<Link>()
  const presence = new Map<Link, { session: string; ids: readonly string[] }>()
  let revision = 0
  let pending: Promise<void> | undefined
  let dirty = false
  let closed = false
  let snapshots: Promise<unknown> = Promise.resolve()
  const runtimeRequests = new Map<Link, Map<string, { signature: string; result: Promise<NativeResponse> }>>()
  const engineStops = new Map<string, { signature: string; result: Promise<NativeResponse> }>()
  const stops = new Map<string, {
    readonly session: string; readonly gen: number; readonly service: string; readonly links: Set<Link>
    response?: Extract<NativeResponse, { t: 'native.stopped' }>
  }>()
  // 所有完整投影共用一条读取序列，晚完成的旧查询不能带着更高版本覆盖新事实。
  const snapshot = (): Promise<NativeProjection> => {
    const next = snapshots.then(async () => ({
      serviceInstance: options.identity.serviceInstance,
      revision: ++revision,
      accepting: options.accepting(),
      works: await options.works(),
      ...(options.configuration ? { configuration: options.configuration() } : {}),
    }))
    snapshots = next.catch(() => {})
    return next
  }
  const changed = (): void => {
    if (closed || observers.size === 0) return
    dirty = true
    if (pending !== undefined) return
    pending = (async () => {
      while (dirty && !closed) {
        dirty = false
        const projection = await snapshot()
        for (const link of observers) link.send({ t: 'native.projection', projection })
      }
    })().catch((error) => {
      options.log?.(`状态读取失败：${String(error)}`)
      for (const link of observers) link.send({ t: 'native.error', reason: '无法读取当前工作状态' })
    }).finally(() => { pending = undefined })
  }
  const idsOf = (ids: readonly string[]) => ids.filter((id) => typeof id === 'string')

  return {
    changed,
    attached(request: string, session: string | null): void {
      for (const link of observers) link.send({ t: 'native.attached', request, session })
    },
    close(): void {
      closed = true
      for (const link of observers) link.close()
      observers.clear()
      presence.clear()
      stops.clear()
    },
    receive(link: Link, raw: Wire): boolean {
      if (raw.t === 'hello' && raw.role === 'observer') {
        if (observers.has(link)) return true
        const identity = options.identity
        if (raw.protocol !== identity.protocol || raw.version !== identity.version || raw.source !== identity.source || normalizeDataDir(raw.base) !== normalizeDataDir(identity.base)) {
          link.send({ t: 'native.error', reason: 'App 与服务的版本、来源或数据位置不同，请退出原 App 后重试' })
          link.close()
          return true
        }
        observers.add(link)
        link.onClose(() => {
          observers.delete(link); presence.delete(link); runtimeRequests.delete(link)
          for (const stop of stops.values()) stop.links.delete(link)
        })
        void snapshot().then((projection) => {
          if (!link.closed) link.send({ t: 'native.welcome', identity, projection })
        }).catch(() => { link.send({ t: 'native.error', reason: '无法读取工作记录' }); link.close() })
        return true
      }
      if (!observers.has(link)) return false
      const message = raw as NativeRequest
      switch (message.t) {
        case 'native.engine.stop': {
          const failed = (error: string): NativeResponse => ({ t: 'native.engine.result', request: message.request, phase: 'failed', error })
          const signature = JSON.stringify(message)
          const previous = engineStops.get(message.request)
          if (previous) {
            if (previous.signature !== signature) link.send(failed('请求标识已用于另一动作'))
            else void previous.result.then(result => link.send(result))
            break
          }
          const target = message.identity, current = options.identity
          if (target.protocol !== current.protocol || target.version !== current.version || target.source !== current.source || target.base !== current.base || target.serviceInstance !== current.serviceInstance || !options.engineStop) {
            link.send(failed('Engine 身份已改变，未停止当前服务')); break
          }
          // 动作的生命周期属于 Engine，不随本连接关闭取消。
          const result = options.engineStop(message.request, message.idleOnly === true).then(
            (): NativeResponse => ({ t: 'native.engine.result', request: message.request, phase: 'done' }),
            (error: unknown): NativeResponse => failed(String(error)),
          )
          engineStops.set(message.request, { signature, result })
          link.send({ t: 'native.engine.result', request: message.request, phase: 'accepted' })
          void result.then(response => link.send(response))
          break
        }
        case 'native.runtime.read': case 'native.runtime.reconnect': {
          const target = { t: 'native.runtime.result' as const, request: message.request, serviceInstance: options.identity.serviceInstance }
          const failure = (error: string): NativeResponse => ({ ...target, error })
          if (closed || !options.accepting() || (message.t === 'native.runtime.reconnect' && message.serviceInstance !== options.identity.serviceInstance)) {
            link.send(failure('Engine 已换代或正在停止，请刷新状态')); break
          }
          const owned = runtimeRequests.get(link) ?? new Map<string, { signature: string; result: Promise<NativeResponse> }>()
          runtimeRequests.set(link, owned)
          const signature = JSON.stringify(message)
          const previous = owned.get(message.request)
          if (previous !== undefined) {
            if (previous.signature !== signature) link.send(failure('请求标识已用于另一动作'))
            else void previous.result.then(result => { if (!link.closed) link.send(result) })
            break
          }
          const result = (async (): Promise<NativeResponse> => {
            try {
              if (!options.runtime) return failure('运行状态不可用')
              const note = message.t === 'native.runtime.reconnect' ? await options.runtime.reconnect(message.session, message.gen, message.name) : undefined
              return { ...target, ...await options.runtime.read(), ...(note === undefined ? {} : { note }) }
            } catch (error) { return failure(error instanceof Error ? error.message : String(error)) }
          })()
          owned.set(message.request, { signature, result })
          void result.then(response => { if (!link.closed) link.send(response) })
          break
        }
        case 'native.refresh': changed(); break
        case 'native.read':
          if (Array.isArray(message.ids)) options.store.attention.markRead(idsOf(message.ids))
          changed()
          break
        case 'native.delivered':
          if (Array.isArray(message.ids)) options.store.attention.markDelivered(idsOf(message.ids))
          changed()
          break
        case 'native.presence':
          if (message.focused && typeof message.session === 'string' && Array.isArray(message.ids)) {
            presence.set(link, { session: message.session, ids: idsOf(message.ids) })
          } else presence.delete(link)
          break
        case 'native.inspect':
          if (typeof message.session !== 'string' || typeof message.request !== 'string') break
          void options.works().then((works) => {
            const work = works.find((one) => one.session === message.session)
            const valid = work !== undefined && (message.notice === undefined || work.notices.some((one) => one.id === message.notice))
            link.send(valid
              ? { t: 'native.inspected', request: message.request, work }
              : { t: 'native.inspected', request: message.request, error: '该事项或会话已不可达' })
          }).catch(() => link.send({ t: 'native.inspected', request: message.request, error: '读取记录失败' }))
          break
        case 'native.stop': {
          const previous = stops.get(message.request)
          if (previous !== undefined) {
            if (previous.session !== message.session || previous.gen !== message.gen || previous.service !== message.serviceInstance) {
              link.send({ t: 'native.error', reason: '停止请求标识已用于另一目标，请刷新后重试' })
            } else {
              previous.links.add(link)
              if (previous.response !== undefined) link.send(previous.response)
            }
            break
          }
          if (message.serviceInstance !== options.identity.serviceInstance || !options.accepting()) {
            link.send({ t: 'native.stopped', request: message.request, session: message.session, phase: 'unconfirmed', note: '服务已换代或正在退出，请刷新当前状态' })
            changed()
            break
          }
          const stop: NonNullable<ReturnType<typeof stops.get>> = {
            session: message.session, gen: message.gen, service: message.serviceInstance, links: new Set([link]),
          }
          stops.set(message.request, stop)
          options.stop(message.session, message.gen, (phase, note) => {
            stop.response = { t: 'native.stopped', request: message.request, session: message.session, phase, ...(note === undefined ? {} : { note }) }
            for (const observer of stop.links) observer.send(stop.response)
          })
          break
        }
      }
      return true
    },
  }
}
