/**
 * 规格即测试 · **U25 启动入口**——「放开输入」以 `boot` 完成为界，逐条落成用例。
 *
 * 出处：`技术方案.md`·装配视图第 5 步（2026-09-19 补 · 审计待核④）——
 * 「**「放开输入」的准确定义**——**以 `boot` 完成为界**：订阅接上、装配就绪之后才受理
 * `input.submit`（否则事件发了没人收 ✗）。**不是「外壳一挂载就能提交」**。
 * ⚠️ 同一节还写着「实现待收敛：现在 `run.ts` 的『挂载即可提交』与 `cli.ts` 注释的
 * 『`boot` 完成后』**两种读法并存**……⇒ **归 `U25` 一并收敛**」——本文件就是那次收敛的判据。
 *
 * ## 判据锚的是「我要什么」，不是「现在跑成什么样」
 *
 * | # | 我要什么（规格） | 用例在哪 |
 * | --- | --- | --- |
 * | ① | 放开之前：**回车不受理**（不发 `input.submit`），且**不静默**（当场说一句、草稿留着） | `describe('①')` |
 * | ② | 放开之后：照常受理（闸是「晚一点」，不是「不让发」） | `describe('②')` |
 * | ③ | 放开之前，右位提示说的是**启动中**——「按了没反应」要看得见 | `describe('③')` |
 * | ④ | 别的命令路径也拦得住（选择器 / 裁决此刻本不该有，有也一并拦下） | `describe('④')` |
 *
 * ⚠️ **不设闸的调用方照旧**（`inputReady` 缺省 `true`）：不起 `boot` 的测试 / 演示
 * 一挂载就能提交——本文件之外的全部外壳用例都不改一行，正是这条缺省在保。
 */

import { describe, expect, test } from 'bun:test'
import type { Command } from '@magic/contracts'
import { HINT_BOOTING, HINT_IDLE } from '../src/view.ts'
import { createShell } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'

/** 起一个**按了闸**的壳（`boot` 还没跑完的那种）。 */
function held() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, { inputReady: false })

  return {
    shell,
    spy,
    type(text: string) {
      for (const char of text) shell.key({ kind: 'char', char })
    },
    enter() {
      return shell.key({ kind: 'enter' })
    },
    commands: () => spy.commands as readonly Command[],
  }
}

describe('① 放开之前：回车不受理', () => {
  test('打字进草稿（本地的事），回车**不发命令**、草稿也**不清**', () => {
    const app = held()

    app.type('先打着的草稿')
    expect(app.shell.getView().draft).toBe('先打着的草稿')

    app.enter()

    expect(app.commands()).toEqual([]) // 一条都不发
    expect(app.shell.getView().draft).toBe('先打着的草稿') // 草稿留着——跑完再按一次即可
  })

  test('**不静默**——当场说一句（「按了没反应」是最难查的那种）', () => {
    const app = held()
    app.type('问一句')
    app.enter()

    expect(app.shell.getView().flash).toContain('正在启动')
  })
})

describe('② 放开之后：照常受理', () => {
  test('`releaseInput()` 一调，同样的回车就发出去了', () => {
    const app = held()
    app.type('问一句')
    app.enter()
    expect(app.commands()).toEqual([])

    app.shell.releaseInput()
    app.enter()

    // `ref` ＝ 提交的配对键（U33）
    expect(app.commands()).toEqual([{ type: 'input.submit', text: '问一句', ref: 'draft-1' }])
    expect(app.shell.getView().draft).toBe('') // 提交了＝草稿清空（与常态逐字一致）
  })

  test('幂等——重复放开只是再翻一次真；右位提示回落到本来那一条', () => {
    const app = held()

    app.shell.releaseInput()
    app.shell.releaseInput()

    expect(app.shell.getView().status.hint).toBe(HINT_IDLE)
  })
})

describe('③ 右位提示说「启动中」', () => {
  test('按了闸的壳一开局就报；放开之后回落', () => {
    const app = held()
    expect(app.shell.getView().status.hint).toBe(HINT_BOOTING)

    app.shell.releaseInput()
    expect(app.shell.getView().status.hint).toBe(HINT_IDLE)
  })

  test('**别的路径也抹不掉它**——打字 / 内核事件都不许把它翻回常态', () => {
    // 由头：这道提示要一直挂到「放开」那一下。可它待在**视图**里，而视图的每一处改动
    // 都可能顺手重算右位提示（打字经 `withCompletion`、`agent.state{waiting}` 经 `reduce`
    // ——恢复自己就会发后者）。抹掉了会怎样：屏上看着「空闲 · 可以打」，而回车照旧不受理
    // ⇒「按了没反应」重现，正是这道闸要防的那种。
    const app = held()

    app.type('先打着草稿')
    expect(app.shell.getView().status.hint).toBe(HINT_BOOTING)

    app.spy.emit(event('agent.state', { state: 'waiting' }, { id: 99 }))
    expect(app.shell.getView().status.hint).toBe(HINT_BOOTING)

    app.shell.releaseInput()
    expect(app.shell.getView().status.hint).toBe(HINT_IDLE)
  })

  test('**不设闸的调用方**（缺省）一开局就是常态提示——闸只落在要等 `boot` 的那条路上', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    expect(shell.getView().status.hint).toBe(HINT_IDLE)
  })
})

describe('④ 别的命令路径也拦得住', () => {
  test('放开之前，`readHistory` 那类命令同样不出去（兜底那道闸）', () => {
    const app = held()

    app.shell.readHistory()

    expect(app.commands()).toEqual([])
  })
})
