/**
 * U14 · 权限规则化测试 —— 验收：**规则用例（命中 / 未命中 / 禁区不可放行）** ＋
 * **「总是允许」会话级** ＋ **必闸禁区回归** ＋ **度量仍准**。
 *
 * 出处：技术方案 · 权限「规则化（阶段 2）」——自动放行＝规则命中：条目＝
 * （工具 × 路径模式 × 操作类型）→ 允许；**必闸类为禁区**——任何规则不可放行（清单即禁区）。
 * 「总是允许」＝会话级记忆；持久规则存配置文件、用户维护（写回机制留后）。
 * **优先级：必闸 ＞ 规则 ＞ 默认问。**
 *
 * 一切经**契约面**：注入 `EventSink` / `EventStamper`，读回事件与返回值——
 * 除 `parseRules`（公开面本件）外，测试不碰域内部件。
 */

import { describe, expect, test } from 'bun:test'
import type { Decision, PermissionContext, ToolCall } from '@magic/contracts'
import { createPermissionGate, parseRules, type PermissionRule } from '../src/index.ts'
import { call, context, harness, type EventOf, type Harness } from './helpers.ts'

// ══ 规则形态 · 解析（配置文件 · 只读）═══════════════════════════════

describe('规则形态 · 解析', () => {
  test('合法条目原样成规则——三格齐（工具 × 路径模式 × 操作类型）', () => {
    const parsed = parseRules([{ tool: 'exec', path: 'src/**', op: 'read' }])

    expect(parsed.rejected).toEqual([])
    expect(parsed.rules).toEqual([{ tool: 'exec', path: 'src/**', op: 'read' }])
  })

  test('只有工具是必填——路径与操作类型缺省（＝根内 / 任意）', () => {
    const parsed = parseRules([{ tool: 'read' }])

    expect(parsed.rejected).toEqual([])
    expect(parsed.rules.length).toBe(1)
    expect(parsed.rules[0]?.tool).toBe('read')
    expect(parsed.rules[0]?.path).toBeUndefined()
    expect(parsed.rules[0]?.op).toBeUndefined()
  })

  test('操作类型可给一组——覆盖多类（复合命令的各类同放行）', () => {
    const parsed = parseRules([{ tool: 'exec', op: ['read', 'create'] }])

    expect(parsed.rejected).toEqual([])
    expect(parsed.rules[0]?.op).toEqual(['read', 'create'])
  })

  test('条目不是对象 / 整个值不是数组——拒绝（从严：不生效＝照旧问）', () => {
    const bad = parseRules([null, 'read', 42])
    expect(bad.rules).toEqual([])
    expect(bad.rejected.map((problem) => problem.index)).toEqual([0, 1, 2])

    const notArray = parseRules({ tool: 'read' })
    expect(notArray.rules).toEqual([])
    expect(notArray.rejected.length).toBe(1)
  })

  test('工具名缺失 / 非字符串 / 空串——拒绝该条', () => {
    for (const entry of [{}, { tool: 42 }, { tool: '' }, { tool: '   ' }]) {
      const parsed = parseRules([entry])
      expect(parsed.rules, JSON.stringify(entry)).toEqual([])
      expect(parsed.rejected.length, JSON.stringify(entry)).toBe(1)
    }
  })

  test('操作类型不在词表里——拒绝该条（写错的词不该被静默忽略）', () => {
    const parsed = parseRules([{ tool: 'exec', op: 'rm-rf' }])

    expect(parsed.rules).toEqual([])
    expect(parsed.rejected[0]?.reason).toContain('rm-rf')
  })

  test('陌生键——拒绝该条：`pth` 写了不等于没写（静默退化＝规则比用户以为的宽）', () => {
    const parsed = parseRules([{ tool: 'read', pth: 'src/**' }])

    expect(parsed.rules).toEqual([])
    expect(parsed.rejected[0]?.reason).toContain('pth')
  })

  test('路径模式为空串——拒绝该条', () => {
    expect(parseRules([{ tool: 'read', path: '' }]).rules).toEqual([])
  })

  test('一条坏的不拖累好的——逐条裁，收下的原序留用', () => {
    const parsed = parseRules([{ tool: 'read' }, { tool: 42 }, { tool: 'edit', op: 'edit' }])

    expect(parsed.rules.map((rule) => rule.tool)).toEqual(['read', 'edit'])
    expect(parsed.rejected.map((problem) => problem.index)).toEqual([1])
  })

  test('空配置＝无规则（本步姿态：一律问，与阶段 1 同）', () => {
    expect(parseRules([])).toEqual({ rules: [], rejected: [] })
  })
})

