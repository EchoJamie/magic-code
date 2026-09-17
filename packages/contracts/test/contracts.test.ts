/**
 * 契约包测试（M01 · 契约包重组）。
 *
 * 契约是**纯类型层**——运行时几无可断言之物，故这里做三件事：
 * 1. **类型层探针**——判别联合收窄 · 信封构造面 · 端口可实现（由 tsc 校验；
 *    `bun test` 只剥离类型，不做检查）；
 * 2. 规则载体（常量与纯函数）的运行时断言；
 * 3. **迁移忠实性**——重组后旧契约的对外语义逐条仍成立。
 */

import { describe, expect, test } from 'bun:test'
import {
  DECISION_REQUEST_KIND,
  RECORD_SCHEMA_VERSION,
  TOOLSET_V1,
  TRANSIENT_EVENT_KINDS,
  apiKeyEnvVarOf,
  expandDataDir,
} from '../src/index.ts'
import type {
  Command,
  Entry,
  EntryRange,
  EventEnvelope,
  ExecResult,
  KernelEvent,
  NewEntry,
  Sandbox,
  ToolCallPayload,
  ToolResultPayload,
} from '../src/index.ts'

// ══ 类型层探针（tsc 校验；运行时无操作）══════════════════════════════

/** 判别联合视图——按 `kind` 自动收窄 `data`（M01 补锚 3）。 */
export function kernelEventNarrowsByKind(): void {
  const events: readonly KernelEvent[] = [
    {
      id: 1,
      session: 's1',
      turn: null,
      at: 0,
      kind: 'tool.call',
      data: { name: 'exec', args: { cmd: 'ls' } },
    },
    {
      id: 2,
      session: 's1',
      turn: 1,
      at: 1,
      kind: 'tool.output.delta',
      data: { call: 1, channel: 'stdout', text: 'hi' },
    },
    {
      id: 3,
      session: 's1',
      turn: 1,
      at: 2,
      kind: 'model.usage',
      data: { inputTokens: 12, outputTokens: 3 },
    },
  ]

  for (const e of events) {
    if (e.kind === 'tool.call') {
      const name: string = e.data.name // 收窄生效——联合里只有它带 name
      void name
    }
    if (e.kind === 'tool.output.delta') {
      const ch: 'stdout' | 'stderr' = e.data.channel
      void ch
    }
    if (e.kind === 'model.usage') {
      const tokens: number = e.data.inputTokens
      void tokens
    }
  }
}

/** 信封构造面——泛型收窄到单 kind。 */
export function envelopeConstructsByKind(): void {
  const delta: EventEnvelope<'tool.output.delta'> = {
    id: 1,
    session: 's1',
    turn: 1,
    at: 0,
    kind: 'tool.output.delta',
    data: { call: 1, channel: 'stderr', text: 'oops' },
  }

  // @ts-expect-error 收窄生效——`model.usage` 的形态不得塞进 `tool.call` 的 data
  const wrongShape: EventEnvelope<'tool.call'>['data'] = { inputTokens: 1, outputTokens: 2 }

  void delta
  void wrongShape
}

/** 命令面——判别式构造。 */
export function commandsConstruct(): void {
  const cmds: readonly Command[] = [
    { type: 'input.submit', text: '看下 playground' },
    { type: 'decision.answer', id: 7, decision: 'approve' },
    { type: 'turn.interrupt' },
  ]
  void cmds
}

/** 端口可实现——桩满足签名（端口一致性的雏形）。 */
export function portsAreImplementable(): void {
  const sandbox: Sandbox = {
    async exec(): Promise<ExecResult> {
      return { ok: true, exit: 0, stdout: '', stderr: '', truncated: false }
    },
    async read() {
      return { content: '' }
    },
    async write() {},
    async list() {
      return []
    },
    async match() {
      return []
    },
  }
  void sandbox
}

/** 条目的工具载荷——结构对齐事件侧。 */
export function entryCarriesToolPayload(): void {
  const call: ToolCallPayload = { name: 'exec', args: { cmd: 'ls' } }
  const result: ToolResultPayload = { ok: true, output: { text: 'done' } }
  const entry: NewEntry = { kind: 'tool-call', content: { text: '' }, payload: call, at: 0 }
  const full: Entry = { ...entry, id: 1 }
  void result
  void full
}

/** 条目范围可省略（端口签名 `range?`）。 */
export function entryRangeIsOptional(): void {
  const range: EntryRange = { from: 1, to: 9 }
  void range
}

// ══ 运行时断言 ════════════════════════════════════════════════════════

describe('事件契约', () => {
  test('不落库清单含两个实时增量（model.delta · tool.output.delta）', () => {
    expect(TRANSIENT_EVENT_KINDS).toEqual(['model.delta', 'tool.output.delta'])
  })

  test('schema 版本自始写入（v0）', () => {
    expect(RECORD_SCHEMA_VERSION).toBe(0)
  })
})

describe('工具契约', () => {
  test('工具集 v1 七工具——exec 在列（阶段 1 唯一工具）', () => {
    expect(TOOLSET_V1.map((tool) => tool.name)).toEqual([
      'exec',
      'read',
      'write',
      'edit',
      'grep',
      'glob',
      'ls',
    ])
  })

  test('按调用判定的两行——exec 按命令解析 · write 新建轻覆盖闸', () => {
    const byCall = TOOLSET_V1.filter((tool) => tool.danger.level === 'by-call')
    expect(byCall.map((tool) => tool.name)).toEqual(['exec', 'write'])
  })

  test('其余皆轻（放行区）', () => {
    const light = TOOLSET_V1.filter((tool) => tool.danger.level === 'light').map((tool) => tool.name)
    expect(light).toEqual(['read', 'edit', 'grep', 'glob', 'ls'])
  })
})

describe('配置契约', () => {
  test('环境变量名——ID 大写、非字母数字映射为下划线', () => {
    expect(apiKeyEnvVarOf('minimax')).toBe('MAGIC_MINIMAX_API_KEY')
    expect(apiKeyEnvVarOf('my-vendor')).toBe('MAGIC_MY_VENDOR_API_KEY')
    expect(apiKeyEnvVarOf('a.b')).toBe('MAGIC_A_B_API_KEY')
  })

  test('dataDir 展开——前导 ~ 换家目录，其余字面', () => {
    expect(expandDataDir('~/.magic', '/home/u')).toBe('/home/u/.magic')
    expect(expandDataDir('~', '/home/u')).toBe('/home/u')
    expect(expandDataDir('/abs/path', '/home/u')).toBe('/abs/path')
    expect(expandDataDir('rel/path', '/home/u')).toBe('rel/path')
    // 中段 `~` 不是前导——不展开
    expect(expandDataDir('/a/~/b', '/home/u')).toBe('/a/~/b')
  })
})

describe('控制面契约（迁移忠实性）', () => {
  test('裁决配对的事件侧 kind 不变', () => {
    expect(DECISION_REQUEST_KIND).toBe('tool.decision.request')
  })
})
