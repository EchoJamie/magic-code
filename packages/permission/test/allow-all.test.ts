/**
 * U73 立 · **U76 改定** · **全放行**（`权限域`那一半）—— 验收：**真的什么都不问**。
 *
 * 出处：`设计/工具执行与权限`·「全放行：**只在起会话那一刻给**」——
 *
 * > ⚠️ **它连必闸也放——真的什么都不问**（2026-09-25 用户定，**改过一次**）。
 * > 由头：默认已经是「通」，只剩那张例外表要问；若全放行**也不放**它，
 * > **两者一模一样 ⇒ 这一档就是个空开关**。**它必须比默认更放，才有存在理由。**
 *
 * ⚠️ **U73 那一版是旧版**（「放轻的、必闸照样挡」）——本文件当时逐条钉的是那个形状，
 * 现在整组**反过来**钉：判重的（名单那两条 · `write` · 取网页 · 外部操作）**也不问**。
 * **产品在这一档下不再作「漏拦」那个承诺**（设计明文）：名单本来是产品的安全承诺，
 * **危险模式是用户显式要的一次性决定**——护栏是过程上的三条（入口只在启动那一刻 ·
 * 状态行常驻报着 · 要改得先退出去），不是判据上的。
 *
 * 本文件咬的是**域内那一刀**：`allowAll` 是**构造入参**（造完就没有改它的口——
 * 「对话期间切不进去」在域里就是这个形状），它**不写第二套判据**——`weight` 那一刀仍归
 * `analyze`，这一位只是**替掉"那一问的默认答什么"**（见 `gate.ts` 那一行）。
 *
 * ⚠️ **名单那一圈与 `rules.test.ts` 各自抄一份**（不共用常量）：共用的话，
 * 哪天有人把清单删空，两处会**一起变绿**。
 *
 * 一切经**契约面**：注入 `EventSink` / `EventStamper`，读回事件与返回值。
 */

import { describe, expect, test } from 'bun:test'
import type { Decision, PermissionContext, ToolCall } from '@magic/contracts'
import { createPermissionGate, type PermissionRule } from '../src/index.ts'
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
    readonly rules?: readonly PermissionRule[]
    readonly ctx?: PermissionContext
    readonly grants?: ReturnType<typeof ledger>
    /** 答复时带不带「总是允许」那一位（造一条授权要用）。 */
    readonly remember?: boolean
  } = {},
): Promise<Pass> {
  const h = harness()
  const gate = createPermissionGate({
    sink: h.sink,
    stamper: h.stamper,
    grants: options.grants ?? ledger(),
    ...(options.allowAll === true ? { allowAll: true } : {}),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  })

  const verdict = gate.decide(toolCall, options.ctx ?? context(), 1)
  const request = h.eventsOf('tool.decision.request')[0]
  if (request !== undefined) gate.resolve(request.id, 'approve', { remember: options.remember === true })

  return { asked: request !== undefined, request, verdict: await verdict, h }
}

/** 自动放行的裁决事件——两种放行路径（默认通 / 全放行）的痕迹读法就一处。 */
function autoVerdicts(h: Harness): readonly EventOf<'tool.decision'>[] {
  return h.eventsOf('tool.decision').filter((event) => event.data.decider === 'auto')
}

// ══ ① 判轻的不问 ════════════════════════════════════════════════════

describe('全放行 · 判轻的（与默认一样）不问', () => {
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

  /**
   * ⚠️ **这一条 U76 换过锚**（原：「不在全放行就照旧问——轻类亦问」）。
   * 默认通之后，判轻的**两档都不问** ⇒ 那一对的差别**不在这类调用上**，
   * 而在名单那两条上（见 ② 的差分用例）。
   */
  test('判轻的：**带不带全放行都一样**不问（差别不在这类调用上）', async () => {
    const off = await pass(call('read', { path: 'src/a.ts' }))
    const on = await pass(call('read', { path: 'src/a.ts' }), { allowAll: true })

    expect(off.asked).toBe(false)
    expect(on.asked).toBe(false)
    expect(autoVerdicts(off.h)).toHaveLength(1)
    expect(autoVerdicts(on.h)).toHaveLength(1)
  })

  test('全放行时**不必先配规则**——规则一条没有也放', async () => {
    expect((await pass(call('exec', { cmd: 'ls -la' }), { allowAll: true })).asked).toBe(false)
  })

  test('全放行时**配了规则也照放**——两条来路不打架（都落进同一条自动放行）', async () => {
    const rules: readonly PermissionRule[] = [{ tool: 'read' }]
    expect((await pass(call('read', { path: 'src/a.ts' }), { allowAll: true, rules })).asked).toBe(false)
  })

  test('全放行时**不吃授权账**——放行不是那条授权挣来的，不替它续命', async () => {
    // 用「按域名」那一条授权（默认通之后，`a` 唯一还放得动东西的地方）：
    // 不带全放行时命中一次记一笔；带上全放行时**一格都不动**。
    const offGrants = ledger()
    await pass(fetchTo('https://example.com/a'), { grants: offGrants, remember: true }) // 点出那条授权
    const off = await pass(fetchTo('https://example.com/b'), { grants: offGrants })
    expect(off.asked).toBe(false)
    expect(hitsOf(offGrants)).toBe(1)

    const onGrants = ledger()
    await pass(fetchTo('https://example.com/a'), { grants: onGrants, remember: true })
    await pass(fetchTo('https://example.com/b'), { grants: onGrants, allowAll: true })
    expect(hitsOf(onGrants)).toBe(0)
  })
})