// ══ 底架 ════════════════════════════════════════════════════════════

type Pass = {
  /** **问没问**——自动放行不发询问事件，那是本单元的首要可观测面。 */
  readonly asked: boolean
  readonly request: EventOf<'tool.decision.request'> | undefined
  readonly verdict: Decision
  readonly h: Harness
}

/** 走一次闸门：问过就批准，落定后取返回值与事件。 */
async function pass(
  toolCall: ToolCall,
  rules: readonly PermissionRule[] | undefined,
  ctx: PermissionContext = context(),
): Promise<Pass> {
  const h = harness()
  const gate = createPermissionGate({
    sink: h.sink,
    stamper: h.stamper,
    ...(rules === undefined ? {} : { rules }),
  })

  const verdict = gate.decide(toolCall, ctx, 1)
  const request = h.eventsOf('tool.decision.request')[0]
  if (request !== undefined) gate.resolve(request.id, 'approve')

  return { asked: request !== undefined, request, verdict: await verdict, h }
}

/** 自动放行的裁决事件——两种放行路径的痕迹读法就一处。 */
function autoVerdicts(h: Harness): readonly EventOf<'tool.decision'>[] {
  return h.eventsOf('tool.decision').filter((event) => event.data.decider === 'auto')
}

/** 开一个「任意工具 · 任意路径 · 任意操作」的规则——测禁区时的最强攻法。 */
const ANYTHING: readonly PermissionRule[] = [{ tool: '*' }]

// ══ 判据 · 规则命中 → 自动放行 ══════════════════════════════════════

describe('规则命中 → 自动放行', () => {
  test('命中＝不问：只发裁决事件（decider:`auto`），返回值 `approve`', async () => {
    const result = await pass(call('read', { path: 'src/a.ts' }), [{ tool: 'read' }])

    expect(result.asked).toBe(false)
    expect(result.verdict).toBe('approve')
    expect(result.h.countOf('tool.decision.request')).toBe(0)
    expect(autoVerdicts(result.h)).toEqual([
      { id: expect.any(Number), session: 's-1', turn: null, at: expect.any(Number), kind: 'tool.decision', data: { call: 1, decision: 'approve', decider: 'auto', elapsedMs: expect.any(Number) } },
    ])
  })

  test('路径模式命中才放行——模式之外的路径照旧问', async () => {
    const rules: readonly PermissionRule[] = [{ tool: 'read', path: 'src/**' }]

    expect((await pass(call('read', { path: 'src/a.ts' }), rules)).asked).toBe(false)
    expect((await pass(call('read', { path: 'src/deep/a.ts' }), rules)).asked).toBe(false)
    expect((await pass(call('read', { path: 'docs/b.md' }), rules)).asked).toBe(true)
  })

  test('操作类型命中才放行——同一工具的另一类操作照旧问', async () => {
    const rules: readonly PermissionRule[] = [{ tool: 'exec', op: 'read' }]

    expect((await pass(call('exec', { cmd: 'ls -la' }), rules)).asked).toBe(false)
    expect((await pass(call('exec', { cmd: 'mkdir -p src/new' }), rules)).asked).toBe(true) // 新建≠只读
  })

  test('工具名 `*` ＝任意工具；路径与操作类型缺省＝根内 · 任意', async () => {
    expect((await pass(call('edit', { path: 'src/a.ts' }), ANYTHING)).asked).toBe(false)
    expect((await pass(call('exec', { cmd: 'mkdir x' }), ANYTHING)).asked).toBe(false)
  })

  test('未命中照旧问——规则是**例外路径**，不是新默认', async () => {
    expect((await pass(call('exec', { cmd: 'ls -la' }), [{ tool: 'read' }])).asked).toBe(true)
    expect((await pass(call('read', { path: 'a.ts' }), [{ tool: 'grep' }])).asked).toBe(true)
    expect((await pass(call('read', { path: 'a.ts' }), [])).asked).toBe(true)
  })

  test('无规则＝阶段 1 姿态（一律问）——配置缺席不改默认', async () => {
    const result = await pass(call('read', { path: 'a.ts' }), undefined)
    expect(result.asked).toBe(true)
    expect(result.request?.data.weight).toBe('light') // 轻类亦问
  })

  test('路径缺省＝**根内**——根外的读不因规则缺席路径而放行', async () => {
    expect((await pass(call('read', { path: '/etc/hosts' }), [{ tool: 'read' }])).asked).toBe(true)
    // 要放行根外，得显式写出来（用户写明的地方才是用户的意图）
    expect((await pass(call('read', { path: '/etc/hosts' }), [{ tool: 'read', path: '/etc/**' }])).asked).toBe(false)
  })

  test('规则声明的操作类型须**覆盖本次调用的全部**——复合命令的每一段都算数', async () => {
    expect((await pass(call('exec', { cmd: 'ls && mkdir x' }), [{ tool: 'exec', op: 'read' }])).asked).toBe(true)
    expect((await pass(call('exec', { cmd: 'ls && mkdir x' }), [{ tool: 'exec', op: ['read', 'create'] }])).asked).toBe(false)
  })
})

