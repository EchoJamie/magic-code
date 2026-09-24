/**
 * U07 · 权限域（闸门 · 人工版）测试 —— 验收：**工作分解 · 波次 1「验收判据 · U07」六条**。
 *
 * 逐条对应：
 * 1. 一律经人工门——每个调用都产生 `tool.decision.request`，批准才执行；
 * 2. 呈现轻重——必闸类 `heavy`（材料＝命令分解 / 影响面），其余 `light`；
 * 3. 答复流转——`decision.answer`（配对＝请求事件 id）→ `tool.decision`（`decider` · `elapsedMs`）；
 * 4. 拒绝回填——被拒调用得 `reject`（不执行）；同轮其余调用照常；
 * 5. 看不懂从严——无法归类的形态按不可逆假定（`heavy`）；
 * 6. 裁决不入记录——裁决过程只走事件、不入条目。
 *
 * 一切经**契约面**：注入 `EventSink` / `EventStamper`，读回事件与返回值——测试不碰域内部件。
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type {
  Decision,
  DecisionWeight,
  PermissionGate as PermissionGatePort,
  ToolCall,
} from '@magic/contracts'
import { createPermissionGate } from '../src/index.ts'
import { call, context, harness, ledger, type Harness } from './helpers.ts'

/**
 * 走一次闸门，只取**呈现轻重**与材料——本域的首要可观测面（询问事件的 `weight` / `material`）。
 * 不答复：用例只问「怎么问」，不问「答什么」。
 */
function weigh(
  toolCall: ToolCall,
  roots: readonly string[] = ['/work/proj'],
): { readonly weight: DecisionWeight; readonly material: string; readonly seq: Harness } {
  const h = harness()
  const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })
  void gate.decide(toolCall, context(roots), 1) // 链引用必填（本轮契约）

  const request = h.eventsOf('tool.decision.request')[0]
  if (request === undefined) throw new Error('未发询问事件')
  return { weight: request.data.weight, material: request.data.material, seq: h }
}

// ══ 参数键（技术方案 · 工具：参数键部分锚定）═════════════════════════

describe('参数键', () => {
  test('exec 的命令字段＝单一键 `cmd`——别的键名不再兜底（从严）', () => {
    expect(weigh(call('exec', { cmd: 'ls' })).weight).toBe('light')

    // 「已按候选键兜底者收窄为单一键」（技术方案 · 工具）——写错的键名不该被猜中
    expect(weigh(call('exec', { command: 'ls' })).weight).toBe('heavy')
    expect(weigh(call('exec', { script: 'ls' })).weight).toBe('heavy')
    expect(weigh(call('exec', { shell: 'ls' })).weight).toBe('heavy')
  })

  test('路径类工具的键名**仍是候选集**——其余工具键名随 U13 定（未定处不得依赖）', () => {
    expect(weigh(call('read', { path: 'src/a.ts' })).weight).toBe('light')
    expect(weigh(call('read', { filePath: 'src/a.ts' })).weight).toBe('light')
    expect(weigh(call('edit', { file_path: 'src/a.ts' })).weight).toBe('light')
    expect(weigh(call('ls', { dir: 'src' })).weight).toBe('light')
  })
})

// ══ 判据 1 · 一律经人工门 ════════════════════════════════════════════

describe('判据 1 · 一律经人工门', () => {
  test('每个工具调用都产生一条 tool.decision.request——轻类亦然', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    void gate.decide(call('read', { path: 'a.txt' }), context(), 1)

    const requests = h.eventsOf('tool.decision.request')
    expect(requests.length).toBe(1)
    expect(requests[0]?.data.name).toBe('read')
  })

  test('未答复＝不落定（批准才执行）', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    let verdict: Decision | undefined
    void gate
      .decide(call('read', { path: 'a.txt' }), context(), 1)
      .then((decision) => void (verdict = decision))

    await Promise.resolve()
    expect(verdict).toBeUndefined()
  })

  test('契约端口面：三参调用（消费者只认已冻的 `PermissionGate`）', async () => {
    const h = harness()
    // 按**契约端口**取用（工具域的姿势）：`callRef` ＝ 该次 `tool.call` 事件的 id
    const gate: PermissionGatePort = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    const verdict = gate.decide(call('exec', { cmd: 'rm -rf build' }), context(), 42)
    const request = h.eventsOf('tool.decision.request')[0]
    if (request === undefined) throw new Error('未发询问事件')

    gate.resolve(request.id, 'approve')

    expect(await verdict).toBe('approve')
    expect(request.data.weight).toBe('heavy')
    expect(request.data.call).toBe(42)
  })
})

// ══ 判据 2 · 呈现轻重 ════════════════════════════════════════════════

