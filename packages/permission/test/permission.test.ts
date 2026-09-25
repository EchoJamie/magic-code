/**
 * U07 · 权限域（闸门）测试 —— 验收：**工作分解 · 波次 1「验收判据 · U07」六条**。
 *
 * 逐条对应：
 * 1. 过闸——**判重的**产生 `tool.decision.request`，批准才执行；
 * 2. 呈现轻重——**名单里那两条** `heavy`（材料＝命令分解 / 影响面），**其余 `light`**；
 * 3. 答复流转——`decision.answer`（配对＝请求事件 id）→ `tool.decision`（`decider` · `elapsedMs`）；
 * 4. 拒绝回填——被拒调用得 `reject`（不执行）；同轮其余调用照常；
 * 5. 判不出来——**「读不懂」的命令按默认通**（U76）；**调用形态不可信**那一档仍从严；
 * 6. 裁决不入记录——裁决过程只走事件、不入条目。
 *
 * ⚠️ **U76 改过本文件的多条判据**（2026-09-25 用户定）：从前是「阶段 1 全人工门」——
 * **每个调用都要问**，判轻的也不例外；现在**默认通**（不在名单里就不必配规则），
 * 名单只剩两条（删除 · 改权限/属主/属性/ACL）。改法不是把判据放宽，而是**换锚**：
 * 「判轻」这件事本身现在**可观测**——它表现为**不发询问事件 ＋ 落一条 `auto` 裁决**。
 *
 * 一切经**契约面**：注入 `EventSink` / `EventStamper`，读回事件与返回值。
 * 例外是「材料面」那一支：判轻的不弹卡 ⇒ 材料不再经事件出口，那几处**直取 `analyze`**
 * （本域公开面之一，注释里写着「供外壳预览与测试直取」）。
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type {
  Decision,
  DecisionWeight,
  PermissionGate as PermissionGatePort,
  RefusalKind,
  ToolCall,
} from '@magic/contracts'
import { analyze, createPermissionGate } from '../src/index.ts'
import { call, context, harness, ledger, weighing, type EventOf, type Harness } from './helpers.ts'

/** 走一次闸门：那两条事件（问没问 ＋ 裁决）与扇出记录。 */
function through(
  toolCall: ToolCall,
  roots: readonly string[] = ['/work/proj'],
): {
  readonly request: EventOf<'tool.decision.request'> | undefined
  readonly decision: EventOf<'tool.decision'> | undefined
  readonly seq: Harness
} {
  const h = harness()
  const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })
  void gate.decide(toolCall, context(roots), 1) // 链引用必填（本轮契约）

  return { request: h.eventsOf('tool.decision.request')[0], decision: h.eventsOf('tool.decision')[0], seq: h }
}

/**
 * **照问**那一类（名单里那两条）——取呈现轻重与材料。
 *
 * 没问＝这条用例的前提不成立（**当场抛**，不静默给个空）：默认通之后，
 * 「以为会问、其实不问」正是最该抓的回归。
 */
function weigh(
  toolCall: ToolCall,
  roots: readonly string[] = ['/work/proj'],
): { readonly weight: DecisionWeight; readonly material: string; readonly seq: Harness } {
  const { request, seq } = through(toolCall, roots)
  if (request === undefined) throw new Error('这一笔**没问**（默认通）——要判重的调用才用 weigh')
  return { weight: request.data.weight, material: request.data.material, seq }
}

/**
 * **默认通**那一类——断言它**不问**、直接放行。
 *
 * 两件一起才说明「放行」：**没有询问**（不是卡住了）＋ **裁决是 `auto`**
 * （不是有人替它批的）。
 */
function passes(toolCall: ToolCall, roots: readonly string[] = ['/work/proj']): Harness {
  const { request, decision, seq } = through(toolCall, roots)
  expect(request, '默认通：不发询问').toBeUndefined()
  expect(decision?.data.decision).toBe('approve')
  expect(decision?.data.decider).toBe('auto')
  return seq
}

/**
 * **内核直接拒**那一笔——取它的结论（拒了 · 没问 · 理由是哪条 · 材料怎么写的）。
 *
 * 三件一起才叫"直接拒"：
 * - **没发询问**（不是"卡住了"——卡住了也不会没有 `tool.decision.request`）；
 * - **裁决是 `reject`**（返回给工具域的那个值）；
 * - **裁者是 `auto`**（内核按规则自己定的，没人被问过）。
 *
 * ⚠️ 「这一笔**没被拒**」＝**用例前提不成立**，当场抛（同 `weigh` / `passes` 的姿势）：
 * 静默地拿到一个「其实是要问的」调用，会让整条用例测的不是它以为自己测的那件事。
 */
async function refusedBy(
  toolCall: ToolCall,
  roots: readonly string[] = ['/work/proj'],
): Promise<{ readonly refusal: RefusalKind; readonly material: string; readonly seq: Harness }> {
  const h = harness()
  const ctx = context(roots)
  const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

  const refusal = gate.refusalOf(toolCall, ctx)
  if (refusal === undefined) throw new Error('这一笔**没被拒**（用例前提不成立）')

  const decision = await gate.decide(toolCall, ctx, 1)
  const made = h.eventsOf('tool.decision')[0]

  expect(h.eventsOf('tool.decision.request'), '直接拒＝**不发询问**（屏上没有卡）').toEqual([])
  expect(decision).toBe('reject')
  expect(made?.data.decision).toBe('reject')
  expect(made?.data.decider).toBe('auto')

  return { refusal, material: analyze(toolCall, ctx).material, seq: h }
}

// ══ 参数键（技术方案 · 工具：参数键部分锚定）═════════════════════════

