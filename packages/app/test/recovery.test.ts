/**
 * U25 · **恢复**（`@magic/app` 装配面）——纵切：启动入口 → 装载 → 五步 → 续跑。
 *
 * 判据（`工作分解.md`·U25 行）：**杀进程 → 重起 → 续跑（含在途）**。
 *
 * ⚠️ **真崩溃（SIGKILL）由真跑覆盖**，不在这儿：本文件里的「崩溃现场」是**照着崩法摆的**
 * （往库里写一对「有 `tool.call` 无 `tool.result`」＋一个没收尾的轮）——那是**确定性**要的
 * 代价：自动化用例不该靠杀进程的时序。真跑那一趟（真 TTY ＋ 真按键 ＋ 真杀进程 ＋
 * 真断在工具中间）是本单元的判据本体，见回报。
 *
 * 这一层验的是**接线**：装配把应用层（`@magic/actions`）与各域绑起来，`boot` 一跳走完
 * ①②③④⑤。各步自己的判据在各自的包里（`actions` / `conversation` / `records`），
 * 此处只验「接上了、跑得通、续得上」。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import type { KernelEvent, ModelMessage, SessionId, UserMessageContent } from '@magic/contracts'
import type { Assembly } from '../src/assembly.ts'
import { attachShell, runShellScript } from '../src/shell.ts'
import type { ShellHandle } from '../src/shell.ts'
import { makeStage } from './support.ts'
import type { Stage } from './support.ts'
import { eventsOfKind, readDatabase } from './support.ts'

/** 一件工具都不请求的一轮——续跑那几句只验上下文与轮号，不惊动闸门。 */
const PLAIN: readonly { readonly text: string }[] = [{ text: '好' }]

const T0 = 1_700_000_000_000
const WORKSPACE_CALL = { name: 'exec', args: { cmd: 'mkdir -p src/new' } }

test('真实写入后模型失败，重开保留执行事实与工作笔记，明确接续不重放副作用', async () => {
  const stage = makeStage()
  let first!: Assembly; let calls = 0
  first = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    calls += 1
    const turn: FauxTurn = calls === 1 ? { toolCalls: [
      { name: 'write', args: { path: join(stage.dataDir, 'notes', first.session!, 'MEMORY.md'), content: '写入完成后仍需核对结果，不能重做已执行动作' } },
      { name: 'write', args: { path: 'result.txt', content: '已执行一次' } },
    ] } : { error: { tier: 'terminal', message: '工具完成后受控断流' } }
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
  } }) })
  const shell = attachShell(first.shell)
  try {
    await shell.submit('只执行一次写入，再核对结果')
    const path = join(stage.workspace, 'result.txt')
    expect(readFileSync(path, 'utf8')).toBe('已执行一次')
    const session = first.session!
    shell.dispose(); first.close()
    writeFileSync(path, '用户后续改动必须保留')
    const resumed = stage.assemble({ session, turns: [{ text: '先核对当前实际结果' }] })
    const again = attachShell(resumed.shell)
    try {
      await resumed.boot()
      expect(stage.models.at(-1)!.requests).toHaveLength(0)
      expect(readFileSync(path, 'utf8')).toBe('用户后续改动必须保留')
      expect(readFileSync(join(stage.dataDir, 'notes', session, 'MEMORY.md'), 'utf8')).toContain('不能重做已执行动作')
      await again.submit('明确继续核对')
      const messages = stage.models.at(-1)!.requests.at(-1)!.messages
      expect(messages.map(textOf).join('\n')).not.toContain('不能重做已执行动作')
      expect(JSON.stringify(messages)).toContain('不能重做已执行动作')
      expect(messages.some(message => message.role === 'tool' && message.name === 'write' && message.ok)).toBe(true)
      expect(eventsOfKind(again.events, 'tool.call')).toHaveLength(0)
      expect(readFileSync(path, 'utf8')).toBe('用户后续改动必须保留')
    } finally { again.dispose(); resumed.close() }
  } finally { shell.dispose(); first.close(); stage.dispose() }
})

/** 一条模型消息的正文——`role:'tool'` 那支不带 `content`（正文在 `output`），按判别取。 */
function textOf(message: ModelMessage): string {
  return 'content' in message ? textOfContent(message.content) : `${message.name}: ${message.output}`
}