describe('判据 2 · 呈现轻重（轻——放行区方向）', () => {
  test('读与搜索：read / grep / glob / ls 一律轻', () => {
    for (const name of ['read', 'grep', 'glob', 'ls']) {
      const { weight } = weigh(call(name, { path: 'src' }))
      expect(weight, `${name} 的呈现轻重`).toBe('light')
    }
  })

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
      const { weight, material } = weigh(call(name, args))

      expect(weight, `${name} 没给路径时的呈现轻重`).toBe('light')
      expect(material, `${name} 的材料该说清落点`).toContain('/work/proj')
      expect(material, `${name} 的材料该说清那是缺省来的`).toContain('缺省＝默认根')
    }
  })

  test('增量编辑：edit 轻（diff 可审）', () => {
    const { weight } = weigh(call('edit', { path: 'a.ts', oldString: 'a', newString: 'b' }))
    expect(weight).toBe('light')
  })

  test('新建：mkdir / touch 轻（放行区方向）；工作区外则重', () => {
    expect(weigh(call('exec', { cmd: 'mkdir -p src/new' })).weight).toBe('light')
    expect(weigh(call('exec', { cmd: 'touch notes.md' })).weight).toBe('light')
    expect(weigh(call('exec', { cmd: 'mkdir /etc/magic' })).weight).toBe('heavy') // 工作区外的写
  })

  test('只读命令：ls / cat / git status 轻', () => {
    for (const cmd of ['ls -la', 'cat README.md', 'git status', 'git diff HEAD~1', 'grep -rn todo .']) {
      const { weight } = weigh(call('exec', { cmd }))
      expect(weight, `命令「${cmd}」的呈现轻重`).toBe('light')
    }
  })
})

