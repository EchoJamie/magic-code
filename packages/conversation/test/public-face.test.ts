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
import type { SessionHostDeps } from '../src/index.ts'
import * as face from '../src/index.ts'

describe('公开面', () => {
  test('值面精确枚举——会话与计划端口、实例工厂及常驻宿主的纯读目录入口', () => {
    // 常驻宿主复用域内目录适配，纯读入口不创建会话实例；仍不公开循环与内部装配。
    expect(Object.keys(face).sort()).toEqual([
      'createConversationService',
      'createConversationSession',
      'createPlanReader',
      'readSessionCatalog',
      'readSessionDisplayHistory',
      'summarize',
    ])
  })

  test('常驻宿主工厂符合会话端口契约', () => {
    // 端口实现落进契约端口（编译期证据：赋值即结构兼容检查）——
    // U16 起 `createConversationService` 返回**主面**，它才是端口的那一半
    const factory: (deps: SessionHostDeps) => ConversationService = face.createConversationService
    expect(typeof factory).toBe('function')
  })
})
