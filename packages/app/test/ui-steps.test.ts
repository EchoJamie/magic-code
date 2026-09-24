/**
 * U51 · **步骤文件那一份契约**——解析这一层（`test/ui/steps.ts`）的用例。
 *
 * 为什么要它：`ui script <步骤文件>` 是这一轮给「任何 agent」开的那条入口——**写错文件的人
 * 是第一次用它的 agent**，故「哪一条坏在哪儿」得当场说清楚（不是跑到一半炸在别处）。
 * 起真应用那一趟不在这一层（那是 `ui.test.ts` 与各 `frames-*` 的事），这里只钉**格式**。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../test/ui/driver.ts'
import { parseSteps } from '../test/ui/steps.ts'

describe('U51 · 步骤文件：解析', () => {
  test('对象形与数组形都收——`steps` 是同一件事的两种写法', () => {
    const object = parseSteps('{"label":"甲","steps":[{"cmd":"capture"}]}')
    expect(object.label).toBe('甲')
    expect(object.steps.length).toBe(1)

    const bare = parseSteps('[{"cmd":"capture"}]')
    expect(bare.label).toBeUndefined()
    expect(bare.steps.length).toBe(1)
  })

  test('**坏在哪儿就说哪儿**——三条常见的错各自点名', () => {
    expect(() => parseSteps('{ 这不是 JSON')).toThrow(/不是合法 JSON/)
    expect(() => parseSteps('{"label":"甲"}')).toThrow(/没有 steps/)
    expect(() => parseSteps('[{"cmd":"没有这条命令"}]')).toThrow(/第 1 条的 cmd 不认得/)
    expect(() => parseSteps('[{"cmd":"capture"},{"text":"缺 cmd"}]')).toThrow(/第 2 条缺 cmd/)
  })

  test('**报错里列得出有哪些命令**——第一次用的人据此改', () => {
    try {
      parseSteps('[{"cmd":"飞"}]')
      throw new Error('本该抛')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      for (const cmd of ['start', 'send', 'key', 'resize', 'wait', 'capture', 'quit', 'close']) {
        expect(message).toContain(cmd)
      }
    }
  })

  test('**仓库里那份例子能跑**——它是给「第一次用」的人照抄的，不许过期', () => {
    const text = readFileSync(join(REPO_ROOT, 'packages', 'app', 'test', 'ui', 'example-steps.json'), 'utf8')
    const steps = parseSteps(text)

    expect(steps.steps.length).toBeGreaterThan(0)
    // 例子的形状：起一扇窗、跑一段、取帧、收摊——少一步它就不是「照抄能跑」的那份了
    const cmds = steps.steps.map((step) => step.cmd)
    expect(cmds).toContain('start')
    expect(cmds).toContain('capture')
    expect(cmds).toContain('close')
    // `start` 的 `as` 与后面步骤指的名字**对得上**（对不上就是抄了也跑不起来）
    const asi = steps.steps.find((step) => step.as !== undefined)?.as as string
    expect(asi).toBeDefined()
    expect(steps.steps.some((step) => step.session === asi)).toBe(true)
  })
})