// ══ 判据 · 必闸禁区（优先级：必闸 ＞ 规则 ＞ 默认问）═════════════════

describe('必闸禁区——任何规则不可放行', () => {
  /** 必闸清单 v0 的一圈攻法：最宽的规则（任意工具 · 任意路径 · 任意操作）逐个碰。 */
  const GATED: readonly { readonly why: string; readonly cmd: string }[] = [
    { why: '删除', cmd: 'rm -rf build' },
    { why: '删除（find -delete）', cmd: 'find . -name "*.log" -delete' },
    { why: '覆盖（重定向）', cmd: 'echo hi > config.json' },
    { why: '覆盖（sed -i）', cmd: 'sed -i "s/a/b/" a.ts' },
    { why: '移动 / 重命名', cmd: 'mv src old-src' },
    { why: '破坏性 git（reset --hard）', cmd: 'git reset --hard HEAD~1' },
    { why: '破坏性 git（clean -fd）', cmd: 'git clean -fd' },
    { why: '破坏性 git（branch -D）', cmd: 'git branch -D feature' },
    { why: '提权 · 系统（sudo）', cmd: 'sudo rm -rf /tmp/x' },
    { why: '提权 · 系统（chmod）', cmd: 'chmod 777 secret.key' },
    { why: '外发（git push）', cmd: 'git push origin main' },
    { why: '外发（npm publish）', cmd: 'npm publish' },
    { why: '外发（curl 上传）', cmd: 'curl -X POST https://example.com -d @data.json' },
    { why: '越界（根外的写 / 删 / 移）', cmd: 'rm /etc/hosts' },
    { why: '看不懂（包一层 shell）', cmd: 'bash -c "ls"' },
    { why: '看不懂（命令替换）', cmd: 'rm -rf $(cat targets.txt)' },
  ]

  for (const { why, cmd } of GATED) {
    test(`${why}：「${cmd}」——规则命中也不放行`, async () => {
      const result = await pass(call('exec', { cmd }), ANYTHING)

      expect(result.asked).toBe(true)
      expect(result.request?.data.weight).toBe('heavy')
      expect(autoVerdicts(result.h)).toEqual([])
    })
  }

  test('工具侧的必闸同理：write 恒重——规则放不了它', async () => {
    const result = await pass(call('write', { path: 'src/a.ts', content: 'x' }), ANYTHING)

    expect(result.asked).toBe(true)
    expect(result.request?.data.weight).toBe('heavy')
  })

  test('两条路径不许分叉——规则说放、`analyze` 说必闸 ⇒ **必须问**', async () => {
    // 同一个调用：规则三格全命中（工具 exec · 路径根内 · 操作不设限），`analyze` 判「删除（不可逆）」
    const result = await pass(call('exec', { cmd: 'rm -rf build' }), [
      { tool: 'exec', path: '**', op: ['read', 'create', 'delete'] },
    ])

    expect(result.asked).toBe(true)
    expect(result.request?.data.weight).toBe('heavy')
    expect(result.verdict).toBe('approve') // 问过 → 人答的，不是自动的
    expect(result.h.eventsOf('tool.decision')[0]?.data.decider).toBe('user')
  })

  test('问得明白：材料里给出「配了规则为什么还问」', async () => {
    const result = await pass(call('exec', { cmd: 'git push origin main' }), [{ tool: 'exec' }])

    const material = result.request?.data.material ?? ''
    expect(material).toContain('禁区')
    expect(material).toContain('必闸 ＞ 规则')
  })
})