describe('参数键', () => {
  test('exec 的命令字段＝单一键 `cmd`——别的键名不再兜底（从严）', () => {
    // `cmd` 给对了：命令读得出（`ls` 不在名单里）⇒ 默认通
    passes(call('exec', { cmd: 'ls' }))

    // 「已按候选键兜底者收窄为单一键」（技术方案 · 工具）——写错的键名不该被猜中。
    // ⚠️ **这一半照旧从严**：读不到命令字段＝**这一笔调用形态不成立**，
    // 不是「读不懂这条命令」（U76 的「判不出来 ⇒ 通」管的是后者，见「判据 5」）。
    expect(weigh(call('exec', { command: 'ls' })).weight).toBe('heavy')
    expect(weigh(call('exec', { script: 'ls' })).weight).toBe('heavy')
    expect(weigh(call('exec', { shell: 'ls' })).weight).toBe('heavy')
  })

  test('路径类工具的键名**仍是候选集**——其余工具键名随 U13 定（未定处不得依赖）', () => {
    // 参数键读得出 ⇒ 这一笔读得懂 ⇒ 默认通（读类与根内增量编辑都不在名单里）
    passes(call('read', { path: 'src/a.ts' }))
    passes(call('read', { filePath: 'src/a.ts' }))
    passes(call('edit', { file_path: 'src/a.ts' }))
    passes(call('ls', { dir: 'src' }))
  })
})

// ══ 判据 1 · 一律经人工门 ════════════════════════════════════════════

describe('判据 1 · 过闸（判重的才问）', () => {
  test('判重的每一次调用都产生一条 tool.decision.request', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    void gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)

    const requests = h.eventsOf('tool.decision.request')
    expect(requests.length).toBe(1)
    expect(requests[0]?.data.name).toBe('exec')
  })

  /**
   * ⚠️ **这一条 U76 换过锚**（原：「每个工具调用都产生一条请求——轻类亦然」）。
   *
   * 默认通之后，「判轻」不再是「弹一张轻的卡」，而是**根本不弹卡**——
   * 故它由这半边接住（正面在「不在名单里 ⇒ 默认通」那一组里逐条量）。
   */
  test('判轻的**不产生**询问——只落一条 `auto` 裁决（默认通）', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    expect(await gate.decide(call('read', { path: 'a.txt' }), context(), 1)).toBe('approve')

    expect(h.countOf('tool.decision.request')).toBe(0)
    expect(h.eventsOf('tool.decision')[0]?.data.decider).toBe('auto')
  })

  test('未答复＝不落定（批准才执行）', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    let verdict: Decision | undefined
    void gate
      .decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)
      .then((decision) => void (verdict = decision))

    await Promise.resolve()
    expect(verdict).toBeUndefined()
  })

  test('契约端口面：三参调用（消费者只认已冻的 `PermissionGate`）', async () => {
    const h = harness()
    // 按**契约端口**取用（工具域的姿势）：`callRef` ＝ 该次 `tool.call` 事件的 id
    const gate: PermissionGatePort = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    const verdict = gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 42)
    const request = h.eventsOf('tool.decision.request')[0]
    if (request === undefined) throw new Error('未发询问事件')

    gate.resolve(request.id, 'approve')

    expect(await verdict).toBe('approve')
    expect(request.data.weight).toBe('heavy')
    expect(request.data.call).toBe(42)
  })
})

// ══ 判据 2 · 呈现轻重 ════════════════════════════════════════════════

describe('判据 2 · 要授权的**只剩一条**：改权限 / 属主 / 属性 / ACL（U77）', () => {
  /**
   * **名单第二类 · 改权限 / 属主 / 属性 / ACL**——判据**按类收，不按名字收**
   * （2026-09-25 用户定：同族将来多一件，照口径收进来即可，判据本身不动）。
   *
   * ⚠️ **U77 起，名单里只剩这一组**：删除那一类**从"要授权"整类移出**——
   * 它归下一组（**直接拒**）。这里的每一条仍走「发卡 → 等答复」那条老路。
   */
  const PERMISSION: readonly { readonly why: string; readonly cmd: string }[] = [
    { why: '改权限（chmod）', cmd: 'chmod 777 secret.key' },
    { why: '改属主（chown）', cmd: 'chown root secret.key' },
    { why: '改属组（chgrp）', cmd: 'chgrp staff secret.key' },
    { why: '改属性（chattr）', cmd: 'chattr +i secret.key' },
    { why: '改属性（chflags）', cmd: 'chflags hidden secret.key' },
    { why: '改 ACL（setfacl）', cmd: 'setfacl -m u:echo:r secret.key' },
  ]

  for (const { why, cmd } of PERMISSION) {
    test(`${why}：「${cmd}」照问`, () => {
      const { weight, material } = weigh(call('exec', { cmd }))
      expect(weight).toBe('heavy')
      // 重呈现要给足判断材料：命令分解（技术方案 · 权限：呈现——diff / 命令分解 / 影响面）
      expect(material).toContain('命令分解')
      expect(material).toContain(cmd.split(' ')[0] ?? '')
    })
  }

  test('材料里说得出是**哪一类**入的名单（判据那一行）', () => {
    expect(weigh(call('exec', { cmd: 'chmod 600 secret.key' })).material).toContain(
      '判据：系统级（改权限 / 属主 / 属性 / ACL）',
    )
  })

  test('**删除那一类不再问**——它归下一组（直接拒，没有卡）', () => {
    for (const cmd of ['rm -rf build', 'rmdir build', 'unlink build/a.o', 'shred secret.key']) {
      expect(through(call('exec', { cmd })).request, `「${cmd}」不该发询问`).toBeUndefined()
    }
  })
})

