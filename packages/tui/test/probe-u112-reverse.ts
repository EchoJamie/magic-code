#!/usr/bin/env bun
/**
 * U112 · **反向判据探针**（改前红的那一把尺子）。
 *
 * 这一个文件**故意不 import 本单新加的任何东西**（`marks.ts` / `motion.ts`）——
 * 它的用法是**在改前那棵树里也跑得起来**，把「记号那一套换没换掉」量出来：
 *
 * ```
 * cp packages/tui/test/probe-u112-reverse.ts <另一棵树>/packages/tui/test/
 * cd <另一棵树> && bun packages/tui/test/probe-u112-reverse.ts
 * ```
 *
 * 它只印**记号在不在**（不判对错）：同一份探针在两棵树上跑，两份输出一比，
 * 「改前是什么样、改后是什么样」就是**量出来的**，不是回忆出来的。
 */

import { createShell } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { show } from './screen.ts'

const SCREEN = { columns: 100, rows: 30 } as const
const AT = 1_700_000_000_000

const spy = createSpyTransport()
const shell = createShell(spy.transport)
for (const char of '看看这个文件') shell.key({ kind: 'char', char })
shell.key({ kind: 'enter' })
spy.emit(event('turn.start', {}, { id: 40 }))
spy.emit(event('model.delta', { channel: 'text', text: '我先看一眼。' }, { id: 41 }))
spy.emit(event('tool.call', { name: 'exec', args: { cmd: 'sleep 2 && chmod 755 .' } }, { id: 71 }))

const running = (await show([shell.getView()], SCREEN, AT + 71 + 1_400)).screen.lines.join('\n')

const done = (() => {
  const spy2 = createSpyTransport()
  const shell2 = createShell(spy2.transport)
  for (const char of '看看这个文件') shell2.key({ kind: 'char', char })
  shell2.key({ kind: 'enter' })
  spy2.emit(event('turn.start', {}, { id: 40 }))
  spy2.emit(event('model.delta', { channel: 'text', text: '我先看一眼。' }, { id: 41 }))
  spy2.emit(event('tool.call', { name: 'exec', args: { cmd: 'echo hi' } }, { id: 71 }))
  spy2.emit(event('tool.result', { call: 71, ok: true, output: { text: 'hi' } }, { id: 72 }))

  return shell2
})()

const finished = (await show([done.getView()], SCREEN, null)).screen.lines.join('\n')

const broken = (() => {
  const spy4 = createSpyTransport()
  const shell4 = createShell(spy4.transport)
  spy4.emit(event('tool.call', { name: 'exec', args: { cmd: 'make test' } }, { id: 71 }))
  spy4.emit(event('tool.result', { call: 71, ok: false, output: { text: '没有这个目标' } }, { id: 72 }))

  return shell4
})()

const failed = (await show([broken.getView()], SCREEN, null)).screen.lines.join('\n')

const held = (() => {
  const spy3 = createSpyTransport()
  const shell3 = createShell(spy3.transport)
  spy3.emit(event('tool.call', { name: 'write', args: { path: 'a.ts' } }, { id: 71 }))
  spy3.emit(
    event('tool.decision.request', { call: 71, name: 'write', material: '整写文件 a.ts', weight: 'heavy' }, { id: 88 }),
  )

  return shell3
})()

const awaiting = (await show([held.getView()], SCREEN, null, AT + 88)).screen.lines.join('\n')

const SCREENS = [running, finished, failed, awaiting]

/** 看一看某个记号在不在这几屏里。 */
const has = (mark: string): string => `${mark} ${SCREENS.some((one) => one.includes(mark)) ? '有' : '无'}`

console.log('── 记号 ──')
console.log(has('⏺')) // 助手那个记号（改前有，改后无）
console.log(has('⟳')) // 工具跑动那个（改前有，改后无）
console.log(has('✗')) // 失败那个（改前有，改后无——改后是 `×`）
console.log(has('×')) // 失败那个的新形（改前无，改后有）
console.log(has('✘')) // 带 emoji 变体那个（两棵树都不该有）
console.log(has('● 等你定夺')) // 等你与工作中同形（改前有，改后无）
console.log(has('▸')) // 工具行身份（改前无，改后有）
console.log(has('◊')) // 等你的形状（改前无，改后有）
console.log(has('✓')) // 成（两棵树都有）
console.log('── 工具行那一行的样子 ──')
console.log(running.split('\n').find((one) => one.includes('exec')) ?? '（没找到工具行）')
