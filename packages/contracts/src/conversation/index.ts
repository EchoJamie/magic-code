/**
 * 会话面契约——界面 ↔ 会话宿主（执行者 ＋ 数据服务）。
 *
 * 含条目、事件、命令、输入、历史、知识、记忆、协作与原生协议；数据服务的读写
 * 与投影也在这一面（实现归 engine/data）。
 */
export * from '../entries.ts'
export * from '../events.ts'
export * from '../control.ts'
export * from '../input.ts'
export * from '../notes.ts'
export * from '../knowledge.ts'
export * from '../memory.ts'
export * from '../collaboration.ts'
export type * from '../collaboration-control.ts'
export * from '../native.ts'
export { decodeHostDiscovery, decodeNativeMessage } from '../native-codec.ts'
export * from '../background.ts'
export * from '../runs.ts'