/**
 * **删除那一类 ⇒ 直接拒**（U77 · 设计 · 权限「`rm` 直接拒，指路 `trash`」）。
 *
 * ## 这一组钉住四件
 *
 * 1. **拒**（不是问）：**不发询问**（没有卡、没有 `y/a/n`）＋ 裁决是 `reject`；
 * 2. **理由分两支**：`rm` 那族**不可逆但有替代**（回执指路 `trash`）；
 *    `shred` / `srm` **要的就是不可逆**（回执不给替代）；
 * 3. **识别面照旧**——包装词（`sudo`）· 越界落点 · 复合命令里那一段 · 命令替换里的，
 *    **一个都漏不掉**（判据仍是 U76 那一套，本单没动它）；
 * 4. **材料照旧给得出"为什么出格"**（`判据：不可逆（收不回）`）——虽然现在没有卡了，
 *    那一份命令分解仍是审计与用例读得到的同一份结论。
 *
 * ⚠️ **全放行下照样拒**那一条在 `allow-all.test.ts` 里（它与那一档是同一件事的两面）。
 */
describe('判据 2 · 删除那一类 ⇒ **直接拒**（不问、也不放）', () => {
  /** **不可逆但有替代**：这一族拒了之后要指路（`trash`）。 */
  const IRREVERSIBLE: readonly { readonly why: string; readonly cmd: string }[] = [
    { why: '删除（rm）', cmd: 'rm -rf build' },
    { why: '删除（rm 一个文件）', cmd: 'rm -f a.txt' },
    { why: '删除（rmdir）', cmd: 'rmdir build' },
    { why: '删除（unlink）', cmd: 'unlink build/a.o' },
    { why: '删除（find -delete）', cmd: 'find . -name "*.log" -delete' },
    // 识别面照旧——下面这四条是 U76 咬过的那几个"藏得住的写法"，本单不许漏
    { why: '删除（隔着 `sudo` 也认得出）', cmd: 'sudo rm -rf /tmp/x' },
    { why: '删除（落在根外照拒）', cmd: 'rm -rf /etc/hosts' },
    { why: '删除（复合命令里那一段）', cmd: 'cd x && rm -rf y' },
    { why: '删除（命令替换那一段）', cmd: 'rm -rf $(cat targets.txt)' },
  ]

  for (const { why, cmd } of IRREVERSIBLE) {
    test(`${why}：「${cmd}」⇒ 拒（理由＝不可逆，指路 trash）`, async () => {
      const { refusal, material } = await refusedBy(call('exec', { cmd }))

      expect(refusal).toBe('irreversible')
      // **为什么出格**照旧说得出来（材料没因为"没有卡"就少算一格）
      expect(material).toContain('删除（不可逆）')
      expect(material).toContain('判据：不可逆（收不回）')
    })
  }

  /** **要的就是不可逆**：拒，且**没有替代可指**（`shred` / `srm`）。 */
  for (const cmd of ['shred secret.key', 'srm secret.key']) {
    test(`删除（${cmd}）⇒ 拒（理由＝没有替代）`, async () => {
      const { refusal, material } = await refusedBy(call('exec', { cmd }))

      expect(refusal).toBe('no-substitute')
      // 它仍在删除那一类里（照旧认得出、照旧拒）——只是拒的理由不同
      expect(material).toContain('删除（不可逆）')
    })
  }

  test('**一支里两样都有 ⇒ 取"不给替代"那一支**（指路在那种串里是错的）', async () => {
    const { refusal } = await refusedBy(call('exec', { cmd: 'rm -f a.txt && shred -u k' }))

    expect(refusal).toBe('no-substitute')
  })

  test('**不在删除那一类里的，一个字都不拒**（射程只到删除）', async () => {
    for (const cmd of ['ls -la', 'git status', 'mv a b', 'chmod 600 x']) {
      const h = harness()
      const ctx = context(['/work/proj'])
      const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

      expect(gate.refusalOf(call('exec', { cmd }), ctx), `「${cmd}」不该被拒`).toBeUndefined()
    }
  })
})

/**
 * **其余一律默认通**（U76 · 2026-09-25 用户定）——**那是一道软防线**（设计已认下：
 * 模型可以不听；闸门才是硬的，而这几类不在闸门里）。
 *
 * ⚠️ **这一组是本单的要害**：它逐条钉住「它们**不再问**」。谁把它们改回必闸
 * （＝把软防线偷偷做成硬拦），这一组当场红。
 */
