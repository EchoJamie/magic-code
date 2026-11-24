/**
 * 终端页签标题（OSC 0 · `tab-title.ts`）——② 那一格的会话名同步到页签 / 窗口标题。
 *
 * 钉四件事：清洗（控制字符剔除防 OSC 注入 · 空白折叠 · 字素截断）· 去重（变更才写）
 * · 兜底（无标题按状态行同一口径「新会话」）· 收摊清空（写空 OSC，不假装能恢复原值）。
 * 外壳侧的接线（`commit` 同源 / `dispose` 清空）以「接线用例」直接驱动 `createShell` 验。
 */

import { describe, expect, test } from 'bun:test'
import type { ControlTransport, KernelEvent } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import type { TabTitleWriter } from '../src/tab-title.ts'
import { TAB_TITLE_MAX_CHARS, createTabTitleWriter, sanitizeTabTitle } from '../src/tab-title.ts'
import { DEFAULT_TEST_SESSION } from '@magic/faux'

/** 假写出面——收到的每一段原样留痕。 */
function fakeOut(): { writes: string[]; out: { write(text: string): void } } {
  const writes: string[] = []
  return { writes, out: { write: text => writes.push(text) } }
}

describe('清洗（sanitizeTabTitle）', () => {
  test('控制字符（C0 / DEL / C1）剔除并折成词界空格——OSC 注入进不了标题', () => {
    expect(sanitizeTabTitle('修\u001b]0;坏\u0007了')).toBe('修 ]0;坏 了')
    expect(sanitizeTabTitle('a\u001b[2Jb')).toBe('a [2Jb')
    expect(sanitizeTabTitle('x\u0000\u007f\u009by')).toBe('x y')
  })

  test('空白折叠成单空格；首尾不留白', () => {
    expect(sanitizeTabTitle('  修复  移动端\n登录\t按钮  ')).toBe('修复 移动端 登录 按钮')
  })

  test('字素截断——按上限收（含省略号前的合并字素不切坏）', () => {
    const long = '修'.repeat(TAB_TITLE_MAX_CHARS + 10)
    expect([...sanitizeTabTitle(long)].length).toBe(TAB_TITLE_MAX_CHARS)
  })

  test('全空（剔除后什么都不剩）＝空串——调用方据此不写', () => {
    expect(sanitizeTabTitle('\u001b\u0007')).toBe('')
    expect(sanitizeTabTitle('   ')).toBe('')
  })
})

describe('写出器（createTabTitleWriter）', () => {
  test('变更才写：同名不重写；换名才写新一条', () => {
    const { writes, out } = fakeOut()
    const writer = createTabTitleWriter(out)

    writer.update('修复移动端登录按钮')
    writer.update('修复移动端登录按钮')
    expect(writes).toEqual(['\x1b]0;修复移动端登录按钮\x07'])

    writer.update('接入 OAuth 认证')
    expect(writes.length).toBe(2)
    expect(writes[1]).toBe('\x1b]0;接入 OAuth 认证\x07')
  })

  test('null 按状态行同一口径兜「新会话」；清洗后全空＝不写也不清', () => {
    const { writes, out } = fakeOut()
    const writer = createTabTitleWriter(out)

    writer.update(null)
    expect(writes).toEqual(['\x1b]0;新会话\x07'])

    const blank = createTabTitleWriter({ write: () => writes.push('blank') })
    blank.update('\u001b\u0007')
    expect(writes.length).toBe(1) // 只有上一条；空白标题没有写出
  })

  test('clear 写空 OSC 且只在写过之后；清完可再写', () => {
    const { writes, out } = fakeOut()
    const writer = createTabTitleWriter(out)

    writer.clear()
    expect(writes).toEqual([]) // 什么都没写过＝没什么可清

    writer.update('修复移动端登录按钮')
    writer.clear()
    expect(writes.at(-1)).toBe('\x1b]0;\x07')

    writer.update('新标题')
    expect(writes.at(-1)).toBe('\x1b]0;新标题\x07')
  })
})

describe('外壳接线（commit 同源 · dispose 清空）', () => {
  /** 最小的外壳构造——假 transport 收下订阅者，测试直接朝它发事件。 */
  function shellWith(writer: TabTitleWriter) {
    let listener: ((event: KernelEvent) => void) | undefined
    const transport: ControlTransport = {
      send: () => {},
      subscribe: (l: (event: KernelEvent) => void) => { listener = l; return () => { listener = undefined } },
    } as unknown as ControlTransport
    return {
      emit: (event: KernelEvent) => listener?.(event),
      shell: createShell(transport, { magicBase: '/test/.magic', tabTitle: writer }),
    }
  }

  const sessionState = (title: string): KernelEvent =>
    ({ kind: 'session.state', data: { active: DEFAULT_TEST_SESSION, sessions: [{ id: DEFAULT_TEST_SESSION, at: 1, archived: false, title }] } } as never)

  test('session.state 的标题落 ② 的同时也落页签', () => {
    const { writes, out } = fakeOut()
    const { emit, shell } = shellWith(createTabTitleWriter(out))

    emit(sessionState('修复移动端登录按钮'))

    expect(writes).toEqual(['\x1b]0;修复移动端登录按钮\x07'])
    shell.dispose()
  })

  test('dispose 清掉自己写过的标题', () => {
    const { writes, out } = fakeOut()
    const { emit, shell } = shellWith(createTabTitleWriter(out))

    emit(sessionState('修复移动端登录按钮'))
    shell.dispose()

    expect(writes.at(-1)).toBe('\x1b]0;\x07')
  })

  test('没有接写出面＝什么都不发生（旧装配行为一字不动）', () => {
    let listener: ((event: KernelEvent) => void) | undefined
    const transport: ControlTransport = {
      send: () => {},
      subscribe: (l: (event: KernelEvent) => void) => { listener = l; return () => { listener = undefined } },
    } as unknown as ControlTransport
    const shell = createShell(transport, { magicBase: '/test/.magic' })

    listener?.(sessionState('修复移动端登录按钮'))
    expect(() => shell.dispose()).not.toThrow()
  })
})
