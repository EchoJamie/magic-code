/**
 * U14 · 权限规则化测试（U22 扩「授权的落点」）—— 验收：**规则用例（命中 / 未命中 /
 * 禁区不可放行）** ＋ **「总是允许」落点＝工作区** ＋ **名单禁区回归** ＋ **度量仍准**。
 *
 * 出处：技术方案 · 权限「规则化（阶段 2）」——自动放行＝规则命中：条目＝
 * （工具 × 路径模式 × 操作类型 × **域名**）→ 允许；**名单里的两条为禁区**——任何规则不可放行。
 * 持久规则存配置文件、用户维护；「总是允许」＝**工作区级授权**（U22 · 技术方案 ·
 * 权限「授权的落点」：`a` 记的是「这个项目我信任」，**会话级那一层取消**）。
 * **优先级链：名单（禁止） ＞ 项目规约（留缝）＞ 手写规则 ＞ 授权 ＞ 其余一律默认通。**
 *
 * ## ⚠️ U76 大改（2026-09-25 用户定）——这里说的都是**换锚**，不是放宽
 *
 * 从前链的底是「**默认问**」：判轻的也要**先配一条规则**才不弹卡 ⇒ 规则是"**必要的例外路径**"。
 * 现在链的底是「**默认通**」：**不配规则也不问**。于是规则的**射程变得极窄**——
 * 它只剩一处还放得动东西：**判重却带域名的那一件**（外发按域名，U72 · `byHost`）。
 *
 * ⇒ 本文件跟着换了两处锚：
 *
 * - 「判轻」不再能靠有无规则区分（**它一律不问**）——那一组改成钉「**默认通**」本身；
 * - 规则**命中**这件事在判重的调用上仍看得出来：材料里会多一句「命中…但被名单否决」
 *   （`gate.ts` 的 `vetoed`）——故**路径 / 操作 / 工具的匹配判据**改从这里读。
 *
 * ⚠️ **没有一条判据被删掉**：路径模式、操作类型、工具名 `*`、声明原形那些匹配规则
 * 一条不少，只是**观察面**从"问没问"换成了"材料里那句话"。
 *
 * ## ⚠️ U77 又换了一次观察面（2026-09-25 · 删除改成"直接拒"）
 *
 * 删除那一类**不问、直接拒**（设计 · 权限「`rm` 直接拒，指路 `trash`」）⇒ 判重的
 * **只剩改权限那一族**。那件事把上面那条路也**堵死了**：改权限**不产出影响面词条**
 * （`WRITE_OPS` 不含 `system`）⇒ `matchesPath` 没有对象可比。
 *
 * ⇒ **匹配判据改成直取 `matchRule`**（面由真 `analyze` 给，匹配本身单独判）——
 * 测的就是匹配器，比借 gate 的旁证更准；而「名单即禁区」那一组**劈成两半**：
 * 改权限那半照旧（问了、被否决），删除那半改成「**最宽的规则也没有卡可弹**」。
 *
 * 一切经**契约面**：注入 `EventSink` / `EventStamper`，读回事件与返回值——
 * 除 `parseRules` / `analyze`（都是公开面本件）外，测试不碰域内部件。
 */