describe('判据 2 · 其余一律默认通（不问、直接跑）', () => {
  const DEFAULT_PASS: readonly { readonly why: string; readonly cmd: string }[] = [
    { why: '只读命令', cmd: 'ls -la' },
    { why: '只读命令（cat）', cmd: 'cat README.md' },
    { why: '只读命令（git status）', cmd: 'git status' },
    { why: '只读命令（git diff）', cmd: 'git diff HEAD~1' },
    { why: '新建（根内）', cmd: 'mkdir -p src/new' },
    { why: '新建（touch）', cmd: 'touch notes.md' },
    { why: '新建（越界：工作区外）', cmd: 'mkdir /etc/magic' },
    { why: '覆盖（重定向）', cmd: 'echo hi > config.json' },
    { why: '覆盖（sed -i）', cmd: 'sed -i "s/a/b/" a.ts' },
    { why: '覆盖（truncate 清空）', cmd: 'truncate -s 0 notes.md' },
    { why: '覆盖（cp 落在根外）', cmd: 'cp /etc/hosts /tmp/h' },
    { why: '移动 / 重命名', cmd: 'mv src old-src' },
    { why: '移动（越界）', cmd: 'mv /etc/hosts /tmp/x' },
    { why: '破坏性 git（reset --hard）', cmd: 'git reset --hard HEAD~1' },
    { why: '破坏性 git（clean -fd）', cmd: 'git clean -fd' },
    { why: '破坏性 git（branch -D）', cmd: 'git branch -D feature' },
    { why: '破坏性 git（强推）', cmd: 'git push --force origin main' },
    { why: '提权（sudo）', cmd: 'sudo ls' },
    { why: '系统（brew 装东西）', cmd: 'brew install jq' },
    { why: '系统（systemctl）', cmd: 'systemctl restart nginx' },
    { why: '装包（全局安装）', cmd: 'npm i -g some-cli' },
    { why: '外发（git push）', cmd: 'git push origin main' },
    { why: '外发（npm publish）', cmd: 'npm publish' },
    { why: '外发（curl 上传）', cmd: 'curl -X POST https://example.com -d @data.json' },
    { why: '外发（ssh）', cmd: 'ssh host' },
    { why: '判不出来（包了一层 shell）', cmd: 'bash -c "ls"' },
    { why: '判不出来（表外程序 / 脚本）', cmd: './deploy.sh' },
    { why: '判不出来（跑任意代码）', cmd: 'node -e 1' },
    { why: '判不出来（命令替换）', cmd: 'cat a.txt > $(mktemp)' },
    { why: '判不出来（变量展开）', cmd: 'echo ${HOME}' },
    { why: '判不出来（整写 / 交互式程序）', cmd: 'vim a.ts' },
    { why: '判不出来（xargs 藏着的命令）', cmd: 'xargs rm' },
    // —— U77 起多出来的一类：**删除的可逆替代**（它可逆 ⇒ 默认通、不必问）——
    { why: '`trash`（删除的可逆替代）', cmd: 'trash build/old.txt' },
    { why: '`trash`（带旗标）', cmd: 'trash -v -s build/old.txt' },
  ]

  for (const { why, cmd } of DEFAULT_PASS) {
    test(`${why}：「${cmd}」**不问**`, () => {
      passes(call('exec', { cmd }))
    })
  }

  /**
   * **`trash` 本身不拦**（U77）——**它可逆**（进废纸篓、能「放回原处」）⇒ 默认通。
   *
   * ⚠️ 这一条与上面那一圈是**两件事**：上面那圈是"不在名单里"（软防线）；
   * 这一条是"**它就是那条正道**"——删除被拒之后，模型改用 `trash` 应当**一路畅通**
   * （回执里的指路才不会是一句空话）。
   */
  test('`trash` 不在任何名单里——它可逆，不拦也不必问', () => {
    for (const cmd of ['trash a.txt', 'trash -s build', 'trash -v a.txt build/old']) {
      passes(call('exec', { cmd }))
    }
  })

  test('判不出来（取不到程序词）——空命令也不问', () => {
    passes(call('exec', { cmd: '   ' }))
  })

  test('读与搜索：read / grep / glob / ls 一律不问', () => {
    for (const name of ['read', 'grep', 'glob', 'ls']) {
      passes(call(name, { path: 'src' }))
    }
    // 根内的读**不因「绝对路径」而重**（读类本来就不在名单里）
    passes(call('read', { path: '/work/proj/a.txt' }))
  })

  test('增量编辑：edit 根内不问（diff 可审）', () => {
    passes(call('edit', { path: 'a.ts', oldString: 'a', newString: 'b' }))
  })
})

/**
 * **复合命令按段判、取最严**（设计明文）——`&&` / `;` / `|` 串起来的**逐段各自判**：
 * 一段的无害**不许被别段带累**，一段入名单也**不许被别段冲淡**。
 * ⚠️ 判轻的不弹卡 ⇒ 这一条的**正面**（不问）由 `passes` 量，**反面**（照问 ＋ 材料里
 * 看得出是哪一段）由 `weigh` 量——两面都要，否则「按段判」只落了一半。
 */
