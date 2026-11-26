import { describe, expect, test } from 'bun:test'
import { blockedLinesOf, resourceWaitLine, resourceWaitOf, waitLineOf } from '../src/resource-wait.ts'

/**
 * T3.5 契约测试（先行的那一半）——《边界方案》§3.3 动作映射表逐行 + 未知 quotaClass 兜底。
 *
 * 已知三值按表给文案与动作；**未知值不崩溃、显示通用「资源不足」、不编动作**。
 * 权威枚举落地（contracts T0.1）后，这里补「枚举值与映射表同步」的断言。
 */
describe('quotaClass → 用户文案与动作（边界方案 §3.3）', () => {
  test('executor：等执行资源，等／抢占（preemptible 时），占用方会话原样带出', () => {
    const plain = resourceWaitOf('executor')
    expect(plain.label).toBe('等执行资源')
    expect(plain.actions.map(one => one.kind)).toEqual(['wait'])

    const preemptible = resourceWaitOf('executor', { preemptible: true, occupantSessions: ['session-a', 'session-b'] })
    expect(preemptible.actions.map(one => one.kind)).toEqual(['wait', 'preempt'])
    expect(preemptible.occupantSessions).toEqual(['session-a', 'session-b'])

    // 占用方缺席/空：不拿空列表冒充一格（缺席＝没有这一件）。
    expect(resourceWaitOf('executor', { occupantSessions: [] }).occupantSessions).toBeUndefined()
  })

  test('model：等模型配额，换模型／等配额恢复——不给「并发满了才该说的」话', () => {
    const wait = resourceWaitOf('model')
    expect(wait.label).toBe('等模型配额')
    expect(wait.actions.map(one => one.kind)).toEqual(['switch-model', 'await-quota'])
    expect(wait.occupantSessions).toBeUndefined()
  })

  test('input-capacity：待办已满，一键重发', () => {
    const wait = resourceWaitOf('input-capacity')
    expect(wait.label).toBe('待办已满')
    expect(wait.actions.map(one => one.kind)).toEqual(['resubmit'])
    expect(wait.occupantSessions).toBeUndefined()
  })

  test('未知 quotaClass：不崩溃、通用「资源不足」、不编动作（契约锁点）', () => {
    // 引擎将来新增的资源类型（枚举加值而前端未跟上）与一切杂值——都走同一兜底。
    for (const unknown of ['gpu', 'seat', '', 'EXECUTOR', 'executor ', 'model-quota', 'null', 'undefined']) {
      const wait = resourceWaitOf(unknown)
      expect(wait.label).toBe('资源不足')
      expect(wait.actions).toEqual([])
      expect(wait.occupantSessions).toBeUndefined()
    }
  })

  test('未知值在纯文本读法里也不崩溃，且给出的是兜底文案而非内部分类名', () => {
    for (const unknown of ['gpu', '', 'executor ']) {
      const line = resourceWaitLine(resourceWaitOf(unknown))
      expect(line).toBe('资源不足')
    }
    // 已知值的整句：文案 + 动作一步可达（P31——出路跟着错误一起出现）。
    expect(resourceWaitLine(resourceWaitOf('input-capacity'))).toBe('待办已满 可做：一键重发')
    expect(resourceWaitLine(resourceWaitOf('executor', { preemptible: true, occupantSessions: ['s1'] })))
      .toBe('等执行资源 （占用：s1） 可做：等／抢占')
    expect(resourceWaitLine(undefined)).toBeUndefined()
  })
})

describe('waitLineOf——等待成本来自字段（P29）', () => {
  test('blocking：请稍候等结局；advisory：只读可以不等', () => {
    expect(waitLineOf({ waitClass: 'blocking' })).toBe('请稍候，等它结局')
    expect(waitLineOf({ waitClass: 'advisory' })).toBe('只读，可以不等')
    // blocking 即「入口在等」——awaitedByEntry 由 engine 配套下发，文案已含其意。
    expect(waitLineOf({ waitClass: 'blocking', awaitedByEntry: true })).toBe('请稍候，等它结局')
  })

  test('none 与字段缺席：不给等待暗示（缺席即呈现，不写反向句）', () => {
    expect(waitLineOf({ waitClass: 'none' })).toBeUndefined()
    expect(waitLineOf({})).toBeUndefined()
    expect(waitLineOf(undefined)).toBeUndefined()
    // 未知值（枚举扩展未跟上）：不编。
    expect(waitLineOf({ waitClass: 'gate' as never })).toBeUndefined()
  })
})

describe('blockedLinesOf——阻塞态表逐行（P33 · 裁定草案 §3.6）', () => {
  const now = 10_000

  test('等批准：谁在等谁 + 批准／拒绝 + 等了多久', () => {
    expect(blockedLinesOf({ kind: 'awaiting-approval', by: 'entry-1', since: 4_000 }, now))
      .toEqual(['等批准（entry-1）', '可做：批准／拒绝 · 已等 6 秒'])
  })

  test('等资源：不出阻塞行——它由 quotaClass 资源动作行呈现（同一张表不重复）', () => {
    expect(blockedLinesOf({ kind: 'awaiting-resource', since: 4_000 }, now)).toEqual([])
  })

  test('等认收：认收／放弃 + 收敛规则（入口自动认收）', () => {
    const lines = blockedLinesOf({ kind: 'awaiting-receipt', since: 4_000 }, now)
    expect(lines[0]).toBe('已交付，待主会话认收')
    expect(lines[1]).toContain('认收／放弃')
    expect(lines[1]).toContain('入口结束自动认收')
  })

  test('等核销：如实说「执行器可能仍在收尾」——不冒充已停（P7）', () => {
    const lines = blockedLinesOf({ kind: 'awaiting-settlement', since: 4_000 }, now)
    expect(lines.join(' ')).toContain('等它核销')
    expect(lines.join(' ')).toContain('可能仍在收尾')
  })

  test('等接回：等心跳 + 收敛规则（15 秒内转未确认完成）', () => {
    const lines = blockedLinesOf({ kind: 'awaiting-reattach', since: 4_000 }, now)
    expect(lines.join(' ')).toContain('等心跳')
    expect(lines.join(' ')).toContain('未确认完成')
  })

  test('未知类别：只报阻塞与时长，不编动作（P31：动作名必须有真迁移）', () => {
    const lines = blockedLinesOf({ kind: 'awaiting-something-new' as never, since: 4_000 }, now)
    expect(lines).toEqual(['阻塞中 · 已等 6 秒'])
    expect(lines.join(' ')).not.toContain('可做')
  })

  test('缺席：一个字都不占', () => {
    expect(blockedLinesOf(undefined, now)).toEqual([])
  })
})
