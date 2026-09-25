/**
 * U73 · **全放行**（`权限域`那一半）—— 验收：**判轻的不问 · 必闸照样问**。
 *
 * 出处：`设计/工具执行与权限`·「全放行：**只在起会话那一刻给**」——
 *
 * > ⚠️ **必闸类照样挡**——「**必闸项不能用 `a` 绕过**」那条在它上面**同样成立**：
 * > **全放行也不放必闸**（删除 · 覆盖 · 破坏性 git · 越权 · 外发 · 越界）。
 *
 * 本文件咬的是**域内那一刀**：`allowAll` 是**构造入参**（造完就没有改它的口——
 * 「对话期间切不进去」在域里就是这个形状），而**轻重那一刀仍归 `analyze`**：
 * 它只是**不押「有没有规则」**，它够不着 `weight !== 'light'` 那一格。
 *
 * ⚠️ **必闸那一圈用的是与 `rules.test.ts` 同一份清单**（删除 / 覆盖 / 破坏性 git /
 * 提权 / 外发 / 越界 / 看不懂）——两份**逐条同名同命令**，各自独立抄一遍。
 * 抄两遍是**故意的**：共用一份常量的话，哪天有人把清单删空，两处会**一起变绿**。
 *
 * 一切经**契约面**：注入 `EventSink` / `EventStamper`，读回事件与返回值。
 */

import { describe, expect, test } from 'bun:test'
import type { Decision, PermissionContext, ToolCall } from '@magic/contracts'
import { createPermissionGate } from '../src/index.ts'
import { call, context, harness, ledger, type EventOf, type Harness } from './helpers.ts'

type Pass = {
  /** 弹了卡没有（`tool.decision.request` 发出去过）。 */
  readonly asked: boolean
  readonly request: EventOf<'tool.decision.request'> | undefined
  readonly verdict: Decision
  readonly h: Harness
}

/** 走一次闸门：**全放行**与规则都给得起；问过就批准，落定后取返回值与事件。 */
async function pass(
  toolCall: ToolCall,
  options: {
    readonly allowAll?: boolean
    readonly rules?: readonly { readonly tool: string }[]
    readonly ctx?: PermissionContext
  } = {},
): Promise<Pass> {
  const h = harness()
  const gate = createPermissionGate({
    sink: h.sink,
    stamper: h.stamper,
    grants: ledger(),
    ...(options.allowAll === true ? { allowAll: true } : {}),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  })

  const verdict = gate.decide(toolCall, options.ctx ?? context(), 1)
  const request = h.eventsOf('tool.decision.request')[0]
  if (request !== undefined) gate.resolve(request.id, 'approve')

  return { asked: request !== undefined, request, verdict: await verdict, h }
}

/** 自动放行的裁决事件——两种放行路径（规则命中 / 全放行）的痕迹读法就一处。 */
function autoVerdicts(h: Harness): readonly EventOf<'tool.decision'>[] {
  return h.eventsOf('tool.decision').filter((event) => event.data.decider === 'auto')
}

// ══ ① 判轻的不问 ════════════════════════════════════════════════════

