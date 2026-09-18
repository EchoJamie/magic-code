/**
 * 启动（U09）——`runTui` 的边角：不是终端时**说人话**。
 *
 * Ink 在非 TTY 上会抛 raw mode 的栈（「Raw mode is not supported…」）——用户看不懂，
 * 也不是他的错。启动前先拦一道，把话说清楚。
 */

import { describe, expect, test } from 'bun:test'
import { runTui } from '../src/run.ts'
import { createSpyTransport } from './fakes.ts'

/** 假流——只喂 `runTui` 会看的字段（拦在渲染之前，故不必像样）。 */
const fakeStdin = (isTTY: boolean): NodeJS.ReadStream => ({ isTTY }) as unknown as NodeJS.ReadStream
const fakeStdout = (): NodeJS.WriteStream => ({ isTTY: false }) as unknown as NodeJS.WriteStream

describe('启动前置', () => {
  test('stdin 不是终端——明确报错（不抛 Ink 的 raw mode 栈）', async () => {
    const spy = createSpyTransport()

    // 前置检查停在任何 `await` 之前——故这里断言的是**当场抛**（不是「以后拒绝」）
    expect(() =>
      runTui({ transport: spy.transport, stdin: fakeStdin(false), stdout: fakeStdout() }),
    ).toThrow(/终端/)
  })
})
