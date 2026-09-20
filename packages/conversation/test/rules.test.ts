/**
 * U32 · 规约的送达 —— 判据：**副作用之前送到 · 相同版本不循环拦 · 重审后只执行一次**。
 *
 * 本文件咬**对话域这一半**：什么时候送、拦在哪儿、拦完怎么接上。上游（从盘上读得到什么）
 * 归执行域，判据在 `packages/execution/test/rules.test.ts`；真装配那一跳在
 * `packages/app/test/rules.test.ts`。
 *
 * 判定法：`ProjectRules` 用**桩**（本域只认端口，读盘不是它的事），看的是三样——
 * ① **模型真收到的那份请求**（`gateway.requests[i].messages` 的首条系统消息）；
 * ② **工具的副作用**（桩处理器记下「真被写了哪几个文件」——不是「模型请求了哪几个」）；
 * ③ **落账的条目**（配对闭没闭合、规约有没有混进历史）。
 */

import { describe, expect, test } from 'bun:test'
import type {
  Entry,
  ProjectRule,
  ProjectRules,
  RulesLoad,
  RulesProblem,
  ToolCall,
  ToolSpec,
} from '@magic/contracts'
import { agentLoop } from '../src/agent-loop.ts'
import type { LoopRuntime } from '../src/agent-loop.ts'
import {
  PROJECT_RULES_BLOCK_ID,
  PROJECT_RULES_HEADING,
  buildSystemPrompt,
  renderProjectRulesBlock,
  splitSystemPrompt,
  withProjectRules,
} from '../src/prompt/index.ts'
import type { PromptVars } from '../src/prompt/index.ts'
import { MAX_SCOPE_TARGETS, createRulesDelivery, needsReviewText } from '../src/rules.ts'
import { makeLoopRuntime, makeStage } from './support/harness.ts'
import type { Stage } from './support/harness.ts'

// —— 夹具 ——

const PROMPT: PromptVars = { cwd: '/w', platform: 'darwin', date: '2026-09-18' }

/** 写文件工具——受约束的那个目标就是它的 `path`。 */
const WRITE_SPEC: ToolSpec = {
  name: 'write',
  summary: '新建 / 整写文件',
  parameters: {},
  danger: { level: 'by-call', note: '新建＝轻；覆盖＝必闸' },
}

/** 一条规约文档——只填断言要看的字段。 */
function doc(
  name: string,
  text: string,
  version = `v-${name}`,
  root: string | null = '/w',
  paths: readonly string[] = [],
): ProjectRule {
  return {
    kind: 'magic-rules',
    path: root === null ? name : `${root}/${name}`,
    root,
    scope: root,
    paths,
    name,
    text,
    version,
  }
}

function load(
  documents: readonly ProjectRule[],
  problems: readonly RulesProblem[] = [],
  truncated = false,
): RulesLoad {
  return { documents, problems, truncated }
}

/** 规约来源桩——本域只认端口；「从哪儿读出来这些」不是它的事。 */
function stubRules(answer: (targets: readonly string[]) => RulesLoad): ProjectRules {
  return { load: answer }
}

/**
 * 一束接线：写过的路径记在 `written` 里（**副作用**的观察面）。
 * `onWrite` 给「跑动中途改了点什么」用（如改规约——验证「新输入读取修改后的规则」）。
 */
function stageWith(
  answer: (targets: readonly string[]) => RulesLoad,
  turns: readonly unknown[],
  onWrite?: (path: string, index: number) => void,
) {
  const written: string[] = []

  const stage = makeStage({
    turns: turns as never,
    definitions: [WRITE_SPEC],
    handlers: {
      write: (call) => {
        const path = String(call.args['path'])
        written.push(path)
        onWrite?.(path, written.length - 1)
        return { ok: true, output: `写了 ${path}` }
      },
    },
  })

  const runtime = makeLoopRuntime(stage, {
    rules: createRulesDelivery(stubRules(answer)),
  })

  return { stage, runtime, written }
}

/** 第 n 次模型请求里那条系统消息。 */
function systemOf(stage: Stage, index: number): string {
  const message = stage.gateway.requests[index]?.messages[0]
  return message?.role === 'system' ? message.content : ''
}