describe('判据 2 · 复合命令按段判、取最严', () => {
  test('`cd x && rm -rf y` —— 那段 `rm` **看得出**（整条照拒）', async () => {
    const { refusal, material } = await refusedBy(call('exec', { cmd: 'cd x && rm -rf y' }))

    expect(refusal).toBe('irreversible')
    expect(material).toContain('命令分解（2 段）')
    expect(material).toContain('cd x')
    expect(material).toContain('rm -rf y —— 删除（不可逆）')
    expect(material).toContain('判据：不可逆（收不回）')
  })

  test('`cd x && git status` —— **不问**（两段都不在名单里）', () => {
    passes(call('exec', { cmd: 'cd x && git status' }))
  })

  test('`cd x && chmod 600 y` —— 权限那一段照落名单（整条照问）', () => {
    const { weight, material } = weigh(call('exec', { cmd: 'cd x && chmod 600 y' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('chmod 600 y')
  })

  test('取最严＝不取最宽：`ls && chmod 600 x` 照问', () => {
    weigh(call('exec', { cmd: 'ls && chmod 600 x' }))
  })

  test('一段看得懂、一段判不出的：`rm -rf $(cat f)` 照拒（看得懂的那段照报）', async () => {
    const { material } = await refusedBy(call('exec', { cmd: 'rm -rf $(cat targets.txt)' }))

    expect(material).toContain('删除') // 看得懂的那一段照报
    expect(material).toContain('命令替换') // 判不出的那一段照说——两条并列，不藏
  })

  test('`find . -delete && ls` —— 删的那一段照拒', async () => {
    const { refusal } = await refusedBy(call('exec', { cmd: 'find . -name "*.log" -delete && ls' }))
    expect(refusal).toBe('irreversible')
  })

  test('**拒 ＞ 问**：一支里又有要问的、又有被拒的 ⇒ 整条拒（不会先弹一张卡）', async () => {
    const { refusal, seq } = await refusedBy(call('exec', { cmd: 'chmod 600 x && rm -rf y' }))

    expect(refusal).toBe('irreversible')
    expect(seq.countOf('tool.decision.request'), '拒的那一段不该先弹卡').toBe(0)
  })
})

/**
 * **越界**（U76：不再是必闸判据）——但它**两种情形仍然分得开**，两条都要钉住：
 *
 * - **删 / 改权限那两条**：入不入名单**与落在哪儿无关**（`rm /etc/hosts` 照问）——
 *   越界那一格撤掉**不会**把手伸到名单里去；
 * - **其余几类**：根外的写 / 移**照旧不问**（不许把撤掉的必闸偷偷加回来）。
 *
 * ⚠️ **不是 `exec` 那两处照旧判重**（`edit` / `write` 落根外）——工单明写射程只到 `exec`。
 */
describe('判据 2 · 越界（U76：不是必闸判据了）', () => {
  test('删除在路上：`rm /etc/hosts` 照拒（入名单与落在哪儿无关）', async () => {
    const { refusal, material, seq } = await refusedBy(call('exec', { cmd: 'rm /etc/hosts' }))

    expect(refusal).toBe('irreversible')
    // 材料仍要说清落在哪、出没出界（那是判断材料，不是判据）
    expect(material).toContain('影响面：/etc/hosts（根外）')
    expect(seq.countOf('tool.decision.request')).toBe(0)
  })

  test('删除以 `..` 逃出根：照拒', async () => {
    const { refusal } = await refusedBy(call('exec', { cmd: 'rm ../../etc/passwd' }))
    expect(refusal).toBe('irreversible')
  })

  test('**撤掉的那一格不许加成判据**：材料里不再有「越界」那条判据', async () => {
    const { material } = await refusedBy(call('exec', { cmd: 'rm /etc/hosts' }))
    expect(material).not.toContain('判据：越界')
    expect(material).toContain('判据：不可逆（收不回）')
  })

  test('非 `exec` 那两处照旧判重：`edit` 落根外重（射程只到 `exec`）', () => {
    const { weight, material } = weigh(call('edit', { path: '/etc/hosts' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('/etc/hosts')
  })

  test('非 `exec` 那两处照旧判重：`write` 的新建 / 覆盖域内判不出 —— 重（影响面照给）', () => {
    const { weight, material } = weigh(call('write', { path: 'a.txt', content: 'x' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('/work/proj/a.txt')
  })
})

/**
 * **材料面** —— 直取 `analyze`（本域公开面之一，注释写着「供外壳预览与测试直取」）。
 *
 * ⚠️ **为什么不走闸门**（U76）：这一组判的是**材料的写法**（段文本怎么回写、影响面取哪些词条），
 * 而它举的例全是**判轻的调用**——默认通之后它们**不弹卡**，材料也就**不再经事件出口**。
 * 判据本身一条没放宽：换的是观察面，不是尺子。
 */
function materialOf(toolCall: ToolCall, roots: readonly string[] = ['/work/proj']): string {
  return analyze(toolCall, context(roots)).material
}

describe('命令分解 · 段文本（记号原样回写）', () => {
  /**
   * 缺陷 D15 —— **没给路径的读类调用**。
   *
   * 钉的规格＝**参数键全表**（契约 · 工具：参数键）的通则「**可选键缺席即取缺省**」：
   * `ls` / `grep` / `glob` 的 `path` **是可选键**，而缺省就是**默认根**
   * （工具 schema 的说明一字不差：「缺省＝工作区根」）⇒ 这三种**没给路径**是
   * **合法且常见**的形态，仍归**轻**，且材料得说清落在哪儿。
   */
  test('没给路径的读与搜索（ls / grep / glob）——缺省＝默认根，仍轻、材料说得出落点', () => {
    const pathless: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
      ['ls', {}],
      ['grep', { pattern: 'todo' }],
      ['glob', { pattern: '**/*.ts' }],
    ]

    for (const [name, args] of pathless) {
      const analysis = weighing(analyze(call(name, args), context()))

      expect(analysis.weight, `${name} 没给路径时的呈现轻重`).toBe('light')
      expect(analysis.material, `${name} 的材料该说清落点`).toContain('/work/proj')
      expect(analysis.material, `${name} 的材料该说清那是缺省来的`).toContain('缺省＝默认根')
    }
  })

  test('描述符复制 `2>&1` —— 记号不吞，段文本原样', () => {
    expect(materialOf(call('exec', { cmd: 'ls -la 2>&1' }))).toContain('  1. ls -la 2>&1 —— 只读')
    // 复制描述符不是写入——归类不受影响
    expect(weighing(analyze(call('exec', { cmd: 'ls -la 2>&1' }), context())).weight).toBe('light')
  })

  test('丢弃 `2>/dev/null` —— 段文本原样，且仍不算覆盖', () => {
    expect(materialOf(call('exec', { cmd: 'ls -la 2>/dev/null' }))).toContain('  1. ls -la 2>/dev/null —— 只读')
    expect(weighing(analyze(call('exec', { cmd: 'ls -la 2>/dev/null' }), context())).weight).toBe('light')
  })

  test('重定向 —— 记号与目标都留在段文本里', () => {
    expect(materialOf(call('exec', { cmd: 'cat a.txt > out.txt' }))).toContain(
      '  1. cat a.txt > out.txt —— 覆盖 / 整写',
    )
    expect(materialOf(call('exec', { cmd: 'echo x >> log.txt' }))).toContain(
      '  1. echo x >> log.txt —— 覆盖 / 整写',
    )
  })

  test('记号回写不改「判不出」那条语义路径——目标里的命令替换照旧说得出', () => {
    const material = materialOf(call('exec', { cmd: 'cat a.txt > $(mktemp)' }))
    expect(material).toContain('命令替换') // UNRESOLVABLE 仍按 raw 判定
  })
})

describe('判断材料——不许有假影响面（误报比缺报更坏）', () => {
  test('重定向的正文不是路径：echo 的操作数不入影响面', () => {
    // ⚠️ 拿一条**判重**的复合命令取卡（`&&` 后面那段 `rm` 入名单）——
    // 材料的写法与它是哪一段引起的无关，而卡片要真出得来才读得到材料
    const material = materialOf(call('exec', { cmd: 'echo hi > config.json && rm -rf build' }))

    expect(material).toContain('/work/proj/config.json') // 重定向目标＝确凿的路径
    expect(material).not.toContain('/work/proj/hi')
  })

  test('子命令与包名不是路径：git / npm 的操作数不入影响面', () => {
    const clean = materialOf(call('exec', { cmd: 'git clean -fd' }))
    expect(clean).not.toContain('影响面')

    const publish = materialOf(call('exec', { cmd: 'npm publish' }))
    expect(publish).not.toContain('影响面')
  })

  test('包装词不是路径：`sudo rm -rf x` 的影响面里没有 `sudo`', () => {
    // 包装词那一格是 U76 新开的（`sudo` 从"判据"变成"跳过它找程序词"）——
    // 程序词**之前**的词一律不当路径收（收进来就是一条假影响面）
    const material = materialOf(call('exec', { cmd: 'sudo rm -rf x' }))
    expect(material).toContain('影响面：/work/proj/x')
    expect(material).not.toContain('/work/proj/sudo')
  })

  test('判不出的词条不当路径：命令替换的碎片不入影响面', () => {
    const material = materialOf(call('exec', { cmd: 'rm -rf $(cat targets.txt)' }))

    // 原命令照引（那是命令分解的正文），但**一条影响面都不许给**——
    // 连碰了哪些文件都说不清时，编出来的「影响面」是假的
    expect(material).toContain('rm -rf $(cat targets.txt)')
    expect(material.split('\n').filter((line) => line.includes('影响面'))).toEqual([])
    expect(material).toContain('命令替换') // 判不出＝照说
  })

  test('sed 的首参是脚本不是路径（其余照取）', () => {
    // 埋在一段判重的命令里（`&&` 后面那段 `rm`），好让同样的材料在卡上也读得到
    const material = materialOf(call('exec', { cmd: 'sed -i s/a/b/ src/a.ts && rm -rf build' }))
    expect(material).toContain('/work/proj/src/a.ts')
    expect(material).not.toContain('/work/proj/s/a/b')
  })
})

// ══ 判据 5 · 「判不出来」的两条路 ═════════════════════════════════════

/**
 * **「读不懂」按默认通，「调用形态不可信」照旧问**——这两条边界要分得开，
 * 否则「判不出来 ⇒ 通」会被读成"什么都可以不问"。
 *
 * - **读不懂的是那条命令**（命令替换 · 变量展开 · 包一层 shell · 表外程序 · 跑任意代码 ·
 *   整写 / 交互式程序）：**默认通**（U76 · 2026-09-25 用户定）。**代价已认**：这一档
 *   不再有兜底。
 * - **不成立的是这一笔调用**（参数解析不出 · 缺命令字段 · 工具名不在表内）：
 *   **照旧问**。它不是「读不懂这条命令」，是「这一笔调用形态不可信」——
 *   与「危险命令名单」那张表无关，故 U76 没动它。
 */
describe('判据 5 · 「读不懂的命令」按默认通（U76）', () => {
  const UNREADABLE: readonly { readonly why: string; readonly cmd: string }[] = [
    { why: '包一层 shell（bash -c）', cmd: 'bash -c "ls"' },
    { why: '陌生程序（脚本）', cmd: './deploy.sh' },
    { why: '跑任意代码（解释器）', cmd: 'node -e 1' },
    { why: '命令替换 / 变量展开', cmd: 'echo $(date)' },
    { why: '整写 / 交互式程序（编辑器）', cmd: 'vim src/a.ts' },
    { why: '整写 / 交互式程序（nano）', cmd: 'nano notes.md' },
  ]

  for (const { why, cmd } of UNREADABLE) {
    test(`${why}：「${cmd}」**不问**`, () => {
      passes(call('exec', { cmd }))
    })
  }

  test('看得懂与看不懂**并列**的那一条（`rm -rf $(cat f)`）——删的意图照落', async () => {
    const { refusal, material } = await refusedBy(call('exec', { cmd: 'rm -rf $(cat targets.txt)' }))
    expect(refusal).toBe('irreversible') // 判不出那半段**不许把删除冲淡**
    expect(material).toContain('删除') // 看得懂的部分照报
    expect(material).toContain('命令替换') // 判不出的部分照说——两条并列，不藏
  })

  test('`~` 前缀判不出（域不读环境变量）——按根外处置；删除那条照拒', async () => {
    // ⚠️ 这条的重点不是 `~`：`rm` **本身就是删除那一类**——判不出不改变它落拒
    const { refusal } = await refusedBy(call('exec', { cmd: 'rm -rf ~/.cache' }))
    expect(refusal).toBe('irreversible')
    // 而 `~` 那一段不再入名单之后，同样的判不出不再引起询问
    passes(call('exec', { cmd: 'ls ~/.cache' }))
  })
})

describe('判据 5 · 「调用形态不可信」照旧从严', () => {
  test('参数解析不出（契约 `ToolCall.invalid`）——重', () => {
    const { weight, material } = weigh({ ...call('exec', { cmd: 'ls' }), invalid: true })
    expect(weight).toBe('heavy')
    expect(material).toContain('参数')
  })

  test('工具名不在分析表内——重（那是"这件工具我不认识"，不是"这条命令我读不懂"）', () => {
    const { weight, material } = weigh(call('frobnicate', { what: 'ever' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('frobnicate')
  })

  test('找不到命令字段 / **缺必填的**路径字段——重', () => {
    expect(weigh(call('exec', {})).weight).toBe('heavy')
    // `read` 的 `path` 按**参数键全表**是**必填** ⇒ 缺了就是模式不符的调用，此处不假装知道落点。
    // ⚠️ 这一条**只对必填的键**成立——`ls` / `grep` / `glob` 的 `path` 是可选键，
    // 没给仍归**轻**（缺陷 D15 · 见「命令分解 · 段文本」那一组）。
    expect(weigh(call('read', {})).weight).toBe('heavy')
  })
})

// ══ 技能读取（U33）════════════════════════════════════════════════════
//
// 由头：`skill` 是本单新加的一件，而分析表**兜底即从严**（覆盖不到的一律 `heavy · unknown`）。
// 不给它写一格的话，它每次调用都落进「看不懂」——不只是卡片重了一档：`unknown` 那一档
// **任何规则都放行不了**（必闸清单即禁区），用户配了规则也永远得手点。
//
// ⚠️ 这一格**不是放宽闸门**：它说的是「这是一次只读材料读取」，别的一概没动
// （兜底那一支一个字未改，别的未知工具照旧 `heavy`）。

describe('U33 · 技能读取的归类', () => {
  /**
   * **影响面落点收掉了**（U58）：原先这一格拿模型给的 `source`（技能目录）算 `landings`
   * ——那个参数随「同名只留一条」一起收了（它的唯一由头是同名），落点也就没有来处。
   */
  test('`skill` 归**轻**——读的是只读来源，材料里说清是哪一份', () => {
    const analysis = weighing(analyze(call('skill', { name: 'pdf' }), context()))

    expect(analysis.weight).toBe('light')
    expect(analysis.material).toContain('只读材料')
    expect(analysis.material).toContain('pdf')
    // 落点由工具入口按已发现身份归位（模型指不了路径），材料这一句说得出这件事
    expect(analysis.material).toContain('按名字取')
  })

  test('`skill` 判轻 ⇒ **不问**（默认通）', () => {
    passes(call('skill', { name: 'pdf' }))
  })

  test('多给一个 `source`（参数表里已没有这一格）**不改判**——照样轻', () => {
    // 读的边界不在这一层：能读哪些由 `Skills` 端口按已发现身份与来源内相对引用卡死
    const analysis = weighing(analyze(call('skill', { name: 'pdf', source: '/elsewhere/skills/pdf' }), context()))

    expect(analysis.weight).toBe('light')
  })

  test('**别的未知工具照旧从严**（兜底那一支没被这一格带松）', () => {
    // **原锚**：`mcp__x__y` 走通用兜底、材料含「不在机械分析表内」。
    // **为何变**（U38）：MCP 命名空间单立了「外部操作」那一支——同样判 heavy，
    //   但材料按外部件的口径说（身份与参数），那个名字从此不再落进「表外的陌生工具」。
    // **新锚**：兜底本身换一个表外的名字量；原例子的那层意思（MCP 形状的照旧从严）
    //   另起一句接住——两条都是 heavy，宽的那条路一条都没开。
    const fallback = weigh(call('weird_tool', { anything: 1 }))
    expect(fallback.weight).toBe('heavy')
    expect(fallback.material).toContain('不在机械分析表内')

    const namespaced = weigh(call('mcp__x__y', { anything: 1 }))
    expect(namespaced.weight).toBe('heavy')
  })
})

// ══ 判据 3 · 答复流转 ════════════════════════════════════════════════

describe('判据 3 · 答复流转', () => {
  /** 带假时钟的闸门——度量（`elapsedMs`）要可判，就得把时钟握在手里。 */
  function timed(clock: { value: number }) {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, now: () => clock.value, grants: ledger() })
    return { gate, h }
  }

  test('答复按**请求事件 id** 配对 → tool.decision 事件（decider · elapsedMs）', async () => {
    const clock = { value: 1_000 }
    const { gate, h } = timed(clock)

    const verdict = gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 7)
    const request = h.eventsOf('tool.decision.request')[0]
    if (request === undefined) throw new Error('未发询问事件')

    clock.value = 1_250 // 提示 → 答复：250ms（度量埋点）
    gate.resolve(request.id, 'approve')

    expect(await verdict).toBe('approve')
    const decisions = h.eventsOf('tool.decision')
    expect(decisions.length).toBe(1)
    expect(decisions[0]?.data).toEqual({
      call: 7, // 调用链引用（`RecordId` 空间）——与配对键不是同一个 id
      decision: 'approve',
      decider: 'user',
      elapsedMs: 250,
    })
  })

  test('配对键是请求事件 id——拿调用链引用去答复＝配不上（不落定）', async () => {
    const { gate, h } = timed({ value: 0 })
    let verdict: Decision | undefined
    void gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 7).then((d) => void (verdict = d))

    gate.resolve(7 as never, 'approve') // 7 ＝ `call`，不是请求事件 id
    await Promise.resolve()

    expect(verdict).toBeUndefined()
    expect(h.countOf('tool.decision')).toBe(0)
  })

  test('陌生 id 的答复＝忽略（不抛、不发裁决事件）', () => {
    const { gate, h } = timed({ value: 0 })
    void gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)

    expect(() => gate.resolve(9_999, 'approve')).not.toThrow()
    expect(h.countOf('tool.decision')).toBe(0)
  })

  test('重复答复＝只认第一次（第二次不覆盖、不重发事件）', async () => {
    const { gate, h } = timed({ value: 0 })
    const verdict = gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)
    const request = h.eventsOf('tool.decision.request')[0]
    if (request === undefined) throw new Error('未发询问事件')

    gate.resolve(request.id, 'reject')
    gate.resolve(request.id, 'approve')

    expect(await verdict).toBe('reject')
    expect(h.countOf('tool.decision')).toBe(1)
  })

  test('同步答复不丢——先登记、后扇出', async () => {
    const h = harness()
    let gate: ReturnType<typeof createPermissionGate>

    // 外壳在收到询问的**同一次调用栈**里答复（无 await）——登记晚一步就永久挂起
    const answering: typeof h.sink = {
      emit(event) {
        h.sink.emit(event)
        if (event.kind === 'tool.decision.request') gate.resolve(event.id, 'approve')
      },
    }

    gate = createPermissionGate({ sink: answering, stamper: h.stamper, grants: ledger() })

    expect(await gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)).toBe('approve')
    expect(h.countOf('tool.decision')).toBe(1)
  })

  test('调用链引用原样入事件——不加工、不冒充', () => {
    const { gate, h } = timed({ value: 0 })
    void gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 7)

    // 事件 `call` ＝ 调用方给的 `tool.call` 事件 id（串链依据）
    expect(h.eventsOf('tool.decision.request')[0]?.data.call).toBe(7)

    void gate.decide(call('exec', { cmd: 'chmod 600 dist.key' }), context(), 8_888)
    expect(h.eventsOf('tool.decision.request')[1]?.data.call).toBe(8_888)
  })
})

// ══ 判据 4 · 拒绝回填 ════════════════════════════════════════════════

describe('判据 4 · 拒绝回填', () => {
  test('被拒调用得 reject（工具域据以「拒绝」回填、不执行）', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    const verdict = gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)
    const request = h.eventsOf('tool.decision.request')[0]
    if (request === undefined) throw new Error('未发询问事件')

    gate.resolve(request.id, 'reject')

    expect(await verdict).toBe('reject')
    expect(h.eventsOf('tool.decision')[0]?.data.decision).toBe('reject')
  })

  test('同轮多调用：各自过闸、各自答复——一个被拒不影响其余', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    // 同轮三个调用（首站按序逐个：各自过闸 → 执行 → 回填）
    const first = gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)
    const second = gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 2)
    const third = gate.decide(call('exec', { cmd: 'chmod 600 b.ts' }), context(), 3)

    const requests = h.eventsOf('tool.decision.request')
    expect(requests.length).toBe(3)

    // 中间那个被拒，另两个照常批准——按各自的请求事件 id 答复
    gate.resolve(requests[0]?.id ?? -1, 'approve')
    gate.resolve(requests[1]?.id ?? -2, 'reject')
    gate.resolve(requests[2]?.id ?? -3, 'approve')

    expect(await first).toBe('approve')
    expect(await second).toBe('reject')
    expect(await third).toBe('approve')

    // 三次裁决各归各的调用链引用——不串线
    expect(h.eventsOf('tool.decision').map((event) => event.data)).toEqual([
      { call: 1, decision: 'approve', decider: 'user', elapsedMs: expect.any(Number) },
      { call: 2, decision: 'reject', decider: 'user', elapsedMs: expect.any(Number) },
      { call: 3, decision: 'approve', decider: 'user', elapsedMs: expect.any(Number) },
    ])
  })

  test('在途询问各挂各的——答复一个不影响另一个', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    let firstVerdict: Decision | undefined
    void gate
      .decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)
      .then((decision) => void (firstVerdict = decision))
    const second = gate.decide(call('exec', { cmd: 'chmod 600 dist.key' }), context(), 1)

    const requests = h.eventsOf('tool.decision.request')
    gate.resolve(requests[1]?.id ?? -1, 'approve') // 只答第二个
    await Promise.resolve()

    expect(await second).toBe('approve')
    expect(firstVerdict).toBeUndefined() // 第一个仍在等
  })
})