/** 一条模型消息的正文（U37 起可能是**部件串**——带图那条）——只取文字那几件。 */
function textOfContent(content: UserMessageContent): string {
  return typeof content === 'string'
    ? content
    : content.map((part) => (part.type === 'text' ? part.text : '〔图片〕')).join('')
}


/**
 * 往库里摆一份**崩溃现场**——「有 `tool.call` 无 `tool.result`」＋一个没收尾的轮。
 *
 * 摆的是记录里那几样**原始数据**（条目 ＋ 事件），不经任何内核代码的加工——
 * 恢复要认的就是它们，真崩溃留下的也就是这几样（一字不差）。
 *
 * 裁决轨迹摆的是**已批准、未回填**（闸门放行之后进程没了）——那是本单元最硬的一条：
 * 「已批准」只说明**有资格跑**，不说明跑没跑到哪一步，故**一次都不能重跑**。
 */
function writeCrashSite(
  assembly: Assembly,
  session: SessionId,
  call: { readonly name: string; readonly args: Readonly<Record<string, unknown>> },
  turn = 2,
): void {
  const records = assembly.records.serviceFor(session)
  /** 铸一条事件，回它的 id（信封六件齐——id 也由这儿给）。 */
  const event = (kind: string, data: unknown): number => {
    const id = records.nextId()
    records.appendEvent({ id, session, turn, at: T0, kind, data } as KernelEvent)
    return id
  }

  records.appendEntry({
    kind: 'tool-call',
    content: { text: '' },
    payload: { name: call.name, args: call.args },
    at: T0,
  })
  event('turn.start', {})
  // 链引用＝这次 `tool.call` 事件的 id——裁决 / 结果两处同指它
  const callRef = event('tool.call', { name: call.name, args: call.args })
  event('tool.decision', { call: callRef, decision: 'approve', decider: 'auto', elapsedMs: 120 })
}

/** 接上外壳位并留一份轨迹。 */
function attach(assembly: Assembly): ShellHandle {
  return attachShell(assembly.shell)
}

/** 起一条会话并交代一句——接续用例的沙地（返回它的 id）。 */
async function seedSession(stage: Stage, text: string): Promise<SessionId> {
  const assembly = stage.assemble({ turns: PLAIN })
  const handle = attach(assembly)
  await handle.submit(text)
  const session = assembly.session
  if (session === undefined) throw new Error('首条消息之后该有会话了')

  handle.dispose()
  assembly.close()
  return session
}

