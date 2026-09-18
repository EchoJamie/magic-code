/**
 * U19 · **上下文压缩全链** —— 长会话不爆（技术方案 · 上下文压缩（阶段 3））。
 *
 * 走**真装配**（真配置 → 真记录库 → 真对话域 → 真控制域），只有模型是替身。
 * 判据三条，各钉一处：
 *
 * 1. **压得动**——用量越阈值 ⇒ 开跑前压一次，模型下一次收到的上下文**真的短了**；
 * 2. **落得下**——摘要**条目**与 `context.compacted` **事件**都进了 SQLite（直读库表，
 *    不经 API 回读）；
 * 3. **接得上**——压完接着干，本轮照常收束；记录 append-only 不破（旧段一条不少）。
 *
 * ⚠️ 这条用例咬的是**装配那一行接线**（`AssembleOptions.context` → 对话实例的策略）：
 * 把那一行去掉，阈值就退回缺省（12 万 token），下面这些全部红。
 */

import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from '@magic/contracts'
import { attachShell } from '../src/index.ts'
import { eventsOfKind, lastModel, makeStage, readDatabase } from './support.ts'

/**
 * 八段脚本——先攒一段会话，再压，再接着干：
 * 第 1–5 轮（用量很低）· 第 6 轮（**越过阈值**）⇒ 第 7 条交代开跑前压一次 · 第 7 轮。
 * 中间那段摘要是**压缩那次调用**的脚本段（一次调用 ＝ 一段，与真接缝同形）。
 */
const TURNS = [
  { text: '答复一', usage: { inputTokens: 10, outputTokens: 5 } },
  { text: '答复二', usage: { inputTokens: 10, outputTokens: 5 } },
  { text: '答复三', usage: { inputTokens: 10, outputTokens: 5 } },
  { text: '答复四', usage: { inputTokens: 10, outputTokens: 5 } },
  { text: '答复五', usage: { inputTokens: 10, outputTokens: 5 } },
  { text: '答复六', usage: { inputTokens: 400, outputTokens: 5 } },
  { text: '摘要：前六件事都办完了，动过 /w' },
  { text: '答复七', usage: { inputTokens: 30, outputTokens: 5 } },
]

/** 前六条交代（第七轮开跑前会压一次）＋ 压完接着干的那一条。 */
const INPUTS = ['第一件事', '第二件事', '第三件事', '第四件事', '第五件事', '第六件事', '第七件事']

/** 送模型的那一份拼成一段文本。 */
function sentText(messages: readonly ModelMessage[]): string {
  return messages.map((message) => (message.role === 'tool' ? message.output : message.content)).join('\n')
}

describe('上下文压缩 · 全链（阈值触发 → 摘要入库 → 接着干活）', () => {
  test('压过之后：模型收到的短了、摘要条目落进库里、这一轮照常收束', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({
        turns: TURNS,
        // 触发与近段都压到脚本体量（实现级常量——装配期入参，不是用户配置）
        context: { compactAtTokens: 100, nearEntries: 1 },
      })
      const shell = attachShell(assembly.shell)

      for (const text of INPUTS) await shell.submit(text)
      shell.dispose()
      assembly.close()

      // —— 1 压得动：同一个网关的留痕——压前那一轮 vs 压后那一轮 ——
      const requests = lastModel(stage).requests
      expect(requests).toHaveLength(8) // 六轮 ＋ 摘要 ＋ 第七轮
      const before = requests[5]?.messages ?? [] // 第六轮：旧段全在
      const after = requests[7]?.messages ?? [] // 第七轮：旧段已被摘要顶掉
      expect(after.length).toBeLessThan(before.length)

      // 旧段不送了、近段（边界＝1 条）原文照旧在、摘要摆在其前
      const sent = sentText(after)
      expect(sent).toContain('第七件事')
      expect(sent).not.toContain('第一件事')
      expect(sent).toContain('摘要：前六件事都办完了')

      // —— 2 落得下：直读库表（不经 API 回读）——
      const db = readDatabase(assembly.paths.database)
      const entries = db.entries
      const eventKinds = db.events.map((event) => event.kind)
      db.close()

      expect(eventsOfKind(shell.events, 'context.compacted')).toHaveLength(1)

      // 记录 append-only 不破：前六轮一条不少，摘要**追加**在末尾
      expect(entries.map((entry) => entry.kind)).toEqual([
        ...Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? 'user' : 'assistant')),
        'user', // 第七件事的交代（压缩之前落账）
        'summary', // ← 压缩的产物
        'assistant', // 答复七
      ])
      const summary = entries.find((entry) => entry.kind === 'summary')
      expect(summary?.content_text).toContain('前六件事都办完了')
      expect(eventKinds).toContain('context.compacted')

      // —— 3 接得上：压完接着干，本轮照常收束 ——
      expect(eventsOfKind(shell.events, 'turn.end').at(-1)?.data).toEqual({ reason: 'settled' })
      expect(shell.events.at(-1)?.kind).toBe('agent.state')
      expect(shell.events.at(-1)?.data).toEqual({ state: 'waiting' })
    } finally {
      stage.dispose()
    }
  })
})