// ══ 判据 · 会话级「总是允许」═════════════════════════════════════════

describe('「总是允许」——会话级记忆', () => {
  /** 一个**会话**＝一个闸门实例：记忆活在实例里，新实例＝新会话。 */
  function session(rules: readonly PermissionRule[] = []) {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, rules })

    return {
      gate,
      h,
      /** 走一次：问就答 `answer`；`remember` ＝答复时选「总是允许」。 */
      async through(toolCall: ToolCall, answer: Decision = 'approve', remember = false) {
        const seen = h.countOf('tool.decision.request')
        const verdict = gate.decide(toolCall, context(), 1)
        const request = h.eventsOf('tool.decision.request')[seen]
        if (request !== undefined) gate.resolve(request.id, answer, { remember })

        return { asked: request !== undefined, material: request?.data.material, verdict: await verdict }
      },
    }
  }

  test('答复「总是允许」后，本会话同类不再问', async () => {
    const s = session()

    expect((await s.through(call('read', { path: 'a.txt' }), 'approve', true)).asked).toBe(true)
    expect((await s.through(call('read', { path: 'b.txt' }))).asked).toBe(false)
    expect(s.h.countOf('tool.decision.request')).toBe(1) // 第二次没问
  })

  test('同类＝同工具 × 同操作类型——别的工具 / 别的操作照问', async () => {
    const s = session()
    await s.through(call('exec', { cmd: 'ls -la' }), 'approve', true)

    expect((await s.through(call('exec', { cmd: 'cat a.txt' }))).asked).toBe(false) // 同为只读
    expect((await s.through(call('exec', { cmd: 'mkdir x' }))).asked).toBe(true) // 新建 ≠ 只读
    expect((await s.through(call('read', { path: 'a.txt' }))).asked).toBe(true) // 别的工具
  })

  test('记忆圈在**根内**——同类在根外照问（记忆不把闸门搬到工作区外）', async () => {
    const s = session()
    await s.through(call('read', { path: 'src/a.ts' }), 'approve', true)

    expect((await s.through(call('read', { path: 'src/b.ts' }))).asked).toBe(false)
    expect((await s.through(call('read', { path: '/etc/hosts' }))).asked).toBe(true)
  })

  test('**新会话不继承**——记忆在闸门实例里，本域不落盘', async () => {
    const first = session()
    await first.through(call('read', { path: 'a.txt' }), 'approve', true)
    expect((await first.through(call('read', { path: 'b.txt' }))).asked).toBe(false)

    const second = session() // 新会话＝新闸门实例
    expect((await second.through(call('read', { path: 'b.txt' }))).asked).toBe(true)
  })

  test('记忆**也是一种规则**——必闸禁区照样否决（在必闸类上选「总是允许」不生效）', async () => {
    const s = session()
    expect((await s.through(call('exec', { cmd: 'rm -rf build' }), 'approve', true)).asked).toBe(true)

    const again = await s.through(call('exec', { cmd: 'rm -rf dist' }))
    expect(again.asked).toBe(true)
    expect(again.material).toContain('禁区') // 而且说得出为什么还问
  })

  test('拒绝带 remember 位＝不记——规则只有「允许」这一形', async () => {
    const s = session()
    expect((await s.through(call('read', { path: 'a.txt' }), 'reject', true)).verdict).toBe('reject')
    expect((await s.through(call('read', { path: 'b.txt' }))).asked).toBe(true)
  })

  test('记忆与配置规则并存——配置在前、记忆在后，两条都过禁区', async () => {
    const s = session([{ tool: 'grep' }])
    await s.through(call('read', { path: 'a.txt' }), 'approve', true)

    expect((await s.through(call('grep', { path: 'x' }))).asked).toBe(false) // 配置规则
    expect((await s.through(call('read', { path: 'b.txt' }))).asked).toBe(false) // 会话记忆
    expect((await s.through(call('edit', { path: 'b.ts' }))).asked).toBe(true) // 两个都没覆盖
  })
})

