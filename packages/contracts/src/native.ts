import type { KernelEvent } from './events.ts'
import type { Entry, SessionSummary } from './entries.ts'
import type { RunNotice, RunState, StopPhase } from './runs.ts'

/** App、CLI、内核同版发布。只认这一版，不协商或保留旧解码器。 */
export const NATIVE_PROTOCOL = 1
export const SOFTWARE_VERSION = '0.1.0'

export type ServiceIdentity = {
  readonly protocol: number
  readonly version: string
  readonly source: string
  readonly serviceInstance: string
  readonly base: string
}

export type AttentionItem = RunNotice & {
  readonly delivered: boolean
  readonly fact: string
}

/** 同拍捕获的只读成员摘要；不含全文、模型配置或执行入口。 */
export type NativeMember = {
  readonly session: string
  readonly name: string
  readonly state: RunState
  readonly action?: string
  readonly reason?: string
}

/** 服务生成完整投影；UI 只按身份呈现，不从事件重建领域状态。 */
export type NativeWork = {
  /** 缺席表示运行快照无效，不能以零代替。 */
  readonly background?: number
  readonly session: string
  readonly title: string
  readonly workspace: readonly string[]
  readonly state: RunState
  readonly action?: string
  readonly reason?: string
  readonly since: number
  /** 当前停止目标的代次；新执行/新一轮输入使旧目标失效，与服务身份共同核对。 */
  readonly gen: number | null
  readonly affected: boolean
  readonly archived: boolean
  readonly canArchive: boolean
  readonly terminalOpen: boolean
  readonly currentNotice?: AttentionItem
  readonly members?: readonly NativeMember[]
}

export type NativeProjection = {
  readonly serviceInstance: string
  readonly revision: number
  readonly accepting: boolean
  readonly works: readonly NativeWork[]
  readonly configuration?: { readonly stamp: string | null; readonly error?: string }
}

export type NativeSession = SessionSummary & { readonly background?: number; readonly state: RunState; readonly canArchive: boolean; readonly terminalOpen: boolean; readonly reason?: string }
export type SessionManagement = { readonly session: string; readonly action: 'archive' | 'restore' | 'rename'; readonly title?: string }
export type SessionManagementResult = SessionManagement & { readonly ok: boolean; readonly archived?: boolean; readonly error?: string }

export type NativeRequest =
  | { readonly t: 'native.sessions'; readonly request: string; readonly archived?: boolean; readonly workspace?: readonly string[]; readonly search?: string }
  | { readonly t: 'native.history'; readonly request: string; readonly session: string; readonly after?: number; readonly source?: AttentionItem['source'] }
  | { readonly t: 'native.session.manage'; readonly request: string; readonly serviceInstance: string; readonly items: readonly SessionManagement[] }
  | { readonly t: 'hello'; readonly role: 'observer'; readonly protocol: number; readonly version: string; readonly source: string; readonly base: string }
  | { readonly t: 'native.engine.stop'; readonly request: string; readonly identity: ServiceIdentity; readonly idleOnly?: boolean }
  | { readonly t: 'native.refresh' }
  | { readonly t: 'native.runtime.read'; readonly request: string }
  | { readonly t: 'native.runtime.reconnect'; readonly request: string; readonly serviceInstance: string; readonly session: string; readonly gen: number; readonly name: string }
  | { readonly t: 'native.inspect'; readonly request: string; readonly session: string; readonly notice?: string }
  | { readonly t: 'native.stop'; readonly request: string; readonly serviceInstance: string; readonly session: string; readonly gen: number }
  | { readonly t: 'native.read'; readonly serviceInstance: string; readonly ids: readonly string[] }
  | { readonly t: 'native.delivered'; readonly serviceInstance: string; readonly ids: readonly string[] }

export type NativeResponse =
  | { readonly t: 'native.sessions.result'; readonly request: string; readonly serviceInstance: string; readonly sessions?: readonly NativeSession[]; readonly error?: string }
  | { readonly t: 'native.history.result'; readonly request: string; readonly serviceInstance: string; readonly session: string; readonly entries?: readonly Entry[]; readonly events?: readonly KernelEvent[]; readonly currentRequests?: readonly Extract<KernelEvent, { kind: 'tool.decision.request' }>[]; readonly next?: number; readonly done: boolean; readonly error?: string }
  | { readonly t: 'native.session.managed'; readonly request: string; readonly serviceInstance: string; readonly results: readonly SessionManagementResult[] }
  | { readonly t: 'native.welcome'; readonly identity: ServiceIdentity; readonly projection: NativeProjection }
  | { readonly t: 'native.projection'; readonly projection: NativeProjection }
  | { readonly t: 'native.inspected'; readonly request: string; readonly work?: NativeWork; readonly error?: string }
  | { readonly t: 'native.stopped'; readonly request: string; readonly session: string; readonly phase: StopPhase; readonly note?: string }
  | { readonly t: 'native.attached'; readonly request: string; readonly session: string | null }
  | { readonly t: 'native.runtime.result'; readonly request: string; readonly serviceInstance: string; readonly mcp?: readonly { readonly session: string; readonly gen: number | null; readonly servers: readonly unknown[] }[]; readonly canChangeData?: boolean; readonly error?: string; readonly note?: string }
  | { readonly t: 'native.engine.result'; readonly request: string; readonly phase: 'accepted' | 'done' | 'failed'; readonly error?: string }
  | { readonly t: 'native.error'; readonly reason: string }

/** 当前 Engine 及最后一次生命周期结果；文件存在不代表在线。 */
export type EnginePhase = 'starting' | 'ready' | 'stopping' | 'stopped' | 'unreachable' | 'failed'
export type HostDiscovery = ServiceIdentity & {
  readonly socket: string
  readonly app: string
  readonly lifecycle: string
  readonly pid?: number
  readonly startedAt?: number
  readonly state: EnginePhase
  readonly request?: string
  readonly error?: string
}
