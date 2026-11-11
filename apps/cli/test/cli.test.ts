/** CLI 真子进程：help/version/离线 check 不启动 App，不开库或运行外部工具。 */

import { describe, expect, test } from 'bun:test'

import { parseArgs } from '../src/cli.ts'

describe('入口 magic · 接续（`resume` · 恢复入口）', () => {
  test('旧选项、缺少 id、重复 resume 和多余位置参数明确拒绝', () => {
    for (const argv of [
      ['--session', 's-old'], ['resume'], ['resume', ''], ['resume', '   '],
      ['resume', '-v'], ['resume', '--model', 'spell'],
      ['resume', 'one', 'resume', 'two'], ['resume', 'one', 'two'],
    ]) expect(() => parseArgs(argv)).toThrow()
    expect(parseArgs(['resume', "会话 ' 中文", '--model', 'spell']).session).toBe("会话 ' 中文")
    expect(parseArgs(['--model', 'spell', 'resume', 's-one']).session).toBe('s-one')
  })
})