describe('全放行 · 判轻的不问', () => {
  const LIGHT: readonly { readonly why: string; readonly one: ToolCall }[] = [
    { why: '只读命令（read）', one: call('exec', { cmd: 'ls -la' }) },
    { why: '搜索（grep）', one: call('exec', { cmd: 'grep -n TODO src/a.ts' }) },
    { why: '读文件', one: call('read', { path: 'src/a.ts' }) },
    { why: '目录列出', one: call('ls', { path: 'src' }) },
    { why: '路径匹配', one: call('glob', { pattern: '**/*.ts' }) },
    { why: '根内增量编辑', one: call('edit', { path: 'src/a.ts', old: 'a', new: 'b' }) },
    { why: '新建目录', one: call('exec', { cmd: 'mkdir -p src/new' }) },
  ]

  for (const { why, one } of LIGHT) {
    test(`${why}：全放行时**一条都不问**`, async () => {
      const result = await pass(one, { allowAll: true })

      expect(result.asked).toBe(false)
      expect(result.verdict).toBe('approve')
      expect(result.h.countOf('tool.decision.request')).toBe(0)
    })
  }

  test('不问**不等于不留痕**——照落一条 `decider: auto` 的裁决事件', async () => {
    const result = await pass(call('read', { path: 'src/a.ts' }), { allowAll: true })

    expect(autoVerdicts(result.h)).toEqual([
      {
        id: expect.any(Number),
        session: 's-1',
        turn: null,
        at: expect.any(Number),
        kind: 'tool.decision',
        data: { call: 1, decision: 'approve', decider: 'auto', elapsedMs: expect.any(Number) },
      },
    ])
  })

  test('**不在全放行就照旧问**——同一个调用，不给它就是阶段 1 的姿态', async () => {
    const result = await pass(call('read', { path: 'src/a.ts' }))

    expect(result.asked).toBe(true)
    expect(result.request?.data.weight).toBe('light') // 轻类亦问（既有口径一字未改）
    expect(autoVerdicts(result.h)).toEqual([])
  })

  test('全放行时**不必先配规则**——规则一条没有也放', async () => {
    expect((await pass(call('exec', { cmd: 'ls -la' }), { allowAll: true })).asked).toBe(false)
  })

  test('全放行时**配了规则也照放**——两条来路不打架（都落进同一条自动放行）', async () => {
    const rules = [{ tool: 'read' }]
    expect((await pass(call('read', { path: 'src/a.ts' }), { allowAll: true, rules })).asked).toBe(false)
  })

  test('全放行时**不吃授权账**——放行不是那条授权挣来的，不替它续命', async () => {
    // 对照：**不带这个参数**时，命中那条授权记一次「省了一次点击」
    const off = harness()
    const offGrants = await grantedForRead(off)
    await createPermissionGate({
      sink: off.sink,
      stamper: off.stamper,
      grants: offGrants,
    }).decide(call('read', { path: 'src/a.ts' }), context(), 2)
    expect(hitsOf(offGrants)).toBe(1)

    // 带参数：照放，但那一条授权的账**一格都没动**
    const on = harness()
    const onGrants = await grantedForRead(on)
    await createPermissionGate({
      sink: on.sink,
      stamper: on.stamper,
      grants: onGrants,
      allowAll: true,
    }).decide(call('read', { path: 'src/a.ts' }), context(), 2)
    expect(hitsOf(onGrants)).toBe(0)
  })
})

/**
 * 先经人工门点出一条「本工作区总是允许 read」的授权（`a` 的落点），把账本交回来。
 *
 * ⚠️ **不能靠配规则造这一条**：规则命中就不问了，也就点不出授权来——`granted`
 * 那一支只有**经人工门答 `remember`** 才立得起来。
 */
async function grantedForRead(h: Harness) {
  const grants = ledger()
  const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants })
  const asking = gate.decide(call('read', { path: 'src/a.ts' }), context(), 1)
  const request = h.eventsOf('tool.decision.request')[0]
  if (request !== undefined) gate.resolve(request.id, 'approve', { remember: true })
  await asking

  return grants
}

/** 本工作区那几条授权一共被记了几次命中（从未命中的那一位**缺席**，不编 0——故 `?? 0`）。 */
function hitsOf(grants: ReturnType<typeof ledger>): number {
  return grants.view().reduce((sum, row) => sum + (row.hits ?? 0), 0)
}

// ══ ② 必闸照样挡（与 `rules.test.ts` 同一圈攻法）════════════════════

describe('全放行 · 必闸类照样挡', () => {
  /** 必闸清单 v0 的一圈攻法——**与 `rules.test.ts` 的 `GATED` 逐条同名同命令**（见文件头注）。 */
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
    test(`${why}：「${cmd}」——**全放行时也照问**`, async () => {
      const result = await pass(call('exec', { cmd }), { allowAll: true })

      expect(result.asked).toBe(true)
      expect(result.request?.data.weight).toBe('heavy')
      expect(autoVerdicts(result.h)).toEqual([]) // 一条自动放行都没有
      expect(result.verdict).toBe('approve') // 问过 → 人答的
      expect(result.h.eventsOf('tool.decision')[0]?.data.decider).toBe('user')
    })
  }

  test('工具侧的必闸同理：`write` 恒重——**全放行时也放不了它**', async () => {
    const result = await pass(call('write', { path: 'src/a.ts', content: 'x' }), { allowAll: true })

    expect(result.asked).toBe(true)
    expect(result.request?.data.weight).toBe('heavy')
  })

  test('**全放行不写第二套判据**——同一圈命令，带它与不带它问的是同一批', async () => {
    for (const { cmd } of GATED) {
      const off = await pass(call('exec', { cmd }))
      const on = await pass(call('exec', { cmd }), { allowAll: true })

      expect(on.asked).toBe(off.asked)
      expect(on.request?.data.weight).toBe(off.request?.data.weight)
    }
  })

  test('根外的**写**照挡，根外的**读**照放——全放行不动越界那一刀', async () => {
    // 越界条目限「工作区外的写 / 删 / 移」（`analyze.ts` 那条既有口径）：读材料不在此列
    expect((await pass(call('read', { path: '/etc/hosts' }), { allowAll: true })).asked).toBe(false)
    expect((await pass(call('write', { path: '/etc/hosts', content: 'x' }), { allowAll: true })).asked).toBe(
      true,
    )
  })
})