/** 一条判重、带域名的调用（取网页）——「总是允许」在默认通之后只剩这一类有对象。 */
function fetchTo(url: string): ToolCall {
  return call('web_fetch', { url, prompt: '看什么' })
}

/** 本工作区那几条授权一共被记了几次命中（从未命中的那一位**缺席**，不编 0——故 `?? 0`）。 */
function hitsOf(grants: ReturnType<typeof ledger>): number {
  return grants.view().reduce((sum, row) => sum + (row.hits ?? 0), 0)
}

// ══ ② 连必闸也放（U76 改定）════════════════════════════════════════

describe('全放行 · **连必闸也放**——真的什么都不问（U76）', () => {
  /**
   * 旧版这一圈是「全放行时**也照问**」。U76 逐条反过来。
   *
   * 圈里既有**名单那两条**（删除 · 改权限），也有**默认本来就通**的那几类——
   * 一起钉住，是因为这一档要的是「**什么都不问**」，不是「比默认多问少问」。
   */
  const ALL_PASS: readonly { readonly why: string; readonly one: ToolCall }[] = [
    { why: '删除', one: call('exec', { cmd: 'rm -rf build' }) },
    { why: '删除（find -delete）', one: call('exec', { cmd: 'find . -name "*.log" -delete' }) },
    { why: '删除（隔着 `sudo`）', one: call('exec', { cmd: 'sudo rm -rf /tmp/x' }) },
    { why: '删除（越界）', one: call('exec', { cmd: 'rm /etc/hosts' }) },
    { why: '删除（命令替换里的）', one: call('exec', { cmd: 'rm -rf $(cat targets.txt)' }) },
    { why: '改权限（chmod）', one: call('exec', { cmd: 'chmod 777 secret.key' }) },
    { why: '改属主（chown）', one: call('exec', { cmd: 'chown root secret.key' }) },
    { why: '覆盖（重定向）', one: call('exec', { cmd: 'echo hi > config.json' }) },
    { why: '移动 / 重命名', one: call('exec', { cmd: 'mv src old-src' }) },
    { why: '破坏性 git（reset --hard）', one: call('exec', { cmd: 'git reset --hard HEAD~1' }) },
    { why: '外发（git push）', one: call('exec', { cmd: 'git push origin main' }) },
    { why: '外发（curl 上传）', one: call('exec', { cmd: 'curl -X POST https://example.com -d @data.json' }) },
    { why: '看不懂（包一层 shell）', one: call('exec', { cmd: 'bash -c "ls"' }) },
    { why: '工具侧的判重（write）', one: call('write', { path: 'src/a.ts', content: 'x' }) },
    { why: '工具侧的判重（write 落根外）', one: call('write', { path: '/etc/hosts', content: 'x' }) },
    { why: '外发（取网页）', one: fetchTo('https://example.com/a') },
    { why: '外部操作（MCP）', one: call('mcp__files__read', { path: '/tmp' }) },
  ]

  for (const { why, one } of ALL_PASS) {
    test(`${why}：**全放行时也不问**`, async () => {
      const result = await pass(one, { allowAll: true })

      expect(result.asked).toBe(false)
      expect(result.verdict).toBe('approve')
      expect(result.h.countOf('tool.decision.request')).toBe(0)
      expect(autoVerdicts(result.h)).toHaveLength(1)
    })
  }

  test('**这一档比默认更放**——差分：同一批调用，不带它时问的，带上就不问了', async () => {
    const gated: readonly string[] = ['rm -rf build', 'chmod 777 secret.key']

    for (const cmd of gated) {
      const off = await pass(call('exec', { cmd }))
      const on = await pass(call('exec', { cmd }), { allowAll: true })

      expect(off.asked, `${cmd} 不带全放行：照问`).toBe(true)
      expect(on.asked, `${cmd} 带全放行：不问`).toBe(false)
    }

    // 而判轻的那一类两档一样（见 ① 那一条）——差别**只在名单那两条上**
    for (const cmd of ['ls -la', 'mkdir -p src/new', 'git push origin main']) {
      expect((await pass(call('exec', { cmd }))).asked, cmd).toBe(false)
    }
  })

  test('工具侧的判重同理：`write` 恒重——**全放行时也放得动它**', async () => {
    const off = await pass(call('write', { path: 'src/a.ts', content: 'x' }))
    const on = await pass(call('write', { path: 'src/a.ts', content: 'x' }), { allowAll: true })

    expect(off.asked).toBe(true)
    expect(on.asked).toBe(false)
  })

  test('越界那一刀**在这一档下也不再拦**——根外的写与读一样放', async () => {
    expect((await pass(call('read', { path: '/etc/hosts' }), { allowAll: true })).asked).toBe(false)
    expect((await pass(call('write', { path: '/etc/hosts', content: 'x' }), { allowAll: true })).asked).toBe(false)
  })

  test('**名单那两条也不再用 `a` 绕过**——照旧没有「总是允许」这一说（这一档不是"绕过"）', async () => {
    // 全放行不改「名单里的东西不能靠授权」那条：它替的是**那一问的默认答什么**，
    // 而在这一档下那一问根本不发生——故这里量的是「答了 `remember` 也什么都不记」
    const book = ledger()
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: book, allowAll: true })
    await gate.decide(call('exec', { cmd: 'rm -rf build' }), context(), 1)

    expect(book.view()).toEqual([]) // 没问、也没记下任何授权
  })
})
