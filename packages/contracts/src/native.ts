import type { SettingsAction, SettingsSnapshot, SettingsPreview } from './settings.ts'
import type { RunNotice, RunState, StopPhase } from './runs.ts'

/** App、CLI、内核同版发布。只认这一版，不协商或保留旧解码器。 */
export const NATIVE_PROTOCOL = 1
export const SOFTWARE_VERSION = '0.1.0'

export type ServiceIdentity = {
  readonly protocol: number
  readonly version: string
  readonly source: string
  readonly hostInstance: string
  readonly serviceInstance: string
  readonly dataDir: string
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
  readonly notices: readonly AttentionItem[]
  readonly members?: readonly NativeMember[]
}

export type NativeProjection = {
  readonly serviceInstance: string
  readonly revision: number
  readonly accepting: boolean
  readonly works: readonly NativeWork[]
}

export type NativeRequest =
  | { readonly t: 'hello'; readonly role: 'observer'; readonly protocol: number; readonly version: string; readonly source: string; readonly dataDir: string }
  | { readonly t: 'native.refresh' }
  | { readonly t: 'native.settings.read'; readonly request: string; readonly serviceInstance: string; readonly dataDir: string; readonly preview?: SettingsPreview }
  | { readonly t: 'native.settings.apply'; readonly request: string; readonly serviceInstance: string; readonly dataDir: string; readonly stamp: string | null; readonly action: SettingsAction }
  | { readonly t: 'native.inspect'; readonly request: string; readonly session: string; readonly notice?: string }
  | { readonly t: 'native.stop'; readonly request: string; readonly serviceInstance: string; readonly session: string; readonly gen: number }
  | { readonly t: 'native.read'; readonly ids: readonly string[] }
  | { readonly t: 'native.delivered'; readonly ids: readonly string[] }
  | { readonly t: 'native.presence'; readonly session: string; readonly ids: readonly string[]; readonly focused: boolean }

export type NativeResponse =
  | { readonly t: 'native.welcome'; readonly identity: ServiceIdentity; readonly projection: NativeProjection }
  | { readonly t: 'native.projection'; readonly projection: NativeProjection }
  | { readonly t: 'native.inspected'; readonly request: string; readonly work?: NativeWork; readonly error?: string }
  | { readonly t: 'native.stopped'; readonly request: string; readonly session: string; readonly phase: StopPhase; readonly note?: string }
  | { readonly t: 'native.attached'; readonly request: string; readonly session: string | null }
  | { readonly t: 'native.settings.result'; readonly request: string; readonly serviceInstance: string; readonly dataDir: string; readonly snapshot?: SettingsSnapshot; readonly error?: string; readonly note?: string }
  | { readonly t: 'native.error'; readonly reason: string }

/** 仅继承的宿主 stdin/stdout 使用；普通 socket 无宿主提权入口。 */
export type HostRequest = { readonly t: 'host.shutdown'; readonly request: string }
export type HostResponse =
  | { readonly t: 'host.ready'; readonly identity: ServiceIdentity; readonly socket: string; readonly base: string; readonly config: string }
  | { readonly t: 'host.stopped'; readonly request?: string }
  | { readonly t: 'host.error'; readonly reason: string }

/** 发现文件不含凭据、正文；由宿主就绪后原子发布。 */
export type HostDiscovery = ServiceIdentity & {
  readonly socket: string
  readonly base: string
  readonly app: string
}
