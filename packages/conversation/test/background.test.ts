/**
 * U89 · **还在跑的后台命令**块（`prompt/background.ts`）——渲染那一半的判据。
 *
 * 设计 · 提示词与指令 甲 ②（2026-09-26 定）：那一条要**进每回合重建的块**，
 * 且「**没有后台任务就不出现**」。本文件咬住的就是这两句在文本层的样子：
 *
 * 1. **一条要有哪几件**——编号（`〔bg-N〕`，与 U70 回执同一个词）· 命令（够认出来是哪一条）·
 *    **还在跑这件事本身**（逐行写着——模型最容易把「读到过」当成「已结束」）；
 * 2. ⚠️ **没有在跑的就整块不出现**——不是有一个空块，也不是钉一句「当前没有后台任务」；
 * 3. **块界认得它**（`splitSystemPrompt`）——标题不在表里的话，这一块会被算进上一块里，
 *    而「逐块相符」那条往返断言就当场红（本文件也走一遍真产物）。
 */

import { describe, expect, test } from 'bun:test'
import type { BackgroundRunning } from '@magic/contracts'
import {
  BACKGROUND_HEADING,
  buildSystemPrompt,
  splitSystemPrompt,
  withBackgroundRuns,
} from '../src/prompt/index.ts'

const VARS = { cwd: '/ws/magic-code', platform: 'darwin', date: '2026-09-26' }

/** 一条在跑的后台命令（三件齐——读面给的就是这三件）。 */
function running(over: Partial<BackgroundRunning> = {}): BackgroundRunning {
  return {
    id: 'bg-1',
    command: 'npm run dev',
    outputPath: '/run/abc/bg/bg-1.log',
    ...over,
  }
}

describe('U89 · 块里有什么（工单 ①：编号 · 命令 · 还在跑）', () => {
  test('一条一行：编号 · 命令 · 还在跑（＋ 输出文件）', () => {
    const text = withBackgroundRuns('base', [running()])

    expect(text).toContain(BACKGROUND_HEADING)
    const line = text.split('\n').find((one) => one.startsWith('- '))
    // 逐字——一行上四件都看得见（编号同 U70 的 `〔bg-N〕`，命令原样）
    expect(line).toBe('- 〔bg-1〕npm run dev（还在跑 · 输出文件 /run/abc/bg/bg-1.log）')
  })

  test('**还在跑**写在每一行上，不只写在标题里', () => {
    const [, second] = [running(), running({ id: 'bg-2', command: 'watch build' })]
    const text = withBackgroundRuns('base', [running(), second as BackgroundRunning])

    const lines = text.split('\n').filter((one) => one.startsWith('- '))
    expect(lines.length).toBe(2)
    // 两行各自都写着「还在跑」——只写在标题上时，抽走一行就会开始撒谎
    for (const line of lines) expect(line).toContain('还在跑')
  })

  test('多行命令只取首行（那一行才是「这是哪条命令」）', () => {
    const text = withBackgroundRuns('base', [running({ command: 'set -e\nnpm run dev\nnpm run watch' })])

    expect(text).toContain('- 〔bg-1〕set -e（还在跑')
    // 后面的行一个字都不进块——多行命令会把块撑成一整段
    expect(text).not.toContain('npm run watch')
  })

  test('超长命令按 80 字截断（**与 U70 那条完成消息同一个数**）', () => {
    const long = 'x'.repeat(120)
    const text = withBackgroundRuns('base', [running({ command: long })])

    expect(text).toContain(`- 〔bg-1〕${'x'.repeat(80)}…（还在跑`)
  })

  test('几条按**交出去的次序**排（读面给什么序，就什么序）', () => {
    const text = withBackgroundRuns('base', [
      running({ id: 'bg-1', command: 'a' }),
      running({ id: 'bg-2', command: 'b' }),
    ])

    expect(text.indexOf('〔bg-1〕')).toBeLessThan(text.indexOf('〔bg-2〕'))
  })
})

describe('U89 · 没有在跑的就不出现（工单 ③ 的文本层那一半）', () => {
  test('空表 ⇒ 块不出现（`withBackgroundRuns` 原样交回）', () => {
    const base = buildSystemPrompt(VARS)

    expect(withBackgroundRuns(base, [])).toBe(base)
    expect(withBackgroundRuns(base, [])).not.toContain(BACKGROUND_HEADING)
  })

  test('⚠️ 空表时**不钉一句空话**——「当前没有后台任务」那种话一个字都不留', () => {
    const text = withBackgroundRuns(buildSystemPrompt(VARS), [])

    expect(text).not.toContain('没有后台任务')
    expect(text).not.toContain('后台')
  })

  test('有在跑的 ⇒ 接在末尾（原产物一字不动）', () => {
    const base = buildSystemPrompt(VARS)
    const text = withBackgroundRuns(base, [running()])

    expect(text.startsWith(base)).toBe(true)
    expect(text).toBe(`${base}\n\n${text.slice(base.length + 2)}`)
    expect(text.trimEnd()).toBe(text)
  })
})

describe('U89 · 块界（`splitSystemPrompt` 认得出它）', () => {
  test('切得开：后台那一块自成一块，不被算进上一块里', () => {
    const prompt = withBackgroundRuns(buildSystemPrompt(VARS), [running()])
    const blocks = splitSystemPrompt(prompt)

    const last = blocks.at(-1)
    expect(last?.heading).toBe(BACKGROUND_HEADING)
    expect(last?.text).toBe(withBackgroundRuns('', [running()]).trim())
    // 读得出来就是读得出来——块的正文里没有别的块的标题
    expect(last?.body).not.toContain('## ')
  })

  test('切回来拼得回原文（块的划分无遗漏）', () => {
    const prompt = withBackgroundRuns(buildSystemPrompt(VARS), [running()])

    expect(splitSystemPrompt(prompt).map((block) => block.text).join('\n\n')).toBe(prompt)
  })
})