/** 条目 kind 序列——配对闭没闭合看它。 */
function kindsOf(stage: Stage): readonly string[] {
  return stage.records.entries.map((entry) => entry.kind)
}

/** 跑一个交代——不给信号（用例只关心跑完）。 */
function run(runtime: LoopRuntime, text: string): Promise<string> {
  return agentLoop(runtime, { text }, new AbortController().signal)
}

/** 这一条是不是**被拦下**的那一笔（「需重审」的回填）——`ok: false` 是它的判别式。 */
function isHeld(entry: Entry): boolean {
  const payload: unknown = entry.payload
  return (
    entry.kind === 'tool-result' &&
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { ok?: unknown }).ok === false
  )
}

/** 被拦下的那几笔——「拦了几次」的断言读起来最省事。 */
function heldCount(stage: Stage): number {
  return stage.records.entries.filter(isHeld).length
}

// —— ① 材料 ——

describe('项目规约块 —— 摆在系统提示词末尾，没有可说的就不摆', () => {
  test('一条规约都没有：**产物一字不动**（无规约时原行为）', () => {
    const base = buildSystemPrompt(PROMPT)

    expect(withProjectRules(base, load([]))).toBe(base)
    expect(renderProjectRulesBlock({ documents: [], problems: [] })).toBeUndefined()
  })

  test('有规约：标题 + 来源 + 正文，且**只报问题也照样出块**', () => {
    const base = buildSystemPrompt(PROMPT)
    const prompt = withProjectRules(base, load([doc('src/AGENTS.md', '先跑 bun run check')]))

    expect(prompt.startsWith(base)).toBe(true)
    expect(prompt).toContain(PROJECT_RULES_HEADING)
    expect(prompt).toContain('〔src/AGENTS.md')
    expect(prompt).toContain('先跑 bun run check')
    // 三句边界是材料的一部分（不是装饰）：用户此刻说的话优先、规约不授权
    expect(prompt).toContain('用户本次的明确交代优先于它们')

    const onlyProblems = renderProjectRulesBlock({
      documents: [],
      problems: [{ path: '/w/.magic/rules/bad.md', message: '读不懂', kind: 'error' }],
    })
    expect(onlyProblems?.body).toContain('没能加载的规约')
    expect(onlyProblems?.body).toContain('/w/.magic/rules/bad.md')
  })

  test('每条都带**所属根**（2026-09-20 裁：单根也报——材料要自足，范围不能靠猜）', () => {
    const two = renderProjectRulesBlock({
      documents: [doc('AGENTS.md', '甲', 'v1', '/w/a'), doc('AGENTS.md', '乙', 'v2', '/w/b')],
      problems: [],
    })
    expect(two?.body).toContain('〔AGENTS.md（根 /w/a）〕')
    expect(two?.body).toContain('〔AGENTS.md（根 /w/b）〕')

    // 单根也报：模型据此把这条规约与它手上的工作目录对上，不必靠猜
    const single = renderProjectRulesBlock({
      documents: [doc('AGENTS.md', '甲', 'v1', '/w/a')],
      problems: [],
    })
    expect(single?.body).toContain('〔AGENTS.md（根 /w/a）〕')
  })

  test('**范围与条件随材料一起走**——不能剥完 YAML 只剩正文（2026-09-20 裁）', () => {
    // 子目录那份：根之外还要报「管到哪儿」
    const scoped = renderProjectRulesBlock({
      documents: [
        {
          ...doc('src/AGENTS.md', 'src 里先跑 check', 'v1', '/w'),
          scope: '/w/src',
        },
      ],
      problems: [],
    })
    expect(scoped?.body).toContain('〔src/AGENTS.md（根 /w · 管 /w/src）〕')

    // 条件规则：`paths` 必须露出来——否则它看上去与一条全局规则一模一样
    const conditional = renderProjectRulesBlock({
      documents: [doc('.magic/rules/frontend.md', '只用函数组件', 'v2', '/w', ['src/**'])],
      problems: [],
    })
    expect(conditional?.body).toContain('只在 src/** 上适用')

    // 无条件的那条**不写那句**（没条件的规则不编一个条件出来）
    const unconditional = renderProjectRulesBlock({
      documents: [doc('.magic/rules/style.md', '一律中文', 'v3', '/w')],
      problems: [],
    })
    expect(unconditional?.body).not.toContain('适用')
  })

  test('取舍那类（choice）**不进模型材料**——它说给用户听，不是说给模型听', () => {
    const block = renderProjectRulesBlock({
      documents: [doc('AGENTS.md', '甲的约定', 'v1', '/w')],
      problems: [
        { path: '/w/.claude/rules/style.md', message: '同根同名：原生优先', kind: 'choice' },
      ],
    })
    expect(block?.body).not.toContain('同根同名')

    const withError = renderProjectRulesBlock({
      documents: [],
      problems: [{ path: '/w/.magic/rules/bad.md', message: '读不懂', kind: 'error' }],
    })
    expect(withError?.body).toContain('读不懂')
  })

  test('`splitSystemPrompt` 认得出这一块（少了它，规约会被算进环境块里）', () => {
    const prompt = withProjectRules(
      buildSystemPrompt(PROMPT),
      load([doc('AGENTS.md', '甲的约定')]),
    )

    const blocks = splitSystemPrompt(prompt)

    expect(blocks.at(-1)?.id).toBe(PROJECT_RULES_BLOCK_ID)
    expect(blocks.at(-1)?.body).toContain('甲的约定')
    // 环境块仍是它自己那一块——没有被后面的规约撑大
    expect(blocks.at(-2)?.id).toBe('environment')
    expect(blocks.at(-2)?.body).not.toContain('甲的约定')
  })
})

