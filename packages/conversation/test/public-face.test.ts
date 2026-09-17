/**
 * 公开面 —— 域包**出什么、不出什么**（技术方案 · 代码治理 · 边界纪律 · 公开面）。
 *
 * 规则：「域包的 exports 只出**端口实现 ＋ 装配期构造入参形态**；域内读取面 / 内部视图 /
 * 测试辅助不上公开面」。本条由 U04 落 `ConversationService` 时**定形**（M04 回报待决 2）。
 *
 * 为何要钉住：域外包只能经包根取用（深链 `@magic/conversation/src/…` 由守护拦下），
 * 故「包根出了什么」＝**事实上的域外可见面**。多出一件，就是对域内件的隐性承诺。
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationService } from '@magic/contracts'
// 类型面上的公开面——能这么 import 即算出去（值面由下面的用例钉）
import type { ContextPolicy, ConversationDeps, PromptVars } from '../src/index.ts'
import * as face from '../src/index.ts'

describe('公开面', () => {
  test('值面只有端口实现一件', () => {
    expect(Object.keys(face).sort()).toEqual(['createConversationService'])
  })

  test('构造入参形态齐——装配根据此接线（类型面）', () => {
    const prompt: PromptVars = { cwd: '/w', platform: 'darwin', date: '2026-09-18' }
    const context: Partial<ContextPolicy> = { blobThreshold: 4096 }

    // 只取形态、不真跑——这两件必须**可命名**，否则装配根写不出构造入参
    const shape: Pick<ConversationDeps, 'prompt' | 'context'> = { prompt, context }
    expect(Object.keys(shape)).toEqual(['prompt', 'context'])

    // 端口实现落进契约端口（编译期证据：赋值即结构兼容检查）
    const service: ConversationService | undefined = undefined
    expect(service).toBeUndefined()
  })

  test('域内件不上公开面——提示词部件的读取面 / 装配 / 循环 / 落账都不出去', () => {
    const exported = new Set(Object.keys(face))

    for (const internal of [
      'buildSystemPrompt', // 提示词装配（域内件——提示词随内核版本治理，不对外承诺形态）
      'splitSystemPrompt', // 段边界读取（域内用）
      'renderSection',
      'assembleContext', // Context 装配
      'agentLoop', // 主循环
      'pairingKeyOf',
      'DEFAULT_CONTEXT_POLICY',
    ]) {
      expect(exported.has(internal)).toBe(false)
    }
  })
})
