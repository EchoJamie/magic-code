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
 * 5. **权限是窄的**——判轻的一件都不问（三件内置辅助工具正在此列）；**名单里那两条照问**
 *    （U76 起：默认通，闸门只管「禁止」——**原锚**「别的工具照旧要问」那一条对 `read`
 *    已不成立，它判轻、默认通）。
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

describe('U34 · 权限是窄的', () => {
  test('判轻的一件都不问（`plan_read` / `read` 都在内）；**名单里那两条照问**', async () => {
    const stage = makeStage()
    const requests: KernelEvent[] = []

    try {
      const assembly = stage.assemble({
        turns: [
          {
            toolCalls: [
              { name: 'plan_read', args: {} },
              { name: 'read', args: { path: 'src/login.ts' } },
              // ⚠️ **原锚**：第三件原来是「别的工具」——拿 `read` 当那一件（那时它**要问**）；
              // **为何变**：U76 起 `read` 判轻 ⇒ **默认通、不留卡**（与 `plan_read` 同一形，
              // 规则的那三个名字不再是它通不通的由来）；**新锚**：判据换成工单那一条
              // 「**名单里那两条照问**」——第三件取名单第一类（删除），被问的只该是它。
              { name: 'exec', args: { cmd: 'chmod 755 .' } },
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

      const asked = eventsOfKind(requests, 'tool.decision.request')
      expect(asked).toHaveLength(1)
      // 被问的是名单里的 `exec`（删除），两件判轻的一件都没问
      expect(asked[0]?.data.name).toBe('exec')
      expect(asked[0]?.data.weight).toBe('heavy')

      const verdicts = eventsOfKind(requests, 'tool.decision')
      expect(verdicts.map((one) => [one.data.decider, one.data.decision])).toEqual([
        ['auto', 'approve'],
        ['auto', 'approve'],
        ['user', 'approve'],
      ])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
