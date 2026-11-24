/**
 * AI 标题 · **装配接线**（docs/会话标题方案.md）。
 *
 * 域内用例（`packages/runtime/conversation/test/title.test.ts`）钉**行为**；本文件钉
 * **生产接线**：`aiTitle: true` 经真装配激活——首条交代落账后旁路起一次标题、写入与改名
 * 同一个 `sessions.title`；不给这门＝一次标题调用都没有（这正是既有用例脚本对齐
 * 不受影响的正面证明）。
 *
 * 标题生成与主轮的先后不定（旁路不阻塞轮次），两段脚本同文——断言不赌时序。
 */

import { describe, expect, test } from 'bun:test'
import type { ModelRequest } from '@magic/contracts'
import { attachShell } from '../src/index.ts'
import { makeStage } from './support.ts'

/** 标题请求的判据——两则消息，system 首条以命名指令开头（与 `title.ts` 同源）。 */
const isTitleRequest = (request: ModelRequest): boolean =>
  request.messages.length === 2
  && request.messages[0]!.role === 'system'
  && typeof request.messages[0]!.content === 'string'
  && (request.messages[0]!.content as string).startsWith('根据这次编码会话')

/** 等标题落库（旁路生成不阻塞轮次，收口靠轮询）。 */
async function waitForTitle(assembly: { readonly records: { listSessions(): Promise<readonly { id: string; title?: string }[]> } }): Promise<string | undefined> {
  for (let i = 0; i < 200; i += 1) {
    const row = (await assembly.records.listSessions())[0]
    if (row?.title !== undefined) return row.title
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return undefined
}

describe('AI 标题 · 装配接线', () => {
  test('aiTitle: true——首条交代落账后旁路起标题，写入 sessions.title', async () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({
        turns: [{ text: '修复移动端登录按钮' }, { text: '修复移动端登录按钮' }],
        aiTitle: true,
      })
      const shell = attachShell(assembly.shell, { timeoutMs: 10_000 })
      try {
        await shell.submit('帮我看一下移动端登录页为什么点登录没反应')
      } finally {
        shell.dispose()
      }

      const title = await waitForTitle(assembly)
      expect(title).toBe('修复移动端登录按钮')

      // 真发出去的那份请求：交代包在 <session> 数据标签里，不带工具
      const gateway = stage.models[0]!
      const titleRequest = gateway.requests.find(isTitleRequest)
      expect(titleRequest).toBeDefined()
      expect(titleRequest!.tools).toBeUndefined()
      const user = titleRequest!.messages[1]!
      expect(user.role).toBe('user')
      if (user.role !== 'user' || typeof user.content !== 'string') throw new Error('标题请求的第二则应是文本用户消息')
      expect(user.content).toContain('<session>')
      expect(user.content).toContain('帮我看一下移动端登录页')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('不给 aiTitle＝不做（一次标题调用都没有，标题缺席）', async () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({ turns: [{ text: '好的。' }] })
      const shell = attachShell(assembly.shell, { timeoutMs: 10_000 })
      try {
        await shell.submit('第一条交代')
      } finally {
        shell.dispose()
      }

      const gateway = stage.models[0]!
      expect(gateway.requests.find(isTitleRequest)).toBeUndefined()

      const row = (await assembly.records.listSessions())[0]
      expect(row?.title).toBeUndefined()

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
