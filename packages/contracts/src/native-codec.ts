import { isLogLevel } from './diagnostics.ts'
import { settingsAction, settingsSnapshot } from './settings-codec.ts'
import type { HostDiscovery, HostRequest, HostResponse, NativeRequest, NativeResponse } from './native.ts'

type ObjectValue = Record<string, unknown>
const object = (v: unknown): v is ObjectValue => typeof v === 'object' && v !== null && !Array.isArray(v)
const string = (v: unknown): v is string => typeof v === 'string'
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v)
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(string)
const optional = (v: unknown, check: (v: unknown) => boolean): boolean => v === undefined || check(v)

function identity(v: unknown): boolean {
  return object(v) && integer(v.protocol) && string(v.version) && string(v.source) && string(v.hostInstance) && string(v.serviceInstance) && string(v.base)
}
export function decodeHostDiscovery(value: unknown): HostDiscovery | undefined {
  return object(value) && identity(value) && string(value.socket) && string(value.app)
    ? value as HostDiscovery : undefined
}
function attention(v: unknown): boolean {
  return object(v) && string(v.id) && string(v.session) && ['done', 'failed', 'needs-you'].includes(String(v.kind)) &&
    number(v.at) && optional(v.detail, string) && typeof v.unread === 'boolean' && typeof v.delivered === 'boolean' && string(v.fact)
}
function member(v: unknown): boolean {
  return object(v) && string(v.session) && string(v.name) &&
    ['running', 'waiting', 'stopping', 'stopped', 'idle', 'unknown'].includes(String(v.state)) &&
    optional(v.action, string) && optional(v.reason, string)
}
function work(v: unknown): boolean {
  return object(v) && string(v.session) && string(v.title) && strings(v.workspace) &&
    ['running', 'waiting', 'stopping', 'stopped', 'idle', 'unknown'].includes(String(v.state)) &&
    optional(v.action, string) && optional(v.reason, string) && number(v.since) && (v.gen === null || integer(v.gen)) &&
    typeof v.affected === 'boolean' && Array.isArray(v.notices) && v.notices.every(attention) && optional(v.terminalNoticeIds, strings) && optional(v.members, v => Array.isArray(v) && v.every(member))
}
function projection(v: unknown): boolean {
  return object(v) && string(v.serviceInstance) && integer(v.revision) && typeof v.accepting === 'boolean' &&
    Array.isArray(v.works) && v.works.every(work)
}

/** 与 Swift 共享 JSON corpus；缺字段、类型不符与未知变体直接拒绝。 */
export function decodeNativeMessage(value: unknown): NativeRequest | NativeResponse | HostRequest | HostResponse | undefined {
  if (!object(value)) return undefined
  let valid = false
  switch (value.t) {
    case 'hello': valid = value.role === 'observer' && integer(value.protocol) && string(value.version) && string(value.source) && string(value.base); break
    case 'native.settings.read': valid = string(value.request) && string(value.serviceInstance) && string(value.base) && optional(value.preview, v => object(v) && typeof v.columns === 'number' && Number.isInteger(v.columns) && v.columns >= 20 && v.columns <= 300 && typeof v.reducedMotion === 'boolean' && settingsAction({ type: 'prefs.set', statusLine: v.statusLine })); break
    case 'native.settings.apply': valid = string(value.request) && string(value.serviceInstance) && string(value.base) && (value.stamp === null || string(value.stamp)) && settingsAction(value.action); break
    case 'native.settings.result': valid = string(value.request) && string(value.serviceInstance) && string(value.base) && optional(value.snapshot, settingsSnapshot) && optional(value.error, string) && optional(value.note, string) && ((value.snapshot === undefined) !== (value.error === undefined)); break
    case 'native.refresh': valid = true; break
    case 'native.inspect': valid = string(value.request) && string(value.session) && optional(value.notice, string); break
    case 'native.stop': valid = string(value.request) && string(value.serviceInstance) && string(value.session) && integer(value.gen); break
    case 'native.read': case 'native.delivered': valid = strings(value.ids); break
    case 'native.presence': valid = string(value.session) && strings(value.ids) && typeof value.focused === 'boolean'; break
    case 'native.welcome': valid = identity(value.identity) && projection(value.projection); break
    case 'native.projection': valid = projection(value.projection); break
    case 'native.inspected': valid = string(value.request) && optional(value.work, work) && optional(value.error, string) && ((value.work === undefined) !== (value.error === undefined)); break
    case 'native.stopped': valid = string(value.request) && string(value.session) && ['accepted', 'done', 'unconfirmed'].includes(String(value.phase)) && optional(value.note, string); break
    case 'native.attached': valid = string(value.request) && (value.session === null || string(value.session)); break
    case 'native.error': case 'host.error': valid = string(value.reason); break
    case 'host.diagnostics': valid = string(value.request) && string(value.base) && object(value.value) && typeof value.value.debugMode === 'boolean' && isLogLevel(value.value.logLevel); break
    case 'host.diagnostics.applied': valid = string(value.request) && optional(value.error, string); break
    case 'host.shutdown': valid = string(value.request); break
    case 'host.ready': valid = identity(value.identity) && string(value.socket) && string(value.base) && string(value.config); break
    case 'host.stopped': valid = optional(value.request, string); break
  }
  return valid ? value as NativeRequest | NativeResponse | HostRequest | HostResponse : undefined
}