describe('判据 2 · 呈现轻重（重——必闸清单 v0）', () => {
  /** 必闸类 —— 逐条对表（技术方案 · 权限：危险分级 v0 必闸清单）。 */
  const GATED: readonly { readonly why: string; readonly cmd: string }[] = [
    { why: '删除', cmd: 'rm -rf build' },
    { why: '删除（find -delete）', cmd: 'find . -name "*.log" -delete' },
    { why: '覆盖（重定向）', cmd: 'echo hi > config.json' },
    { why: '覆盖（sed -i）', cmd: 'sed -i "s/a/b/" a.ts' },
    { why: '移动 / 重命名', cmd: 'mv src old-src' },
    { why: '破坏性 git（reset --hard）', cmd: 'git reset --hard HEAD~1' },
    { why: '破坏性 git（clean -fd）', cmd: 'git clean -fd' },
    { why: '破坏性 git（branch -D）', cmd: 'git branch -D feature' },
    { why: '提权（sudo）', cmd: 'sudo rm -rf /tmp/x' },
    { why: '系统（chmod）', cmd: 'chmod 777 secret.key' },
    { why: '外发（git push）', cmd: 'git push origin main' },
    { why: '外发（npm publish）', cmd: 'npm publish' },
    { why: '外发（curl 上传）', cmd: 'curl -X POST https://example.com -d @data.json' },
  ]

  for (const { why, cmd } of GATED) {
    test(`${why}：「${cmd}」重`, () => {
      const { weight, material } = weigh(call('exec', { cmd }))
      expect(weight).toBe('heavy')
      // 重呈现要给足判断材料：命令分解（技术方案 · 权限：呈现——diff / 命令分解 / 影响面）
      expect(material).toContain('命令分解')
      expect(material).toContain(cmd.split(' ')[0] ?? '')
    })
  }

  test('越界：工作区外的写 / 删 / 移重（绝对路径落根外）', () => {
    const { weight, material, seq } = weigh(call('exec', { cmd: 'rm /etc/hosts' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('越界')
    expect(material).toContain('影响面：/etc/hosts（根外）') // 重呈现给足依据：落在哪、出没出界
    expect(seq.countOf('tool.decision.request')).toBe(1)
  })

  test('越界：相对路径以 `..` 逃出根重', () => {
    const { weight } = weigh(call('exec', { cmd: 'rm ../../etc/passwd' }))
    expect(weight).toBe('heavy')
  })

  test('越界：工作区外的写（edit 落根外）重——增量编辑的「轻」以根内为限', () => {
    const { weight, material } = weigh(call('edit', { path: '/etc/hosts' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('/etc/hosts')
  })

  test('覆盖：write 的新建 / 覆盖域内判不出 —— 重（影响面照给）', () => {
    const { weight, material } = weigh(call('write', { path: 'a.txt', content: 'x' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('/work/proj/a.txt')
  })

  test('一段命令命中多条判据——材料并列（push --force：外发 ＋ 不可逆）', () => {
    const { weight, material } = weigh(call('exec', { cmd: 'git push --force origin main' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('外发')
    expect(material).toContain('不可逆')
  })

  test('轻类重呈现的边界：根内的读不因「绝对路径」而重', () => {
    const { weight } = weigh(call('read', { path: '/work/proj/a.txt' }))
    expect(weight).toBe('light')
  })
})

describe('命令分解 · 段文本（记号原样回写）', () => {
  test('描述符复制 `2>&1` —— 记号不吞，段文本原样', () => {
    const { weight, material } = weigh(call('exec', { cmd: 'ls -la 2>&1' }))

    expect(material).toContain('  1. ls -la 2>&1 —— 只读')
    expect(weight).toBe('light') // 复制描述符不是写入——归类不受影响
  })

  test('丢弃 `2>/dev/null` —— 段文本原样，且仍不算覆盖', () => {
    const { weight, material } = weigh(call('exec', { cmd: 'ls -la 2>/dev/null' }))

    expect(material).toContain('  1. ls -la 2>/dev/null —— 只读')
    expect(weight).toBe('light')
  })

  test('重定向 —— 记号与目标都留在段文本里', () => {
    const out = weigh(call('exec', { cmd: 'cat a.txt > out.txt' }))
    expect(out.material).toContain('  1. cat a.txt > out.txt —— 覆盖 / 整写（不可逆）')

    const append = weigh(call('exec', { cmd: 'echo x >> log.txt' }))
    expect(append.material).toContain('  1. echo x >> log.txt —— 覆盖 / 整写（不可逆）')
  })

  test('记号回写不改「判不出」那条语义路径——目标里的命令替换照旧入单', () => {
    const { weight, material } = weigh(call('exec', { cmd: 'cat a.txt > $(mktemp)' }))

    expect(weight).toBe('heavy')
    expect(material).toContain('命令替换') // UNRESOLVABLE 仍按 raw 判定
  })
})

describe('判断材料——不许有假影响面（误报比缺报更坏）', () => {
  test('重定向的正文不是路径：echo 的操作数不入影响面', () => {
    const { material } = weigh(call('exec', { cmd: 'echo hi > config.json' }))
    expect(material).toContain('/work/proj/config.json') // 重定向目标＝确凿的路径
    expect(material).not.toContain('/work/proj/hi')
  })

  test('子命令与包名不是路径：git / npm 的操作数不入影响面', () => {
    const clean = weigh(call('exec', { cmd: 'git clean -fd' }))
    expect(clean.material).toContain('删除')
    expect(clean.material).not.toContain('影响面')

    const publish = weigh(call('exec', { cmd: 'npm publish' }))
    expect(publish.material).not.toContain('影响面')
  })

  test('判不出的词条不当路径：命令替换的碎片不入影响面', () => {
    const { material } = weigh(call('exec', { cmd: 'rm -rf $(cat targets.txt)' }))

    // 原命令照引（那是命令分解的正文），但**一条影响面都不许给**——
    // 连碰了哪些文件都说不清时，编出来的「影响面」是假的
    expect(material).toContain('rm -rf $(cat targets.txt)')
    expect(material.split('\n').filter((line) => line.includes('影响面'))).toEqual([])
    expect(material).toContain('命令替换') // 判不出＝照说
  })

  test('sed 的首参是脚本不是路径（其余照取）', () => {
    const { material } = weigh(call('exec', { cmd: 'sed -i s/a/b/ src/a.ts' }))
    expect(material).toContain('/work/proj/src/a.ts')
    expect(material).not.toContain('/work/proj/s/a/b')
  })
})

// ══ 判据 5 · 看不懂从严 ══════════════════════════════════════════════

describe('判据 5 · 看不懂从严（按不可逆假定问）', () => {
  test('参数解析不出（契约 `ToolCall.invalid`）——重', () => {
    const { weight, material } = weigh({ ...call('rm'), invalid: true })
    expect(weight).toBe('heavy')
    expect(material).toContain('参数')
  })

  test('工具名不在分析表内——重', () => {
    const { weight, material } = weigh(call('frobnicate', { what: 'ever' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('frobnicate')
  })

  test('包一层 shell（bash -c）——内层判不出，重', () => {
    const { weight } = weigh(call('exec', { cmd: 'bash -c "ls"' }))
    expect(weight).toBe('heavy')
  })

  test('陌生程序（脚本）——重', () => {
    const { weight } = weigh(call('exec', { cmd: './deploy.sh' }))
    expect(weight).toBe('heavy')
  })

  test('命令替换 / 变量展开——实际执行判不出，重（删的意图仍入单）', () => {
    const { weight, material } = weigh(call('exec', { cmd: 'rm -rf $(cat targets.txt)' }))
    expect(weight).toBe('heavy')
    expect(material).toContain('删除') // 看得懂的部分照报
    expect(material).toContain('命令替换') // 判不出的部分照说——两条并列，不藏
  })

  test('整写 / 交互式程序（编辑器）——新建还是覆盖判不出，重', () => {
    // 与 `write` 同一处域内盲区：不碰文件系统就问不到存在性
    expect(weigh(call('exec', { cmd: 'vim src/a.ts' })).weight).toBe('heavy')
    expect(weigh(call('exec', { cmd: 'nano notes.md' })).weight).toBe('heavy')
  })

  test('找不到命令字段 / **缺必填的**路径字段——重', () => {
    expect(weigh(call('exec', {})).weight).toBe('heavy')
    // `read` 的 `path` 按**参数键全表**是**必填** ⇒ 缺了就是模式不符的调用，此处不假装知道落点。
    // ⚠️ 这一条**只对必填的键**成立——`ls` / `grep` / `glob` 的 `path` 是可选键，
    // 没给仍归**轻**（缺陷 D15 · 见「判据 2」那一条）。
    expect(weigh(call('read', {})).weight).toBe('heavy')
  })

  test('`~` 前缀判不出（域不读环境变量）——按根外处置，重', () => {
    const { weight } = weigh(call('exec', { cmd: 'rm -rf ~/.cache' }))
    expect(weight).toBe('heavy')
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
    const { weight, material } = weigh(call('skill', { name: 'pdf' }))

    expect(weight).toBe('light')
    expect(material).toContain('只读材料')
    expect(material).toContain('pdf')
    // 落点由工具入口按已发现身份归位（模型指不了路径），材料这一句说得出这件事
    expect(material).toContain('按名字取')
  })

  test('多给一个 `source`（参数表里已没有这一格）**不改判**——照样轻', () => {
    // 读的边界不在这一层：能读哪些由 `Skills` 端口按已发现身份与来源内相对引用卡死
    const { weight } = weigh(call('skill', { name: 'pdf', source: '/elsewhere/skills/pdf' }))

    expect(weight).toBe('light')
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

    const verdict = gate.decide(call('read', { path: 'a.txt' }), context(), 7)
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
    void gate.decide(call('read', { path: 'a.txt' }), context(), 7).then((d) => void (verdict = d))

    gate.resolve(7 as never, 'approve') // 7 ＝ `call`，不是请求事件 id
    await Promise.resolve()

    expect(verdict).toBeUndefined()
    expect(h.countOf('tool.decision')).toBe(0)
  })

  test('陌生 id 的答复＝忽略（不抛、不发裁决事件）', () => {
    const { gate, h } = timed({ value: 0 })
    void gate.decide(call('read', { path: 'a.txt' }), context(), 1)

    expect(() => gate.resolve(9_999, 'approve')).not.toThrow()
    expect(h.countOf('tool.decision')).toBe(0)
  })

  test('重复答复＝只认第一次（第二次不覆盖、不重发事件）', async () => {
    const { gate, h } = timed({ value: 0 })
    const verdict = gate.decide(call('read', { path: 'a.txt' }), context(), 1)
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

    expect(await gate.decide(call('read', { path: 'a.txt' }), context(), 1)).toBe('approve')
    expect(h.countOf('tool.decision')).toBe(1)
  })

  test('调用链引用原样入事件——不加工、不冒充', () => {
    const { gate, h } = timed({ value: 0 })
    void gate.decide(call('read', { path: 'a.txt' }), context(), 7)

    // 事件 `call` ＝ 调用方给的 `tool.call` 事件 id（串链依据）
    expect(h.eventsOf('tool.decision.request')[0]?.data.call).toBe(7)

    void gate.decide(call('read', { path: 'b.txt' }), context(), 8_888)
    expect(h.eventsOf('tool.decision.request')[1]?.data.call).toBe(8_888)
  })
})

// ══ 判据 4 · 拒绝回填 ════════════════════════════════════════════════

describe('判据 4 · 拒绝回填', () => {
  test('被拒调用得 reject（工具域据以「拒绝」回填、不执行）', async () => {
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })

    const verdict = gate.decide(call('exec', { cmd: 'rm -rf build' }), context(), 1)
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
    const first = gate.decide(call('read', { path: 'a.txt' }), context(), 1)
    const second = gate.decide(call('exec', { cmd: 'rm -rf build' }), context(), 2)
    const third = gate.decide(call('edit', { path: 'b.ts' }), context(), 3)

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
      .decide(call('read', { path: 'a.txt' }), context(), 1)
      .then((decision) => void (firstVerdict = decision))
    const second = gate.decide(call('read', { path: 'b.txt' }), context(), 1)

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

    const verdict = gate.decide(call('read', { path: 'a.txt' }), context(), 1)
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
