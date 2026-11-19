/** 语音输入（U135）——外壳这一头：开、收、插字、取消。采音与转写在注入的那一条后面。 */

import { describe, expect, test } from 'bun:test'
import { createShell } from '../src/shell.ts'
import type { VoiceInput } from '../src/shell.ts'
import { createSpyTransport } from './fakes.ts'

/**
 * 假的语音那一条——记下 `stop` / `cancel` 各叫了几次，并把两种结局交回给用例。
 *
 * 它**只**替身「采音与转写」（那是本机能力，测试里不该真开麦克风）；
 * 外壳那一头的状态、插入与取消**走的都是真代码**。
 */
function fakeVoice(): {
  readonly voice: VoiceInput
  readonly calls: { starts: number; stops: number; cancels: number; listens: number }
  readonly say: (text: string) => void
  readonly fail: (code: string, message?: string) => void
  /** 模拟「右 ⌥ 被按了一下」（来自本机监听，不走终端）。 */
  readonly press: () => void
} {
  const calls = { starts: 0, stops: 0, cancels: 0, listens: 0 }
  let handlers: Parameters<VoiceInput['start']>[0] | null = null
  let tap: (() => void) | null = null
  return {
    calls,
    voice: {
      start: (next) => {
        calls.starts += 1
        handlers = next
        return {
          stop: () => { calls.stops += 1 },
          cancel: () => { calls.cancels += 1 },
        }
      },
      listen: (onTap) => {
        calls.listens += 1
        tap = onTap
        return () => { tap = null }
      },
    },
    say: (text) => { handlers?.onFinal(text) },
    fail: (code, message) => { handlers?.onError(code, message) },
    press: () => { tap?.() },
  }
}

describe('语音输入', () => {
  test('轻点一次开录，文字插在插入点，回车前不发送', () => {
    const voice = fakeVoice()
    const spy = createSpyTransport()
    const shell = createShell(spy.transport, { magicBase: '/test/.magic', voice: voice.voice })

    shell.key({ kind: 'voice' })
    expect(shell.getView().voice).toEqual({ state: 'recording' })

    voice.say('把按钮改成蓝色')
    // 插在**插入点**：原有正文一字不丢，插入点落在新字之后。
    expect(shell.getView().draft).toBe('把按钮改成蓝色')
    expect(shell.getView().caret).toBe(7)
    expect(shell.getView().voice).toBeNull()
    // **没有发送**：交代只在回车那一刻出队。
    expect(spy.commands.filter((command) => command.type === 'input.submit')).toHaveLength(0)

    shell.dispose()
  })

    test('右 ⌥ 那一下来自本机监听：按下就开录，与终端编码无关', () => {
    const voice = fakeVoice()
    const shell = createShell(createSpyTransport().transport, { magicBase: '/test/.magic', voice: voice.voice })
    // 与 `run.ts` 那一跳同形：按键从本机监听来，落到同一个 `toggleVoice`。
    const stop = voice.voice.listen(() => { shell.key({ kind: 'voice' }) })

    voice.press()
    expect(shell.getView().voice).toEqual({ state: 'recording' })

    voice.say('做个语音键的回归')
    expect(shell.getView().draft).toBe('做个语音键的回归')
    expect(shell.getView().voice).toBeNull()
    expect(voice.calls.listens).toBe(1)

    stop()
    shell.dispose()
  })

  test('说完再点一次＝收尾（转写中再点不叠第二次），结果照旧落到草稿', () => {
    const voice = fakeVoice()
    const shell = createShell(createSpyTransport().transport, { magicBase: '/test/.magic', voice: voice.voice })

    shell.key({ kind: 'voice' })
    shell.key({ kind: 'voice' })
    expect(voice.calls.stops).toBe(1)
    expect(shell.getView().voice).toEqual({ state: 'transcribing' })

    shell.key({ kind: 'voice' })
    expect(voice.calls.starts).toBe(1)

    voice.say('跑一遍测试')
    expect(shell.getView().draft).toBe('跑一遍测试')
    expect(shell.getView().voice).toBeNull()

    shell.dispose()
  })

  test('录音中按 Esc＝取消这一次：草稿不动，也不插字', () => {
    const voice = fakeVoice()
    const shell = createShell(createSpyTransport().transport, { magicBase: '/test/.magic', voice: voice.voice })

    shell.key({ kind: 'voice' })
    shell.key({ kind: 'escape' })

    expect(voice.calls.cancels).toBe(1)
    expect(shell.getView().voice).toBeNull()
    expect(shell.getView().draft).toBe('')

    voice.say('不该出现的字')
    expect(shell.getView().draft).toBe('')

    shell.dispose()
  })

  test('失败给一句能照做的话，并退出录音态', () => {
    const voice = fakeVoice()
    const shell = createShell(createSpyTransport().transport, { magicBase: '/test/.magic', voice: voice.voice })

    shell.key({ kind: 'voice' })
    voice.fail('denied')

    expect(shell.getView().voice).toBeNull()
    expect(shell.getView().draft).toBe('')
    const said = [...shell.getView().settled, ...shell.getView().rows]
      .map((row) => (row.kind === 'receipt' ? row.text : ''))
      .join('\n')
    expect(said).toContain('系统设置')

    shell.dispose()
  })

  test('没有语音那一条时按键无害（这台机器上不提供入口）', () => {
    const shell = createShell(createSpyTransport().transport, { magicBase: '/test/.magic' })

    shell.key({ kind: 'voice' })
    expect(shell.getView().voice ?? null).toBeNull()

    shell.dispose()
  })
})