// —— ② 送达 ——

describe('无路径规则 —— 首次模型调用前载入', () => {
  test('第一条请求就带着它（不必等谁碰一下文件夹）', async () => {
    const answer = (): RulesLoad => load([doc('AGENTS.md', '本项目一律中文')])
    const { stage, runtime } = stageWith(answer, [{ text: '你好' }])

    await run(runtime, '随便聊聊')

    expect(systemOf(stage, 0)).toContain('本项目一律中文')
  })

  test('**不进条目流**——规约是常驻指令，不是这次对话里谁说的话', async () => {
    const answer = (): RulesLoad => load([doc('AGENTS.md', '本项目一律中文')])
    const { stage, runtime } = stageWith(answer, [{ text: '好' }])

    await run(runtime, '随便聊聊')

    expect(kindsOf(stage)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(stage.records.entries)).not.toContain('本项目一律中文')
  })

  test('**压缩过也还在**：摘要顶掉的是旧对话，规约挂在系统提示词上', async () => {
    const answer = (): RulesLoad => load([doc('AGENTS.md', '本项目一律中文')])
    const { stage, runtime } = stageWith(answer, [{ text: '好' }])
    // 造一条摘要条目（真压缩的产物）——它一进来，旧段就被顶掉了
    stage.records.appendEntry({ kind: 'summary', content: { text: '此前对话的摘要' }, at: 1 })

    await run(runtime, '接着干')

    expect(systemOf(stage, 0)).toContain('本项目一律中文')
    // 摘要确实生效了（这一趟真有它），故上面那条断言不是空转
    const summary = stage.gateway.requests[0]?.messages[1]
    expect(summary?.role).toBe('user')
    expect(summary?.role === 'user' ? summary.content : '').toContain('此前对话的摘要')
  })

  test('改过的规约**下一趟就是新的**（每趟现读，不缓存）', async () => {
    let text = '第一版'
    const answer = (): RulesLoad => load([doc('AGENTS.md', text, `v-${text}`)])
    const { stage, runtime } = stageWith(answer, [{ text: '一' }, { text: '二' }])

    await run(runtime, '第一次')
    text = '第二版'
    await run(runtime, '第二次')

    expect(systemOf(stage, 0)).toContain('第一版')
    expect(systemOf(stage, 1)).toContain('第二版')
  })
})

// —— ③ 目标预查：副作用之前 ——