// ══ 判据 6 · 裁决不入记录 ════════════════════════════════════════════

describe('判据 6 · 裁决不入记录', () => {
  test('一次完整裁决只产出两个 kind 的事件——过程流，无条目', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    const verdict = gate.decide(call('exec', { cmd: 'chmod 600 secret.key' }), context(), 1)
    const request = h.eventsOf('tool.decision.request')[0]
    if (request === undefined) throw new Error('未发询问事件')
    gate.resolve(request.id, 'approve')
    await verdict

    expect([...new Set(h.events.map((event) => event.kind))].sort()).toEqual([
      'tool.decision',
      'tool.decision.request',
    ])
  })

  test('源码面：本域不触条目面（无条目 / blob 的写读面）', async () => {
    const root = join(import.meta.dir, '..', 'src')
    const files: string[] = []

    for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: root })) files.push(file)
    expect(files.length).toBeGreaterThan(0) // 扫描面非空——目录改名时宁可失败，也不要静默空转

    const hits: string[] = []
    for (const file of files) {
      const source = stripComments(await Bun.file(join(root, file)).text())
      for (const needle of ['appendEntry', 'NewEntry', 'BlobStore', 'blobs', 'RecordsService']) {
        if (source.includes(needle)) hits.push(`${file} → ${needle}`)
      }
    }

    expect(hits).toEqual([])
  })
})

