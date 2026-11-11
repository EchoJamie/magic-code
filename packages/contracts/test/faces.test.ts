import { describe, expect, test } from 'bun:test'
import type { Binding, PlaceRequest } from '../src/scheduling/index.ts'
import type { Command, Entry } from '../src/conversation/index.ts'
import * as conversation from '../src/conversation/index.ts'
import * as scheduling from '../src/scheduling/index.ts'
import * as shared from '../src/shared/index.ts'

/** 类型入口的编译期证据——值入口另测。 */
const typeSurface = (_entry: Entry, _command: Command, _place: PlaceRequest, _binding: Binding): void => {}

describe('契约三面入口', () => {
  test('共享面有值语言（纯函数/常量）', () => {
    expect(typeof shared.resolveMagicHome).toBe('function')
    expect(typeof shared.expandHome).toBe('function')
    expect(typeof shared.MAGIC_DIR).toBe('string')
  })

  test('会话面有事件/命令值表', () => {
    expect(Array.isArray(conversation.TRANSIENT_EVENT_KINDS)).toBe(true)
  })

  test('调度面有放置动作词表', () => {
    expect(scheduling.PLACEMENT_ACTIONS).toEqual(['place', 'health', 'reclaim'])
  })

  test('类型入口可编译', () => {
    expect(typeof typeSurface).toBe('function')
  })
})