describe('目标预查 —— 拦在副作用之前', () => {
  test('**首轮直接写受约束文件**：第一次写没发生 · 规则进了下一请求 · 重审后只执行一次', async () => {
    const constrained = doc('src/AGENTS.md', 'src 里先跑 bun run check')
    // 会话开局（目标为空）只送根一级；一碰到 src 才把那儿的约定交出来
    const answer = (targets: readonly string[]): RulesLoad =>
      targets.includes('src/a.ts') ? load([doc('AGENTS.md', '根约定'), constrained]) : load([doc('AGENTS.md', '根约定')])

    const write = { name: 'write', args: { path: 'src/a.ts', content: 'x' } }
    const { stage, runtime, written } = stageWith(answer, [
      { toolCalls: [write] }, // 第一轮：模型直接就要写
      { toolCalls: [write] }, // 重审后：照新规约重新提出
      { text: '写完了' },
    ])

    expect(await run(runtime, '加一个文件')).toBe('settled')

    // ① **第一次写没发生**——副作用只在「规则已进上下文」之后产生一次
    expect(written).toEqual(['src/a.ts'])
    expect(stage.tools.calls).toHaveLength(1)

    // ② 规则**进了下一请求**（第一次请求里没有它，第二次请求里有）
    expect(systemOf(stage, 0)).not.toContain('先跑 bun run check')
    expect(systemOf(stage, 1)).toContain('先跑 bun run check')

    // ③ 那一批**回填了「需重审」**，且配对闭合（有调用必有结果）
    expect(kindsOf(stage)).toEqual([
      'user',
      'assistant',
      'tool-call',
      'tool-result', // 拦下那一笔：需重审
      'assistant',
      'tool-call',
      'tool-result', // 重审后那一笔：真执行
      'assistant',
    ])
    const held = stage.records.entries[3]
    expect(held?.content).toMatchObject({ text: needsReviewText([constrained]) })
    expect(held?.payload).toMatchObject({ ok: false })
  })

  test('拦下的那一次**也发一对 `tool.call` ＋ `tool.result`**——一对齐来齐走，不留幽灵工具', async () => {
    const answer = (targets: readonly string[]): RulesLoad =>
      targets.length === 0 ? load([]) : load([doc('src/AGENTS.md', 'src 的约定')])

    const write = { name: 'write', args: { path: 'src/a.ts', content: 'x' } }
    const { stage, runtime } = stageWith(answer, [
      { toolCalls: [write] },
      { toolCalls: [write] },
      { text: '好了' },
    ])

    await run(runtime, '加一个文件')

    // 两次工具调用 ⇒ **两对**事件（扣下那笔也发）。首轮的口径是「扣下的一个事件都不发」，
    // 那在记录面站得住、**在界面面站不住**：真流式增量已经按 toolcall 通道建出一行工具，
    // 它等的是 `tool.call` 来认领——不发就是屏上一个永远转圈的幽灵（工单 6）。
    const calls = stage.sink.events.filter((event) => event.kind === 'tool.call')
    const results = stage.sink.events.filter((event) => event.kind === 'tool.result')
    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(2)

    // **成对**——恢复的「在途识别」找的就是「有 call 无 result」那几笔，此处一笔都不该有
    const paired = new Set(results.map((event) => (event.data as { call: number }).call))
    expect(calls.every((event) => paired.has(event.id))).toBe(true)

    // **不宣称副作用已执行**：扣下那笔的结果是 `ok: false`
    const okFlags = results.map((event) => (event.data as { ok: boolean }).ok)
    expect(okFlags).toEqual([false, true])
  })

  test('**相同版本不循环拦截**：送过之后再碰同一个目录，直接执行', async () => {
    const answer = (targets: readonly string[]): RulesLoad =>
      targets.length === 0 ? load([]) : load([doc('src/AGENTS.md', 'src 的约定')])

    const { stage, runtime, written } = stageWith(answer, [
      { toolCalls: [{ name: 'write', args: { path: 'src/a.ts' } }] }, // 触发拦截
      { toolCalls: [{ name: 'write', args: { path: 'src/a.ts' } }] }, // 重提 → 执行
      { toolCalls: [{ name: 'write', args: { path: 'src/b.ts' } }] }, // 同一目录，已送过 → 直接执行
      { text: '完事' },
    ])

    await run(runtime, '写两个文件')

    expect(written).toEqual(['src/a.ts', 'src/b.ts'])
    // 只拦过一次——拦第二次就是「相同版本循环拦截」
    expect(systemOf(stage, 0)).not.toContain('src 的约定')
    expect(systemOf(stage, 1)).toContain('src 的约定')
    expect(systemOf(stage, 2)).toContain('src 的约定')
  })

  test('一批里前几条没碰到规约也要**整批**扣下（重提这句话得对整批成立）', async () => {
    const answer = (targets: readonly string[]): RulesLoad =>
      targets.includes('src/a.ts') ? load([doc('src/AGENTS.md', 'src 的约定')]) : load([])

    const { runtime, written } = stageWith(answer, [
      {
        toolCalls: [
          { name: 'write', args: { path: 'README.md' } },
          { name: 'write', args: { path: 'src/a.ts' } },
        ],
      },
      {
        toolCalls: [
          { name: 'write', args: { path: 'README.md' } },
          { name: 'write', args: { path: 'src/a.ts' } },
        ],
      },
      { text: '好了' },
    ])

    await run(runtime, '一起写')

    // 第一轮**一个都没写**（README.md 本身没有新规约，但它和 a.ts 是同一批）
    expect(written).toEqual(['README.md', 'src/a.ts'])
  })

  test('`exec` 这类没有路径参数的调用**不会被拦**（它推不出目标，限度写在使用面上）', async () => {
    const answer = (targets: readonly string[]): RulesLoad =>
      targets.length === 0 ? load([]) : load([doc('src/AGENTS.md', 'src 的约定')])

    const { stage, runtime } = stageWith(answer, [
      { toolCalls: [{ name: 'write', args: { cmd: 'ls' } }] },
      { text: '好了' },
    ])

    await run(runtime, '跑一下')

    expect(stage.tools.calls).toHaveLength(1)
    expect(systemOf(stage, 0)).not.toContain('src 的约定')
  })

  test('**规约在「请求装配完、工具还没跑」之间被改** ⇒ 另算一版 ⇒ 重拦一次（不是无脑循环）', async () => {
    let version = 'v1'
    let loads = 0
    const answer = (targets: readonly string[]): RulesLoad => {
      loads += 1
      const current = version
      // ⚠️ 这里按**取用次数**卡：第 5 次＝第三轮「请求装配」那一下。它照旧报 v1，
      // 而同一轮紧接着的**预查**（第 6 次）读到的是 v2——这正是「用户在模型跑动的那一下
      // 改了规约」在循环里的样子。次数是本实现的取用节律，改坏了这条用例会当场红。
      if (loads === 5) version = 'v2'

      return targets.length === 0 ? load([]) : load([doc('AGENTS.md', `约定-${current}`, current)])
    }

    const { stage, runtime, written } = stageWith(answer, [
      { toolCalls: [{ name: 'write', args: { path: 'src/a.ts' } }] }, // 拦（v1）
      { toolCalls: [{ name: 'write', args: { path: 'src/a.ts' } }] }, // 执行（v1 已送）
      { toolCalls: [{ name: 'write', args: { path: 'src/b.ts' } }] }, // 预查读到 v2 → 再拦一次
      { toolCalls: [{ name: 'write', args: { path: 'src/b.ts' } }] }, // 执行
      { text: '好了' },
    ])

    await run(runtime, '写文件')

    // 每个文件各只写一次——重拦之后重提的那一次没有写第二遍
    expect(written).toEqual(['src/a.ts', 'src/b.ts'])
    expect(systemOf(stage, 1)).toContain('约定-v1')
    expect(systemOf(stage, 2)).toContain('约定-v1') // 第三轮的请求还带着旧版
    expect(systemOf(stage, 3)).toContain('约定-v2') // 拦下之后才换上新版
    // 两次「需重审」——第二次是改版引起的，不是无脑循环
    expect(heldCount(stage)).toBe(2)
  })

  test('**规约在两轮之间被改**：下一趟请求直接带新版，**不多拦一次**（送达在拦之前）', async () => {
    let version = 'v1'
    const answer = (targets: readonly string[]): RulesLoad =>
      targets.length === 0 ? load([]) : load([doc('AGENTS.md', `约定-${version}`, version)])

    const { stage, runtime, written } = stageWith(
      answer,
      [
        { toolCalls: [{ name: 'write', args: { path: 'src/a.ts' } }] }, // 拦（v1 没送过）
        { toolCalls: [{ name: 'write', args: { path: 'src/a.ts' } }] }, // 执行（v1 已送）
        { toolCalls: [{ name: 'write', args: { path: 'src/b.ts' } }] }, // v2 已在请求里送出 → 直接执行
        { text: '好了' },
      ],
      // 写第一个文件的当口，用户把规约改了——下一趟**请求装配**就会读到新版
      (_path, index) => {
        if (index === 0) version = 'v2'
      },
    )

    await run(runtime, '写文件')

    // 新版随下一趟请求一起送到，故调用**不必再拦一次**——拦是留给「送到之前就动手」的
    expect(written).toEqual(['src/a.ts', 'src/b.ts'])
    expect(systemOf(stage, 1)).toContain('约定-v1')
    expect(systemOf(stage, 2)).toContain('约定-v2')
    expect(heldCount(stage)).toBe(1)
  })
})