import { describe, expect, test } from 'bun:test'
import type { Decision, PermissionContext, ToolCall } from '@magic/contracts'
import { analyze, createPermissionGate, parseRules, type PermissionRule } from '../src/index.ts'
import { matchRule } from '../src/rules.ts'
import type { GrantLedger } from '../src/grants.ts'
import { call, context, harness, ledger, type EventOf, type Harness } from './helpers.ts'

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

  test('空配置＝无规则（默认通，不必配规则也跑得动）', () => {
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
    grants: ledger(),
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

/**
 * **规则命中了吗**——**直取匹配器**。
 *
 * ## 为什么不再借"判重探针"读（U77 换的）
 *
 * 从前这条靠旁证：拿一条**判重**的命令当探针，命中规则 ⇒ 卡的材料里多一句
 * 「被必闸禁区否决」。U77 之后那条路**窄到走不通**——
 *
 * - 删除那一类**直接拒**（连卡都不出，材料没人读）；
 * - 判重的只剩**改权限那一族**，而它**不产出影响面词条**（`WRITE_OPS` 不含 `system`）
 *   ⇒ **路径模式那一格压根无从比对**（`matchesPath` 要 `landings`）。
 *
 * ⇒ 改成直取 `matchRule`：**面**（工具 / 操作 / 影响面 / 域名）由真 `analyze` 给，
 * **匹配本身**单独判。这比借 gate 的旁证更准（测的就是匹配器），也少一层依赖。
 * 面用 `mv` 那类**会动盘、产得出落点**的命令构造（本组不关心轻重——`matchRule` 也不看它）。
 */
async function hitRule(
  cmd: string,
  rules: readonly PermissionRule[],
  ctx: PermissionContext = context(),
): Promise<boolean> {
  const analysis = analyze(call('exec', { cmd }), ctx)
  return matchRule(rules, { tool: 'exec', ops: analysis.ops, landings: analysis.landings }, ctx) !== undefined
}

// ══ 判据 · 默认通（U76：链的底换了）══════════════════════════════════

describe('默认通——判轻的**不必配规则**也不问', () => {
  test('无规则（配置键整个缺省）：判轻的照样不问，裁者是 `auto`', async () => {
    const result = await pass(call('exec', { cmd: 'ls -la' }), undefined)

    expect(result.asked).toBe(false)
    expect(result.verdict).toBe('approve')
    expect(result.request).toBeUndefined()
    expect(autoVerdicts(result.h)).toHaveLength(1)
  })

  test('**配了规则也不改变什么**——判轻的一律不问（规则不再是"必要的例外路径"）', async () => {
    const withRule = await pass(call('exec', { cmd: 'mkdir -p src/new' }), [{ tool: 'exec', op: 'create' }])
    const without = await pass(call('exec', { cmd: 'mkdir -p src/new' }), [])

    expect(withRule.asked).toBe(false)
    expect(without.asked).toBe(false)
  })

  test('命中与不命中在这一档下**无从分辨**——两条路径的产物一样（都是 auto 放行）', async () => {
    const hit = await pass(call('read', { path: 'src/a.ts' }), [{ tool: 'read' }])
    const miss = await pass(call('read', { path: 'src/a.ts' }), [{ tool: 'grep' }])

    expect(hit.asked).toBe(false)
    expect(miss.asked).toBe(false)
    expect(autoVerdicts(hit.h)).toHaveLength(1)
    expect(autoVerdicts(miss.h)).toHaveLength(1)
  })

  test('判重的**照问**——那条路规则够不着（除"按域名"那一处，见 U72 的用例）', async () => {
    const result = await pass(call('exec', { cmd: 'chmod 600 build' }), [{ tool: 'exec', op: 'system' }])

    expect(result.asked).toBe(true)
    expect(result.request?.data.weight).toBe('heavy')
  })
})

// ══ 判据 · 规则匹配的判据（借"命中了没"来读）═════════════════════════

describe('规则匹配——工具 × 路径模式 × 操作类型（直取匹配器）', () => {
  test('路径模式命中才算——模式之外的路径不命中', async () => {
    const rules: readonly PermissionRule[] = [{ tool: 'exec', path: 'build/**', op: 'move' }]

    expect(await hitRule('mv build/a.o /tmp/x', rules)).toBe(true)
    expect(await hitRule('mv dist/a.o /tmp/x', rules)).toBe(false)
  })

  test('操作类型命中才算——同一工具的另一类操作不命中', async () => {
    const rules: readonly PermissionRule[] = [{ tool: 'exec', path: '**', op: 'read' }]

    expect(await hitRule('mv a b', rules)).toBe(false) // 本次是移动，不是只读
    expect(await hitRule('mv a b', [{ tool: 'exec', path: '**', op: 'move' }])).toBe(true)
  })

  test('工具名 `*` ＝任意工具；路径与操作类型缺省＝根内 · 任意', async () => {
    expect(await hitRule('mv a b', ANYTHING)).toBe(true)
    expect(await hitRule('mv a b', [{ tool: 'read' }])).toBe(false) // 别的工具名
  })

  test('路径缺省＝**根内**——根外那条规则够不着', async () => {
    // `/etc/hosts` 在根外：写明了 `/etc/**` 的规则才命中（用户写明的地方才是用户的意图）
    expect(await hitRule('mv /etc/hosts /tmp/x', [{ tool: 'exec' }])).toBe(false)
    expect(await hitRule('mv /etc/hosts /tmp/x', [{ tool: 'exec', path: '/etc/**' }])).toBe(true)
  })

  test('规则声明的操作类型须**覆盖本次调用的全部**——复合命令的每一段都算数', async () => {
    expect(await hitRule('cd x && mv a b', [{ tool: 'exec', op: 'move' }])).toBe(false)
    expect(await hitRule('cd x && mv a b', [{ tool: 'exec', op: ['move', 'unknown'] }])).toBe(true)
  })
})

// ══ 判据 · 名单即禁区（优先级：名单 ＞ 规则 ＞ 默认通）═══════════════

describe('名单即禁区——任何规则不可放行（U76：名单只剩两条）', () => {
  /**
   * 名单里那一条（**改权限 / 属主 / 属性 / ACL**）的一圈攻法：
   * 最宽的规则（任意工具 · 任意路径 · 任意操作）逐个碰。
   *
   * ⚠️ **U77 起这一组只剩改权限那一族**：删除那一类**不再"问"**（直接拒），
   * 故"规则命中也不放行"对它无从谈起——它归下面那一组。
   */
  const GATED: readonly { readonly why: string; readonly cmd: string }[] = [
    { why: '改权限（chmod）', cmd: 'chmod 777 secret.key' },
    { why: '改属主（chown）', cmd: 'chown root secret.key' },
    { why: '改 ACL（setfacl）', cmd: 'setfacl -m u:echo:r secret.key' },
  ]

  for (const { why, cmd } of GATED) {
    test(`${why}：「${cmd}」——规则命中也不放行`, async () => {
      const result = await pass(call('exec', { cmd }), ANYTHING)

      expect(result.asked).toBe(true)
      expect(result.request?.data.weight).toBe('heavy')
      expect(autoVerdicts(result.h)).toEqual([])
    })
  }

  /**
   * **删除那一类：规则连"否决"的机会都没有**（U77）——它压根不走"问"那条路。
   *
   * 这是"名单即禁区"更强的一形：那一类**不是"规则够不着"**，是**根本没有卡可弹**
   * ——最宽的规则（任意工具 · 任意路径 · 任意操作）碰上它，结果与没配规则时**一模一样**。
   */
  const REFUSED_ANYWAY: readonly { readonly why: string; readonly cmd: string }[] = [
    { why: '删除', cmd: 'rm -rf build' },
    { why: '删除（find -delete）', cmd: 'find . -name "*.log" -delete' },
    { why: '删除（shred）', cmd: 'shred secret.key' },
    { why: '删除（隔着 `sudo`）', cmd: 'sudo rm -rf /tmp/x' },
    { why: '删除（命令替换里的）', cmd: 'rm -rf $(cat targets.txt)' },
    { why: '删除（越界）', cmd: 'rm /etc/hosts' },
  ]

  for (const { why, cmd } of REFUSED_ANYWAY) {
    test(`${why}：「${cmd}」——最宽的规则也**没有卡可弹**（照拒）`, async () => {
      const result = await pass(call('exec', { cmd }), ANYTHING)

      expect(result.asked, '不问').toBe(false)
      expect(result.h.countOf('tool.decision.request')).toBe(0)
      expect(result.verdict, '照拒').toBe('reject')

      // ⚠️ 落的那一条裁决是 `reject` + `decider: 'kernel'`——**「没问就拒」与「没问就放行」
      // 是两件事**（那本账的口径正是「没问就怎样」）：U77 补的那一格就是为把它们分开
      // （写成 `auto` 的话，「拒」会被读成「放行」——正好反着；回归用例在 records 那一边）。
      const made = result.h.eventsOf('tool.decision')[0]
      expect(made?.data.decision).toBe('reject')
      expect(made?.data.decider).toBe('kernel')
    })
  }

  test('工具侧的判重同理：write 恒重——规则放不了它', async () => {
    const result = await pass(call('write', { path: 'src/a.ts', content: 'x' }), ANYTHING)

    expect(result.asked).toBe(true)
    expect(result.request?.data.weight).toBe('heavy')
  })

  test('两条路径不许分叉——规则说放、`analyze` 说入名单 ⇒ **必须问**', async () => {
    // 同一个调用：规则三格全命中（工具 exec · 路径根内 · 操作不设限），`analyze` 判「系统级（改权限）」
    const result = await pass(call('exec', { cmd: 'chmod 600 build' }), [
      { tool: 'exec', path: '**', op: ['read', 'create', 'system'] },
    ])

    expect(result.asked).toBe(true)
    expect(result.request?.data.weight).toBe('heavy')
    expect(result.verdict).toBe('approve') // 问过 → 人答的，不是自动的
    expect(result.h.eventsOf('tool.decision')[0]?.data.decider).toBe('user')
  })

  test('问得明白：材料里给出「配了规则为什么还问」', async () => {
    const result = await pass(call('exec', { cmd: 'chmod 600 secret.key' }), [{ tool: 'exec' }])

    const material = result.request?.data.material ?? ''
    expect(material).toContain('禁区')
    expect(material).toContain('必闸 ＞ 规则')
  })

  /**
   * ⚠️ **反面**：不在名单里的那几类**没有闸门**——最宽的规则也"放行"不了它们，
   * 因为**它们本来就不问**（软防线，靠提示词；设计已认下）。
   */
  test('不在名单里的：最宽的规则也不改变什么——它们本来就不问', async () => {
    for (const cmd of ['mv src old-src', 'git reset --hard HEAD~1', 'curl -X POST https://example.com', 'sudo ls']) {
      const result = await pass(call('exec', { cmd }), ANYTHING)

      expect(result.asked, cmd).toBe(false)
      expect(result.request, cmd).toBeUndefined()
    }
  })
})

// ══ 判据 · 声明原形（U22 · 权限域的根表与执行域同源）════════════════════

/**
 * **两张表**（技术方案 · 权限「权限域的根表要与执行域同源」）——`U27` 把执行域的落点判定
 * 改成「`realpath` 规范形 ＋ **声明原形**」之后，闸门这一侧还只有规范形 ⇒ **声明原形下的
 * 读类每次弹卡**（沙箱认了、闸门不认 ✗）。
 *
 * 这组用例钉的就是那件事，用的是 macOS 上最经典的一对：`/tmp` 实为 `/private/tmp`。
 * 用户手写 `/tmp/proj` 注册（**声明原形**），执行域把它 `realpath` 成 `/private/tmp/proj`
 * （**规范形 · 身份**），而模型照用户写的那一串给路径。
 *
 * ⚠️ **U76 换探针**：原来拿「读类弹不弹卡」量，而读类如今**一律不问** ⇒ 那个差就看不见了。
 * 换成 **`edit` 的根内 / 根外**（判轻 ⇄ 判重）——它判的就是落点认不认得出这两张表，
 * 与 U22 当年那条判据是同一件事。
 */
describe('声明原形（U22）——落点认两张表', () => {
  /** 一条根，两种写法——照 macOS 的 `/tmp` ⇄ `/private/tmp`。 */
  const MAC = (): PermissionContext => context(['/private/tmp/proj'], ['/tmp/proj'])

  test('**声明原形下的根内写不弹卡**——两张表都认得出来', async () => {
    const result = await pass(call('edit', { path: '/tmp/proj/src/a.ts', oldString: 'a', newString: 'b' }), [], MAC())

    expect(result.asked).toBe(false) // ← 修之前这里是 true（判成根外）
    expect(result.request).toBeUndefined()
    expect(autoVerdicts(result.h)).toHaveLength(1)
  })

  test('两张表都认——规范形那一张照旧（U18 的行为一条不丢）', async () => {
    const normalized = await pass(
      call('edit', { path: '/private/tmp/proj/src/a.ts', oldString: 'a', newString: 'b' }),
      [],
      MAC(),
    )
    expect(normalized.asked).toBe(false)

    // 声明原形那一张也照旧
    const declared = await pass(
      call('edit', { path: '/tmp/proj/src/b.ts', oldString: 'a', newString: 'b' }),
      [],
      MAC(),
    )
    expect(declared.asked).toBe(false)
  })

  test('**越界照旧**——两张表都够不着的就是根外（不是「认了声明原形就什么都放」）', async () => {
    const result = await pass(call('edit', { path: '/tmp/elsewhere/a.ts', oldString: 'a', newString: 'b' }), [], MAC())

    expect(result.asked).toBe(true)
    expect(result.request?.data.weight).toBe('heavy')
  })

  test('规则那一路也认两张表——写规范形的模式命中声明原形的落点', async () => {
    const rules: readonly PermissionRule[] = [{ tool: 'exec', path: '/private/tmp/proj/**', op: 'move' }]

    expect(await hitRule('mv /tmp/proj/build /tmp/x', rules, MAC())).toBe(true)
    expect(await hitRule('mv /tmp/elsewhere/build /tmp/x', rules, MAC())).toBe(false)
  })

  test('材料说得出「是按声明原形认的」——身份报规范形，写法报用户认得的那个', () => {
    // 材料面直取 `analyze`（`read` 判轻、不弹卡，材料不再经事件出口）
    const material = analyze(call('read', { path: '/tmp/proj/a.ts' }), MAC()).material

    expect(material).toContain('/private/tmp/proj') // 身份＝规范形
    expect(material).toContain('按声明原形认的') // 而认它的是哪一张表，说清楚
  })
})

// ══ 判据 · 缺省路径（＝根内）那一格：U80 起盖得住「内核自己那处」══════════

/**
 * **内核自己的只读落点**（U80）——`exec` 后台那一形的**输出目录**。
 *
 * ## 这一格要钉的是**由头那句话**
 *
 * 规则不写路径时，缺省是「**根内**」——判据落在 `matchesPath`（`landings.every(inside)`）。
 * 而那个输出文件**落在工作区之外**（设计明文），于是 **`{tool:'read'}`（＝按 `a` 记下的
 * 「本工作区总是允许 read」那一形）盖不住它** ⇒ 每次读我们自己的产物都要问一次。
 * 它是**我们自己的产物**、不是用户的东西 ⇒ U80 起**不算越界**，这一格因此为真。
 *
 * ⚠️ **反面在同一份名单里**：认的是**那几处**、且**只在读那一类**——
 * 同一份配置下，工作区外「用户的东西」照旧根外（规则照旧盖不住），
 * 而**写 / 删 / 移**那一侧压根不接这一位（`analyze` 只把这一位交给 `analyzeSearch`）。
 *
 * ## ⚠️ 探针为什么是 `matchRule` 而不是「问没问」
 *
 * 同 U77 换过一次的那条由头：读类判**轻** ⇒ 默认通 ⇒ **问没问**这件事在读类上
 * 两种情形**一样**（都不问）。故这里与 U77 同一姿势——**面**由真 `analyze` 给，
 * **匹配本身**直取 `matchRule`：测的就是「这一格盖不盖得住」。
 */
describe('缺省路径（＝根内）那一格：U80 起盖得住内核自己那处', () => {
  /** 后台输出目录（`<基础目录>/run/<指纹>/bg`）——它**不在**任何一条根里。 */
  const BG_DIR = '/Users/me/.magic/run/8b0ed361ea/bg'
  const BG_LOG = `${BG_DIR}/bg-1.log`
  /** 工作区外**用户自己的**一个文件——反面那一格用它。 */
  const USER_FILE = '/Users/me/.zshrc'

  /** 读那一件的**面**——`dirs` 照闸门那一侧给的 `readOnlyDirs` 给（缺省＝没接这一位）。 */
  function hitRead(path: string, rules: readonly PermissionRule[], dirs?: readonly string[]): boolean {
    const face = analyze(call('read', { path }), context(), dirs)
    return matchRule(rules, { tool: 'read', ops: face.ops, landings: face.landings }, context()) !== undefined
  }

  test('`{tool:"read"}`（缺省路径＝根内）**盖得住**那个输出文件', () => {
    expect(hitRead(BG_LOG, [{ tool: 'read' }], [BG_DIR])).toBe(true)
  })

  test('⚠️ 反面 · 同一条规则**盖不住**工作区外用户自己的文件', () => {
    expect(hitRead(USER_FILE, [{ tool: 'read' }], [BG_DIR])).toBe(false)
  })

  test('⚠️ 反面 · 认的是**那一条目录**，不是「工作区外一律」', () => {
    // 另一个工作区外的目录（同级的邻居）照旧盖不住
    expect(hitRead('/Users/me/.magic/run/8b0ed361ea/other/bg-1.log', [{ tool: 'read' }], [BG_DIR])).toBe(false)
  })

  test('**没接**这一位 ⇒ 照旧盖不住（既有装配与用例一字不动）', () => {
    expect(hitRead(BG_LOG, [{ tool: 'read' }])).toBe(false)
  })

  test('写那一类**不接**这一位：`{tool:"write"}` 盖不住往那处的写（照旧必闸）', () => {
    const face = analyze(call('write', { path: BG_LOG, content: 'x' }), context(), [BG_DIR])
    const hit = matchRule([{ tool: 'write' }], { tool: 'write', ops: face.ops, landings: face.landings }, context())

    expect(hit).toBeUndefined()
  })
})

// ══ 判据 · 「总是允许」的落点＝**工作区**（U22 迁移）════════════════════

/**
 * 「总是允许」的落点（技术方案 · 权限「授权的落点」）——**两层，不是三层**：
 *
 * - `y` 批准＝**这一次**（不记）；`a` 总是允许＝**这个工作区**（记）。
 * - **「会话级记忆」那一层取消**——会话不是信任的边界（它会失效不是因为「该失效」，
 *   而是因为会话必然结束，那是实现的副产品）。
 *
 * ⚠️ **U76 换探针：改走「按域名」那一件**（`web_fetch`）。由头：默认通之后，
 * `a` 唯一还有对象的地方就是**判重却带域名**的调用——判轻的根本不问（不必授权），
 * 名单那两条按必闸精神不可绕过（授权也放不动）。**这不是换一件事测**：
 * 「点出来的授权记在哪儿、活多久、撤销之后怎样」这几条判据一条没动，换的是承载它的调用。
 */
describe('「总是允许」——落点是工作区', () => {
  /** 一条判重、带域名的调用（取网页）——`a` 在这一类上还放得动东西。 */
  const fetchTo = (url: string): ToolCall => call('web_fetch', { url, prompt: '看什么' })
  /** 同一个域名里的一条规则——`a` 凝出来的正是它。 */
  const toHost = (host: string): readonly PermissionRule[] => [{ tool: 'web_fetch', host }]

  /**
   * 一个**会话**＝一个闸门实例；**工作区**＝一份账本（跨会话共用）。
   *
   * 故这里的参数是**账本**而不是「无」：两次 `session(sameLedger)` ＝ 同一工作区的两条会话
   * （U16 里切走再切回、或关掉重开都在此列），`session(ledger('别处'))` ＝ 换个项目。
   */
  function session(ledgerOf: GrantLedger, rules: readonly PermissionRule[] = []) {
    const h = harness()
    const gate = createPermissionGate({
      sink: h.sink,
      stamper: h.stamper,
      rules,
      grants: ledgerOf,
    })

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

  /** 一个工作区（默认根 `/work/proj`）——本组的主角。 */
  const here = (): GrantLedger => ledger()

  test('答复「总是允许」后，**同一个域名**不再问', async () => {
    const s = session(here())

    expect((await s.through(fetchTo('https://example.com/a'), 'approve', true)).asked).toBe(true)
    expect((await s.through(fetchTo('https://example.com/b'))).asked).toBe(false)
    expect(s.h.countOf('tool.decision.request')).toBe(1) // 第二次没问
  })

  test('同类＝同工具 × 同操作类型 × **同域名**——别的域名照问', async () => {
    const s = session(here())
    await s.through(fetchTo('https://example.com/a'), 'approve', true)

    expect((await s.through(fetchTo('https://example.com/b'))).asked).toBe(false) // 同域名
    expect((await s.through(fetchTo('https://other.example.org/x'))).asked).toBe(true) // 换了域名
  })

  test('**判轻的那一类不必授权**——没点过「总是允许」也不问', async () => {
    const s = session(here())

    expect((await s.through(call('read', { path: 'a.txt' }))).asked).toBe(false)
    expect((await s.through(call('exec', { cmd: 'mkdir -p src/new' }))).asked).toBe(false)
  })

  test('**新会话照样继承**——授权活在账本里（工作区级），不在闸门实例里', async () => {
    const book = here() // 一个工作区＝一份账本（跨会话共用）

    const first = session(book)
    await first.through(fetchTo('https://example.com/a'), 'approve', true)
    expect((await first.through(fetchTo('https://example.com/b'))).asked).toBe(false)

    const second = session(book) // 新会话＝新闸门实例；**同一个工作区**＝同一份账本
    expect((await second.through(fetchTo('https://example.com/c'))).asked).toBe(false)
    expect(second.h.countOf('tool.decision.request')).toBe(0) // 一次都没问
  })

  test('**换个工作区不继承**——账本是分节的，别处的授权不是这儿的', async () => {
    const first = session(here())
    await first.through(fetchTo('https://example.com/a'), 'approve', true)

    const elsewhere = session(ledger('/work/other')) // 另一个默认根
    expect((await elsewhere.through(fetchTo('https://example.com/b'))).asked).toBe(true)
  })

  test('授权**也是一种规则**——名单里那一条照样被否决（在改权限上选「总是允许」不生效）', async () => {
    const s = session(here())
    expect((await s.through(call('exec', { cmd: 'chmod 600 secret.key' }), 'approve', true)).asked).toBe(true)

    const again = await s.through(call('exec', { cmd: 'chmod 400 secret.key' }))
    expect(again.asked).toBe(true)
    expect(again.material).toContain('禁区') // 而且说得出为什么还问
  })

  test('**授权在删除那一类上更无从谈起**（U77）——它连卡都不出，没有"总是允许"可点', async () => {
    const s = session(here())
    const again = await s.through(call('exec', { cmd: 'rm -rf build' }))

    expect(again.asked).toBe(false)
    expect(again.verdict).toBe('reject')
  })

  test('拒绝带 remember 位＝不记——规则的条目只有「允许」这一形', async () => {
    const s = session(here())
    expect((await s.through(fetchTo('https://example.com/a'), 'reject', true)).verdict).toBe('reject')
    expect((await s.through(fetchTo('https://example.com/a'))).asked).toBe(true)
  })

  test('授权与配置规则并存——配置在前、授权在后，各自管各自的域名', async () => {
    const s = session(here(), toHost('example.com'))

    // 配置规则那一条：`example.com` 不问
    expect((await s.through(fetchTo('https://example.com/a'))).asked).toBe(false)
    // 点出来的授权那一条：另一个域名第一次问，答「总是允许」之后不问
    expect((await s.through(fetchTo('https://other.example.org/a'), 'approve', true)).asked).toBe(true)
    expect((await s.through(fetchTo('https://other.example.org/b'))).asked).toBe(false)
    // 两条都没覆盖的照问
    expect((await s.through(fetchTo('https://third.example.net/a'))).asked).toBe(true)
  })

  test('命中记账——真省了一次点击才记（进了名录就是证据）', async () => {
    const book = here()
    const s = session(book)
    await s.through(fetchTo('https://example.com/a'), 'approve', true) // 点一下「总是允许」
    await s.through(fetchTo('https://example.com/b')) // 这一次是那条授权放行的

    const row = book.view()[0]
    expect(row?.hits).toBe(1)
    expect(row?.lastHitAt).toBeNumber()
  })

  test('**撤销之后照问**——名录里没了，闸门就不再认它', async () => {
    const book = here()
    const s = session(book)
    await s.through(fetchTo('https://example.com/a'), 'approve', true)
    expect((await s.through(fetchTo('https://example.com/b'))).asked).toBe(false)

    expect(book.revoke(book.workspace, 0)).toBe(true)
    expect((await s.through(fetchTo('https://example.com/c'))).asked).toBe(true)
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
      grants: ledger(),
      ...(rules === undefined ? {} : { rules }),
      now: () => (value += step),
    })
    return { gate, h, advance: (by: number) => void (value += by) }
  }

  test('自动放行（默认通）：耗时为**实测**——跟着钟走，不是 0、也不是常数', async () => {
    const slow = ticking(7, undefined)
    await slow.gate.decide(call('read', { path: 'a.txt' }), context(), 1)

    const fast = ticking(3, undefined)
    await fast.gate.decide(call('read', { path: 'a.txt' }), context(), 1)

    const elapsed = (h: Harness): number => h.eventsOf('tool.decision')[0]?.data.elapsedMs ?? -1

    expect(elapsed(slow.h)).toBeGreaterThan(0) // `0` 顶替会在这里露馅
    expect(elapsed(fast.h)).toBeGreaterThan(0)
    expect(elapsed(slow.h)).toBeGreaterThan(elapsed(fast.h)) // 常数会在这一条露馅
  })

  test('自动放行**不问**——所以「提示 → 答复」那条口径对它不适用（改读判定耗时）', async () => {
    const { gate, h } = ticking(1, undefined)
    expect(await gate.decide(call('read', { path: 'a.txt' }), context(), 1)).toBe('approve')

    expect(h.countOf('tool.decision.request')).toBe(0) // 没有提示
    expect(h.eventsOf('tool.decision')[0]?.data.decider).toBe('auto') // 读法按裁者分列
    expect(h.eventsOf('tool.decision')[0]?.data.elapsedMs).toBeGreaterThan(0)
  })

  test('人工路径同一把尺子——本域开始处理 → 答复，人在闸门前停留的时间算在里面', async () => {
    const { gate, h, advance } = ticking(5, undefined)

    const verdict = gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)
    const request = h.eventsOf('tool.decision.request')[0]
    if (request === undefined) throw new Error('未发询问事件')

    advance(1_000) // 人在闸门前停了一秒
    gate.resolve(request.id, 'approve')

    expect(await verdict).toBe('approve')
    expect(h.eventsOf('tool.decision')[0]?.data.elapsedMs).toBeGreaterThanOrEqual(1_000)
  })
})