describe('接续（`resume` 那条路）——装载 ＋ 恢复 ＋ 重建展示', () => {
  test('崩溃现场 → 重起接续：补记结果与中止，**一次都不重跑**', async () => {
    const stage = makeStage()
    try {
      const session = await seedSession(stage, '起个头')

      // 重起——**显式接续**（D4：启动不接续；接着来是显式的）
      const resumed = stage.assemble({ turns: PLAIN, session })
      expect(resumed.session).toBe(session)
      writeCrashSite(resumed, session, WORKSPACE_CALL)

      const handle = attach(resumed)
      await resumed.boot()

      // ① 在途识别 → ② 处置：**未重跑**（非幂等一律交用户裁决），补一条失败结果
      const results = eventsOfKind(handle.events, 'tool.result')
      expect(results).toHaveLength(1)
      expect(results[0]?.data.ok).toBe(false)
      expect(JSON.stringify(results[0])).toContain('未自动重跑')

      // ③ 未收尾的轮记中止
      const aborted = eventsOfKind(handle.events, 'turn.end').filter(
        (event) => event.data.reason === 'aborted',
      )
      expect(aborted).toHaveLength(1)
      expect(aborted[0]?.turn).toBe(2) // 信封的 turn ＝中断那一轮

      // ⑤ 界面重建展示的由头：外壳得知自己落在哪条会话上（否则状态行写着「新会话」）
      expect(eventsOfKind(handle.events, 'session.state').at(-1)?.data.active).toBe(session)

      // 直读库：补的两笔都落了盘（不是只走了内存）
      const raw = readDatabase(resumed.paths.database)
      try {
        const kinds = raw.entries.filter((row) => row.session === session).map((row) => row.kind)
        expect(kinds).toEqual(['user', 'assistant', 'tool-call', 'tool-result'])
        expect(raw.events.filter((row) => row.kind === 'tool.result')).toHaveLength(1)
      } finally {
        raw.close()
      }

      handle.dispose()
      resumed.close()
    } finally {
      stage.dispose()
    }
  })

  test('⑤ 上下文由条目重建——恢复后送到模型的序列合法（助手的 toolCalls 条条有回填）', async () => {
    const stage = makeStage()
    try {
      const session = await seedSession(stage, '起个头')

      const resumed = stage.assemble({ turns: PLAIN, session })
      writeCrashSite(resumed, session, { name: 'exec', args: { cmd: 'ls' } })
      const handle = attach(resumed)
      await resumed.boot()

      // 接续之后**接着干**——这一句的模型请求就是判据的落点
      await handle.submit('接着干')

      const messages = stage.models.at(-1)?.requests.at(-1)?.messages ?? []
      const roles = messages.map((message) => message.role)

      // 带 `toolCalls` 而没有回填的消息会被供应商当场拒——「落单的不送」是另一处既定行为，
      // 而恢复的补记正是让它**不落单**：那次调用有了一条 `tool` 消息跟着
      expect(roles[0]).toBe('system')
      expect(roles).toContain('tool')
      expect(roles.indexOf('tool')).toBeGreaterThan(roles.indexOf('assistant'))

      // 回填那条说的是**未重跑**（不是「跑完了」那种假账）
      const backfill = messages.find((message) => message.role === 'tool')
      expect(backfill).toMatchObject({ name: 'exec', ok: false })
      expect(messages.map(textOf).join('\n')).toContain('未自动重跑')

      handle.dispose()
      resumed.close()
    } finally {
      stage.dispose()
    }
  })

  test('轮号续跑——接续之后那几轮接着记录里的号走（不从 1 重来）', async () => {
    const stage = makeStage()
    try {
      const session = await seedSession(stage, '头一句')

      const resumed = stage.assemble({ turns: PLAIN, session })
      // 记录里出现过的最大轮号是 7（崩溃就断在这一轮）
      writeCrashSite(resumed, session, { name: 'exec', args: { cmd: 'ls' } }, 7)
      const handle = attach(resumed)
      await resumed.boot()

      await handle.submit('接着干')

      const turns = eventsOfKind(handle.events, 'turn.start').map((event) => event.turn)
      // 补记那一轮（7）之后，新的一轮是 8——**不从 1 重来**
      expect(turns.at(-1)).toBe(8)

      handle.dispose()
      resumed.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('干净会话——照旧装载，但过程流里不留恢复的痕迹', () => {
  test('boot 跑得完；没有补记（无中止、无结果），但报了「你在这儿」', async () => {
    const stage = makeStage()
    try {
      const session = await seedSession(stage, '先来的那句')

      const resumed = stage.assemble({ turns: PLAIN, session })
      const handle = attach(resumed)

      await resumed.boot()

      expect(eventsOfKind(handle.events, 'tool.result')).toEqual([])
      expect(eventsOfKind(handle.events, 'turn.end')).toEqual([])
      // 装载那一下照旧要说——否则接续一条旧会话时屏上还以为自己是新会话
      expect(eventsOfKind(handle.events, 'session.state').at(-1)?.data.active).toBe(session)

      handle.dispose()
      resumed.close()
    } finally {
      stage.dispose()
    }
  })

  test('空手打开——`boot` 是空操作（一个会话都不开，D5）', async () => {
    const stage = makeStage()
    try {
      const assembly = stage.assemble({ turns: PLAIN })
      const handle = attach(assembly)

      await assembly.boot()

      expect(assembly.session).toBeUndefined()
      expect(handle.events).toEqual([])

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('无人值守那条路（`--script`）也走启动流转', () => {
  test('接上订阅 → 跑 boot → 才放开输入（次序与真外壳同一条纪律）', async () => {
    const stage = makeStage()
    try {
      const session = await seedSession(stage, '起个头')

      const resumed = stage.assemble({ turns: PLAIN, session })
      writeCrashSite(resumed, session, WORKSPACE_CALL)

      const handle = await runShellScript(resumed.shell, { inputs: [] }, {
        onEvent: () => undefined,
        // 这一行就是 `cli.ts` · `scriptOptions` 的接线（D16 那笔账：入口两条、产出路径一条）
        boot: () => resumed.boot(),
      })

      // 恢复跑过了——补记在轨迹里（而不是「脚本没提这茬就静默跳过」）
      const results = eventsOfKind(handle.events, 'tool.result')
      expect(results).toHaveLength(1)
      expect(JSON.stringify(results[0])).toContain('未自动重跑')

      handle.dispose()
      resumed.close()
    } finally {
      stage.dispose()
    }
  })
})