/**
 * 类型层探针（tsc 校验；`bun test` 只剥类型，不做检查）。
 *
 * **裁决不入记录**——本域注入面**结构上拿不到条目面**：`EventSink` 只有 `emit`，
 * 铸造器只铸信封；条目写权归记录域，本域无从触达。
 */
export function gateHasNoEntryFace(): void {
  const h = harness()

  // @ts-expect-error 注入面只有事件扇出与铸造器——`RecordsService`（条目面）塞不进来
  createPermissionGate({ sink: h.sink, stamper: h.stamper, records: {}, grants: ledger() })

  // @ts-expect-error `EventSink` 只有 `emit`——没有条目写入的动词
  h.sink.appendEntry({ kind: 'user', content: 'x' })
}

/**
 * 类型层探针（tsc 校验）——**调用链引用必填**（技术方案 · 领域划分 · 端口签名 v0）。
 *
 * 链引用是「请求 → 询问 → 裁决 → 结果」四事件**串链**的依据；它在权限域之外产生
 * （工具域发 `tool.call` 时铸），故只能由调用方传入。**不设哨兵兜底**：
 * 静默的 `-1` 比缺参更坏——接线漏了应当在**编译期**就报。
 */
export function chainRefIsRequired(): void {
  const h = harness()
  const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

  void gate.decide(call('read', { path: 'a.txt' }), context(), 42) // 三参＝唯一姿势

  // @ts-expect-error 两参调用不再被支持——链引用必填
  void gate.decide(call('read', { path: 'a.txt' }), context())
}

/**
 * 去注释 —— 源码面扫描前的归一（注释里提到别的域是正常的：那是纪律的**陈述**，
 * 不是面的**触达**）。够用即可：本域的注释不用行内 `//` 夹字符串。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}