// —— ④ 与既有的循环控制相处 ——

describe('预查不妨碍既有的控制流', () => {
  test('**中断仍然有效**：信号已中止时不执行工具，也不落条目的调用对', async () => {
    const answer = (): RulesLoad => load([])
    const { stage, runtime, written } = stageWith(answer, [
      { toolCalls: [{ name: 'write', args: { path: 'a.ts' } }] },
      { text: '不该走到' },
    ])

    const controller = new AbortController()
    controller.abort()

    expect(await agentLoop(runtime, { text: '动手' }, controller.signal)).toBe('aborted')
    expect(written).toEqual([])
    expect(kindsOf(stage)).toEqual(['user'])
  })

  test('**历史**作用域有上界（先进先出）——长会话不会把碰过的每一个目录都攒着', () => {
    /** 每次 `load` 被问了哪些目标——分两拨记：预查那一趟与**下一次请求**那一趟。 */
    let asked: readonly string[] = []
    const delivery = createRulesDelivery(
      stubRules((targets) => {
        asked = targets
        return load([])
      }),
    )

    const calls: readonly ToolCall[] = Array.from(
      { length: MAX_SCOPE_TARGETS + 10 },
      (_unused, index) => ({
        id: `c${index}`,
        name: 'write',
        args: { path: `d${index}/x.ts` },
      }),
    )

    // **预查查的是这一批的全部目标**（2026-09-20 裁：先查完整当前批，不先裁再查）——
    // 首轮实测：同批 65 次写、第一个目标有规约，全部写成功且任何请求都没收到那份规约
    delivery.preflight(calls)
    expect(asked).toHaveLength(MAX_SCOPE_TARGETS + 10)

    // 而**下一次请求**（历史那一截）照旧有界：最早的 10 个目标已经出队
    delivery.promptFor('')
    expect(asked).toHaveLength(MAX_SCOPE_TARGETS)
    expect(asked).not.toContain('d0/x.ts') // 最早那个已出队
    expect(asked).toContain(`d${MAX_SCOPE_TARGETS + 9}/x.ts`) // 最近这个在
  })

  test('**被拦批的目标被钉住**：下一次请求一定带上它们的规约（不先裁再送＝不转圈）', () => {
    /** 只有 `src` 有规约——其余目标什么都读不出来。 */
    const delivery = createRulesDelivery(
      stubRules((targets) =>
        targets.includes('src/a.ts')
          ? load([doc('src/AGENTS.md', 'src 的约定', `v-src-${targets.length}`)])
          : load([]),
      ),
    )

    // 先让历史作用域被 64 个别的目标填满（`src` 不在其中）
    delivery.promptFor('')
    delivery.preflight(
      Array.from({ length: MAX_SCOPE_TARGETS }, (_unused, index) => ({
        id: `c${index}`,
        name: 'write',
        args: { path: `plain/f${index}.ts` },
      })),
    )

    // 现在提一个 src 的目标：这一批必须被拦（它的规约还没送达）
    const batch = [{ id: 'x', name: 'write', args: { path: 'src/a.ts' } }]
    expect(delivery.preflight(batch)).toEqual({
      kind: 'review',
      blocking: [expect.objectContaining({ name: 'src/AGENTS.md' })],
    })

    // **下一次请求必须带上 src**——否则「拦了又裁、裁了又拦」是一个死循环，
    // 而模型永远看不到那份规约（首轮实测：账上记着「送过」，于是直接放行）
    const asked: string[][] = []
    const probing = createRulesDelivery(
      stubRules((targets) => {
        asked.push([...targets])
        return load([])
      }),
    )
    probing.preflight(batch)
    probing.promptFor('')
    expect(asked.at(-1)).toContain('src/a.ts')

    // 送达之后重提 ⇒ 放行（重审后只执行一次）
    const after = createRulesDelivery(
      stubRules((targets) =>
        targets.includes('src/a.ts') ? load([doc('src/AGENTS.md', 'src 的约定')]) : load([]),
      ),
    )
    after.promptFor('')
    expect(after.preflight(batch).kind).toBe('review')
    after.promptFor('') // 重审那一趟请求——规约真送出去了
    expect(after.preflight(batch)).toEqual({ kind: 'pass' })
  })

  test('**送达＝最近一次请求里有它**：被挤出之后重访，照样拦（首轮是永久账，直接放行）', () => {
    const withGuard = (targets: readonly string[]): RulesLoad =>
      targets.includes('guard/f.ts') ? load([doc('guard/AGENTS.md', 'guard 的约定')]) : load([])
    const delivery = createRulesDelivery(stubRules(withGuard))

    delivery.promptFor('')
    expect(delivery.preflight([{ id: 'a', name: 'write', args: { path: 'guard/f.ts' } }]).kind).toBe('review')
    delivery.promptFor('') // 规约送达
    expect(delivery.preflight([{ id: 'a', name: 'write', args: { path: 'guard/f.ts' } }])).toEqual({ kind: 'pass' })

    // 64 个新目标把它挤出**历史**作用域 ⇒ 下一次请求里**没有它了**
    delivery.preflight(
      Array.from({ length: MAX_SCOPE_TARGETS }, (_unused, index) => ({
        id: `p${index}`,
        name: 'write',
        args: { path: `plain/f${index}.ts` },
      })),
    )
    expect(delivery.promptFor('')).not.toContain('guard 的约定')

    // 于是回头再碰 guard：**必须再拦一次**——因为当下这次请求里确实没有那份规约
    expect(delivery.preflight([{ id: 'b', name: 'write', args: { path: 'guard/f.ts' } }]).kind).toBe('review')
  })

  test('**材料超限**：这一批停住，回填**不谎称「已送入上下文」**且不让模型重提', async () => {
    const answer = (targets: readonly string[]): RulesLoad =>
      targets.includes('src/a.ts')
        ? load([doc('src/AGENTS.md', 'src 的约定')], [], true) // truncated：回来那份不是全的
        : load([])

    const write = { name: 'write', args: { path: 'src/a.ts', content: 'x' } }
    const { stage, runtime, written } = stageWith(answer, [
      { toolCalls: [write] },
      { text: '那算了' },
    ])

    await run(runtime, '写一个')

    // **没执行**（不静默动手）……
    expect(written).toEqual([])

    // ……且回填说的是「超限」，**不说**「已送入上下文」
    const held = stage.records.entries.filter(isHeld)
    expect(held).toHaveLength(1)
    const content = held[0]?.content
    const said = content !== undefined && 'text' in content ? content.text : ''
    expect(said).toContain('装不下')
    expect(said).toContain('不要重提')
    expect(said).not.toContain('已送入上下文')
  })

  test('**没有新规约时，行为与不接线一字不差**（无规约工作区的原行为）', async () => {
    const answer = (): RulesLoad => load([])
    const write = { name: 'write', args: { path: 'a.ts' } }
    const { stage, runtime, written } = stageWith(answer, [
      { toolCalls: [write] },
      { text: '好了' },
    ])

    expect(await run(runtime, '写一个')).toBe('settled')

    expect(written).toEqual(['a.ts'])
    expect(kindsOf(stage)).toEqual(['user', 'assistant', 'tool-call', 'tool-result', 'assistant'])
    expect(systemOf(stage, 0)).not.toContain(PROJECT_RULES_HEADING)
  })
})
