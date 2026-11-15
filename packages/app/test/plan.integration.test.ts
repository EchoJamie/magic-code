/**
 * U34 · **计划与历史全链**（真装配 × 真记录库 × 真闸门 × 真对话域，只有模型是替身）。
 *
 * 判据照设计的验收条走，各咬一处接线：
 *
 * 1. **模型真的能写能读**——工具调用 → 条目落账（直读库表）→ `plan.changed` 通报 →
 *    下一趟请求里带着完整笔记。不是测试专用函数：走的是装配接出来的那三件真工具。
 * 2. **跨会话不串**——另一条会话读不到这边建的笔记（读面绑的是会话，不是进程）。
 * 3. **压缩之后仍取得到**——旧段被摘要顶掉之后，最新笔记重新落进请求里；
 *    清空同样生效，重开不复活。
 * 4. **回查真的回得到**——压掉的那段历史按记录位置读得回来（含续读位置与节选标记）。
 * 5. **权限是窄的**——默认放行（三件内置辅助工具与判轻的 `read` 都在此列）；
 *    **禁止清单里的那族照拒**（U129）。
 *
 * ⚠️ 这一条用例咬的是**装配那一行接线**（`open` 里造读面 ＋ 追加三件工具 ＋ 追加三条规则）：
 * 去掉任何一处，下面各自的那条就红。
 * ⚠️ U76 之后，那**三条内存规则**对这三件工具已不再决定什么（它们判轻 ⇒ 默认通；
 * 规则在链上只剩「外发按域名」一处够得着判重的调用）——接线仍在，判据改咬上面那一条。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent } from '@magic/contracts'
import { attachShell } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'

describe('权限是窄的', () => {
  test('判轻的一件都不问（`plan_read` / `read` 都在内）；**禁止清单里的照拒**', async () => {
    const stage = makeStage()
    const requests: KernelEvent[] = []

    try {
      const assembly = stage.assemble({
        turns: [
          {
            toolCalls: [
              { name: 'plan_read', args: {} },
              { name: 'read', args: { path: 'src/login.ts' } },
              // U129：第三件取**禁止清单**里的删除——前两件默认放行，只有它被内核拒。
              { name: 'exec', args: { command: 'rm -rf build' } },
            ],
          },
          { text: '好' },
        ],
      })
      const off = assembly.shell.subscribe((event) => requests.push(event))
      const shell = attachShell(assembly.shell)

      await shell.submit('看一眼')
      off()
      shell.dispose()

      const verdicts = eventsOfKind(requests, 'tool.decision')
      expect(verdicts.map((one) => [one.data.decider, one.data.decision])).toEqual([
        ['auto', 'approve'],
        ['auto', 'approve'],
        ['kernel', 'reject'],
      ])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