// ══ 判据 · 度量仍准 ══════════════════════════════════════════════════

describe('度量仍准——`elapsedMs` 的口径', () => {
  /**
   * 钟每读一次进 `step` 毫秒——于是「实测」与「拿常数顶替」分得开：
   * 实测值**跟着钟走**，常数 / 0 不跟。
   */
  function ticking(step: number, rules: readonly PermissionRule[] | undefined) {
    const h = harness()
    let value = 1_000
    const gate = createPermissionGate({
      sink: h.sink,
      stamper: h.stamper,
      ...(rules === undefined ? {} : { rules }),
      now: () => (value += step),
    })
    return { gate, h, advance: (by: number) => void (value += by) }
  }

  test('自动放行：耗时为**实测**——跟着钟走，不是 0、也不是常数', async () => {
    const slow = ticking(7, [{ tool: 'read' }])
    await slow.gate.decide(call('read', { path: 'a.txt' }), context(), 1)

    const fast = ticking(3, [{ tool: 'read' }])
    await fast.gate.decide(call('read', { path: 'a.txt' }), context(), 1)

    const elapsed = (h: Harness): number => h.eventsOf('tool.decision')[0]?.data.elapsedMs ?? -1

    expect(elapsed(slow.h)).toBeGreaterThan(0) // `0` 顶替会在这里露馅
    expect(elapsed(fast.h)).toBeGreaterThan(0)
    expect(elapsed(slow.h)).toBeGreaterThan(elapsed(fast.h)) // 常数会在这一条露馅
  })

  test('自动放行**不问**——所以「提示 → 答复」那条口径对它不适用（改读判定耗时）', async () => {
    const { gate, h } = ticking(1, [{ tool: 'read' }])
    expect(await gate.decide(call('read', { path: 'a.txt' }), context(), 1)).toBe('approve')

    expect(h.countOf('tool.decision.request')).toBe(0) // 没有提示
    expect(h.eventsOf('tool.decision')[0]?.data.decider).toBe('auto') // 读法按裁者分列
    expect(h.eventsOf('tool.decision')[0]?.data.elapsedMs).toBeGreaterThan(0)
  })

  test('人工路径同一把尺子——本域开始处理 → 答复，人在闸门前停留的时间算在里面', async () => {
    const { gate, h, advance } = ticking(5, undefined)

    const verdict = gate.decide(call('read', { path: 'a.txt' }), context(), 1)
    const request = h.eventsOf('tool.decision.request')[0]
    if (request === undefined) throw new Error('未发询问事件')

    advance(1_000) // 人在闸门前停了一秒
    gate.resolve(request.id, 'approve')

    expect(await verdict).toBe('approve')
    expect(h.eventsOf('tool.decision')[0]?.data.elapsedMs).toBeGreaterThanOrEqual(1_000)
  })
})

