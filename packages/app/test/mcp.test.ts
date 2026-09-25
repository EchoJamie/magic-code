/**
 * U38 · MCP stdio 工具闭环 —— **全链判据**（装配 × 工具域 × 权限域 × 记录域 × 模型回填）。
 *
 * 一句话：**真应用装配 ＋ 本地假 stdio 服务器**跑完发现 → 模型选择 → 审批 → 调用 → 落账 →
 * 回填，再验拒绝（服务器计数零）· 同名工具分派 · 伪造来源 · 单连接失败 · 超时 / 断连 / 取消 ·
 * 关闭释放 · 密钥不外泄。
 *
 * 三条纪律落在这一份里：
 * - **模型是替身（Faux）、服务器是真进程**——不能发付费模型请求，而 MCP 这一侧必须真起进程
 *   （起手有界、断连、释放这三条假实现里不存在）；
 * - **判据取服务器自己数的数**（假服务器的调用流水文件），不取客户端说了什么；
 * - **沙地全在临时目录**（`makeStage` 的规矩：数据 / 配置 / 授权 / 子进程都不碰真的）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KernelEvent } from '@magic/contracts'
import type { FauxTurn } from '@magic/faux'
import type { Assembly } from '../src/index.ts'
import { attachShell } from '../src/shell.ts'
import { eventsOfKind, lastModel, makeStage, readDatabase } from './support.ts'
import type { Stage } from './support.ts'

/** 假服务器（真进程 · 官方 SDK 的服务器面）——与适配器用例同一个夹具。 */
const FAKE_SERVER = join(import.meta.dir, '..', '..', 'mcp', 'test', 'support', 'fake-server.ts')

/** 一块只用一次就删的目录（放日志、放「用户自己的进程」的脚本）。 */
const scraps: string[] = []

function scrapDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magic-mcp-app-'))
  scraps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scraps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 一个外部服务器条目——命令用**当前这个运行时**（夹具不依赖 PATH 上有什么）。 */
function serverEntry(dir: string, name: string, extra: Record<string, string> = {}): unknown {
  return {
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { FAKE_MCP_LOG: join(dir, `${name}.jsonl`), FAKE_MCP_NAME: name, ...extra },
  }
}

/** 配一台服务器的 stage（`servers` 给两台就是「跨服务器同名」那一幕）。 */
function stageWith(
  servers: Readonly<Record<string, unknown>>,
  options: { readonly config?: Record<string, unknown> } = {},
): Stage {
  return makeStage({ config: { mcp: { servers }, ...options.config } })
}

/** 服务器那边的调用流水——**判据取它**（服务器自己数的数）。 */
function callsOf(path: string): readonly { tool: string; args: Record<string, unknown>; pid: number }[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { tool: string; args: Record<string, unknown>; pid: number })
}

/** 等一个异步条件成立（有界）。 */
async function untilAsync(test: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await test()) return
    await Bun.sleep(50)
  }
  throw new Error(`等不到：${what}`)
}

/** 服务器记下的「它自己拉起的那个后代」（`descendants` / `spawnboom` 两幕）。 */
function descendantPidOf(log: string): number | undefined {
  if (!existsSync(log)) return undefined
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const entry = JSON.parse(line) as { kind?: string; pid?: number }
    if (entry.kind === 'child') return entry.pid
  }
  return undefined
}

/** 等条件成立（轮询——这一条链是异步的，测试别假设时序）。 */
async function until(test: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

/** 裸接控制面：留事件轨迹，**按需答复**（不自动批准——审批那一段要看个清楚）。 */
function bareShell(assembly: Assembly) {
  const events: KernelEvent[] = []
  const off = assembly.shell.subscribe((event) => events.push(event))

  return {
    events,
    requests: () => eventsOfKind(events, 'tool.decision.request'),
    result: () => eventsOfKind(events, 'tool.result').at(-1),
    answer(id: number, decision: 'approve' | 'reject'): void {
      assembly.shell.send({ type: 'decision.answer', id, decision })
    },
    dispose: off,
  }
}

describe('发现 → 审批 → 调用 → 落账 → 回填', () => {
  test('首轮模型请求就看得见外部工具；批准后真的调用、结果回填、账落库', async () => {
    const dir = scrapDir()
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })
    const log = join(dir, 'fake.jsonl')
    const turns: readonly FauxTurn[] = [
      { toolCalls: [{ name: 'mcp__fake__echo', args: { text: '外部你好' } }] },
      { text: '收到了' },
    ]

    try {
      const assembly = stage.assemble({ turns })
      await assembly.ready()

      // 装配侧先自证：这一台连上了、工具表是服务器报的那几件。
      // **原锚**：四格（server / state / tools / rejected）；**为何变**：U39 加了两种接入，
      // 读数要说得清这一条是怎么连的（`transport`）；**新锚**：五格，多出来的那一格是 'stdio'。
      expect(assembly.mcpServers()).toEqual([
        {
          server: 'fake',
          transport: 'stdio',
          state: { status: 'available' },
          tools: ['echo', 'snapshot', 'shot', 'annotated', 'fail', 'slow', 'boom', 'spawnboom'],
          rejected: [],
        },
      ])

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '用外部工具回显一句' })
      await until(() => shell.requests().length >= 1, '审批询问')

      // ① **发现**：首轮请求的工具表里就有它（唯一名带服务器身份）
      const first = lastModel(stage).requests[0]
      expect(first?.tools?.map((tool) => tool.name)).toContain('mcp__fake__echo')

      // ② **审批**：卡上点名 `服务器 / 工具`，材料是**实际业务参数**，且标着「外部操作」
      const request = shell.requests()[0]
      expect(request?.data.name).toBe('fake / echo')
      expect(request?.data.weight).toBe('heavy')
      expect(request?.data.external).toBe(true)
      expect(request?.data.material).toContain('外部你好')

      // ③ **批准 → 调用**：服务器那边确实收到了一次（服务器自己数的）
      shell.answer(request?.id as number, 'approve')
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')

      expect(callsOf(log).map((call) => call.tool)).toEqual(['echo'])
      expect(shell.result()?.data.ok).toBe(true)

      // ④ **落账**：条目与事件都进了库（**直读库表**，不经 API 回读）
      await until(() => lastModel(stage).requests.length >= 2, '第二次模型请求')
      const db = readDatabase(assembly.paths.database)
      try {
        const kinds = db.entries.map((entry) => entry.kind)
        expect(kinds).toContain('tool-call')
        expect(kinds).toContain('tool-result')
        expect(db.events.map((event) => event.kind)).toContain('tool.result')
      } finally {
        db.close()
      }

      // ⑤ **回填**：模型第二次请求里带着这次结果
      const back = lastModel(stage).requests[1]
      const toolMessage = back?.messages.find((message) => message.role === 'tool')
      expect(toolMessage?.output).toContain('外部你好')

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('拒绝', () => {
  test('拒绝＝服务器零调用（计数为证），模型收到「已拒绝——未执行」', async () => {
    const dir = scrapDir()
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })
    const log = join(dir, 'fake.jsonl')

    try {
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'mcp__fake__echo', args: { text: '别调' } }] }, { text: '好' }],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '调一下' })
      await until(() => shell.requests().length >= 1, '审批询问')

      shell.answer(shell.requests()[0]?.id as number, 'reject')
      await until(() => shell.result() !== undefined, '结果落定')

      expect(shell.result()?.data.ok).toBe(false)
      // **服务器自己数的数是 0**——拒绝之后一次都没打过去
      expect(callsOf(log)).toEqual([])

      // 回填给模型的那一句说的是「没做」
      await until(() => lastModel(stage).requests.length >= 2, '第二次模型请求')
      const toolMessage = lastModel(stage).requests[1]?.messages.find((m) => m.role === 'tool')
      expect(toolMessage?.output).toContain('已拒绝——未执行')

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

test('**调用中途**才起的后代、父随即崩——从真应用这一侧也收得到', async () => {
    const dir = scrapDir()
    const log = join(dir, 'fake.jsonl')
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })

    try {
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'mcp__fake__spawnboom', args: {} }] }, { text: '好' }],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '让它起一层再崩' })
      await until(() => shell.requests().length >= 1, '审批询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => shell.result() !== undefined, '结果落定')

      // 那一笔的效果未知（调用发出去了、服务器在途没了）
      expect(outputTextOf(shell.result())).toContain('未收到结果，远端可能已执行')

      // **它带起的那一层也要没**（归属靠进程组——崩前没数过它也认得出）
      const child = descendantPidOf(log)
      expect(typeof child).toBe('number')
      await untilAsync(async () => !alive(child as number), '那一层退出')
      expect(alive(child as number)).toBe(false)

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

describe('名字与重名的收口（返工 B · 独立验收问题 5 / 6）', () => {
  test('不合规的没收下、同台重名的都拒——诊断说得出来，合法项与内置工具照常', async () => {
    const dir = scrapDir()
    const stage = stageWith({
      bad: serverEntry(dir, 'bad', { FAKE_MCP_MODE: 'badname' }),
      dup: serverEntry(dir, 'dup', { FAKE_MCP_MODE: 'dup' }),
    })

    try {
      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      await assembly.ready()

      // ① 读数：这一台报了什么、我们用了什么、没用什么
      const views = assembly.mcpServers()
      const bad = views.find((view) => view.server === 'bad')
      const dup = views.find((view) => view.server === 'dup')

      expect(bad?.tools).toEqual(['clean_one', 'clean_two'])
      expect(bad?.rejected).toHaveLength(1)
      expect(bad?.rejected[0]?.reason).toContain('不合规')

      expect(dup?.tools).toEqual(['fine'])
      expect(dup?.rejected.map((one) => one.tool)).toEqual(['echo', 'echo'])

      // ② 开屏那一句：点名到服务器与件数（用户不会只看到「少了几件」）
      const said = assembly.notices.join('\n')
      expect(said).toContain('「bad」有 1 件工具没能收下')
      expect(said).toContain('「dup」有 2 件工具没能收下')

      // ③ 模型那一侧的工具表：合法的外部工具 ＋ 内置照常；不合规的一件都没有
      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '随便说一句' })
      await until(() => lastModel(stage).requests.length >= 1, '首轮模型请求')

      const names = toolNamesOf(lastModel(stage).requests[0])
      expect(names.filter(isExternal)).toEqual([
        'mcp__bad__clean_one',
        'mcp__bad__clean_two',
        'mcp__dup__fine',
      ])
      expect(names.some((name) => name.includes('批准全部'))).toBe(false)
      expect(names).toContain('exec') // 内置七件不受影响

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

test('下划线开头的合法工具：进模型工具表**并被真实调用**（返工 C）', async () => {
    const dir = scrapDir()
    const stage = stageWith({ fake: serverEntry(dir, 'fake', { FAKE_MCP_MODE: 'under' }) })
    const log = join(dir, 'fake.jsonl')

    try {
      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'mcp__fake___echo', args: { text: '下划线也调得到' } }] },
          { text: '好' },
        ],
      })
      await assembly.ready()

      // ① 读数：两件都收下了（`_echo` 不再被连带拒收），一件都没拒
      expect(assembly.mcpServers()[0]?.tools).toEqual(['safe', '_echo'])
      expect(assembly.mcpServers()[0]?.rejected).toEqual([])

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '调那个下划线开头的' })
      await until(() => shell.requests().length >= 1, '审批询问')

      // ② **进模型那一侧的工具表**（注册名带三横：前缀 ＋ 服务器 ＋ `_echo`）
      expect(toolNamesOf(lastModel(stage).requests[0])).toContain('mcp__fake___echo')

      // ③ **真调用**：批准之后服务器自己数得到这一件，结果原样回来
      const request = shell.requests()[0]
      expect(request?.data.name).toBe('fake / _echo')
      shell.answer(request?.id as number, 'approve')
      await until(() => shell.result() !== undefined, '结果落定')

      expect(callsOf(log).map((call) => call.tool)).toEqual(['_echo'])
      expect(shell.result()?.data.ok).toBe(true)
      expect(outputTextOf(shell.result())).toContain('下划线也调得到')

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

describe('真实来源与不可放权', () => {
  test('跨服务器同名工具各走各的；伪造来源参数不改变真实身份', async () => {
    const dir = scrapDir()
    const stage = stageWith({ alpha: serverEntry(dir, 'alpha'), beta: serverEntry(dir, 'beta') })

    try {
      const assembly = stage.assemble({
        turns: [
          {
            // 参数里**自己声明**来源与只读——审批要证的正是「自报不算数」
            toolCalls: [
              {
                name: 'mcp__beta__echo',
                args: { text: '走 beta', server: 'alpha', readOnly: true },
              },
            ],
          },
          { text: '好' },
        ],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '调 beta 那台' })
      await until(() => shell.requests().length >= 1, '审批询问')

      const request = shell.requests()[0]
      // 真实来源取**注册表**：名字是 `mcp__beta__echo`，卡上就该是 `beta / echo`
      expect(request?.data.name).toBe('beta / echo')
      expect(request?.data.external).toBe(true)
      // 自报的那个 `server: 'alpha'` 与自定义的 `readOnly` 只是**参数**（照实显示、不作判据）
      expect(request?.data.material).toContain('"server": "alpha"')

      shell.answer(request?.id as number, 'approve')
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')

      // 两台服务器各数各的：调用只落在 beta 那台上
      expect(callsOf(join(dir, 'beta.jsonl')).map((call) => call.tool)).toEqual(['echo'])
      expect(callsOf(join(dir, 'alpha.jsonl'))).toEqual([])

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('服务器自报只读 / 幂等照样要问，且不给「总是允许」（记也记不上）', async () => {
    const dir = scrapDir()
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })

    try {
      // `annotated` 那件自报 `readOnlyHint: true` / `idempotentHint: true`
      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'mcp__fake__annotated', args: {} }] },
          { toolCalls: [{ name: 'mcp__fake__annotated', args: {} }] },
          { text: '好' },
        ],
      })
      await assembly.ready()

      // **一条交代里连着两轮工具调用**（脚本第 1、2 段都是同一件工具）：答了「总是允许」
      // 之后下一轮照样得问——这正是「外部操作不给长期授权」的可观察形态。
      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '跑两趟' })
      await until(() => shell.requests().length >= 1, '第一次询问')

      expect(shell.requests()[0]?.data.weight).toBe('heavy')
      // 就算答「总是允许」（脚本那条路按得到）——**权限域也不记**
      assembly.shell.send({
        type: 'decision.answer',
        id: shell.requests()[0]?.id as number,
        decision: 'approve',
        remember: true,
      })
      await until(() => shell.requests().length >= 2, '第二次询问')

      expect(shell.requests()[1]?.data.external).toBe(true)

      // 授权名录里一条都没有（外部操作不进授权账）
      expect(assembly.grantsView().grants).toEqual([])

      shell.answer(shell.requests()[1]?.id as number, 'approve')
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '两趟都跑完')

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('失败路径', () => {
  test('单连接失败不拖垮内置工具，且开屏说得出是哪一台', async () => {
    const dir = scrapDir()
    const stage = stageWith({
      good: serverEntry(dir, 'good'),
      // 拉不起来的那一台（可执行文件不存在）
      broken: { command: join(dir, '没有这个可执行文件') },
    })

    try {
      const assembly = stage.assemble({
        // ⚠️ **原锚**：`exec echo 内置照常`（判轻）；**为何变**（U76）：判轻的调用默认通、
        // **不弹卡**——这一条要的正是「卡 → 批准 → 内置件照跑」那一路；**新锚**：名单里的
        // 删除打头（必问），`内置照常` 那串输出原样留在第二段。
        turns: [
          { toolCalls: [{ name: 'exec', args: { cmd: 'chmod 755 . && echo 内置照常' } }] },
          { text: '好' },
        ],
      })
      await assembly.ready()

      // 好的那台上线、坏的那台落成不可用（各自有界）
      const views = assembly.mcpServers()
      expect(views.find((view) => view.server === 'good')?.state.status).toBe('available')
      expect(views.find((view) => view.server === 'broken')?.state.status).toBe('unavailable')

      // 开屏那几句话里点名到它（`/mcp` 那一屏归 U39，U38 至少要说得出来）
      expect(assembly.notices.join('\n')).toContain('broken')

      // 内置工具照常：这一轮 `exec` 走的是**名单里**那条（删除）——照旧问一次，
      // 批准之后就真跑（U76 起不问的只是判轻的那些）
      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '跑个内置的' })
      await until(() => shell.requests().length >= 1, '审批询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => shell.result() !== undefined, '内置工具跑完')

      expect(shell.result()?.data.ok).toBe(true)

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('超时与断连都落成「未收到结果，远端可能已执行」；取消另说', async () => {
    const dir = scrapDir()
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })

    try {
      const assembly = stage.assemble({
        // 上限调小：用例不必真等两分钟（实现级常量的装配期覆盖）
        mcpTimeouts: { callTimeoutMs: 400 },
        turns: [
          { toolCalls: [{ name: 'mcp__fake__slow', args: {} }] },
          { toolCalls: [{ name: 'mcp__fake__boom', args: {} }] },
          { text: '好' },
        ],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '先来个拖住的' })
      await until(() => shell.requests().length >= 1, '审批询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => shell.result() !== undefined, '超时落定')

      const timed = outputTextOf(shell.result())
      expect(timed).toContain('未收到结果，远端可能已执行')
      expect(timed).toContain('核对后再决定是否重试')

      // 断连：调用进去了、服务器在途没了
      await until(() => shell.requests().length >= 2, '第二次询问')
      shell.answer(shell.requests()[1]?.id as number, 'approve')
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '断连落定')

      expect(outputTextOf(eventsOfKind(shell.events, 'tool.result')[1])).toContain(
        '未收到结果，远端可能已执行',
      )

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('取消——打断在途，只报「已停止等待」；取消不等于远端撤销', async () => {
    const dir = scrapDir()
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })

    try {
      const assembly = stage.assemble({
        // 上限给足：这一条要打的是**取消**那条路，不是超时（两者落定的措辞不同）
        mcpTimeouts: { callTimeoutMs: 30_000 },
        turns: [{ toolCalls: [{ name: 'mcp__fake__slow', args: {} }] }, { text: '好' }],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '拖住的' })
      await until(() => shell.requests().length >= 1, '审批询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')

      // 调用已经在途（服务器那边数得到），此刻按中断
      await until(() => callsOf(join(dir, 'fake.jsonl')).length >= 1, '调用发出')
      assembly.shell.send({ type: 'turn.interrupt' })

      await until(() => shell.result() !== undefined, '取消落定')
      const text = outputTextOf(shell.result())

      expect(text).toContain('已取消——已停止等待')
      expect(text).toContain('取消不等于远端撤销')
      // **不假装远端撤销**：也没有「未收到结果，远端可能已执行」那套超时措辞
      expect(text).not.toContain('核对后再决定是否重试')

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('服务器中途没了：那一笔说「效果未知」，之后那一笔说「没发出去」', async () => {
    const dir = scrapDir()
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })

    try {
      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'mcp__fake__boom', args: {} }] },
          { toolCalls: [{ name: 'mcp__fake__echo', args: { text: '还调一次' } }] },
          { text: '好' },
        ],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '先把服务器弄没，再调一次' })
      await until(() => shell.requests().length >= 1, '第一次询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '第一笔落定')

      // 第一笔：调用**发出去过**，服务器在途没了 ⇒ 效果未知（要人核对）
      expect(outputTextOf(eventsOfKind(shell.events, 'tool.result')[0])).toContain(
        '未收到结果，远端可能已执行',
      )

      // 第二笔：连接已断 ⇒ **没发出去**（什么都不用核对）——两者分开报
      await until(() => shell.requests().length >= 2, '第二次询问')
      shell.answer(shell.requests()[1]?.id as number, 'approve')
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '第二笔落定')

      const second = outputTextOf(eventsOfKind(shell.events, 'tool.result')[1])
      // **原锚**「未发出——服务器未连接（…）」；**为何变**（返工 B 看帧）：这一句原来把
      // 缘由写死成「服务器未连接」，而「没发出去」还有别的来路（取消发生在发出去之前）；
      // **新锚**：说「没送出去」＋ 事实上的缘由（这里是「服务器退出了」）。
      expect(second).toContain('未发出——本次调用没有送出去（服务器退出了）')
      expect(second).not.toContain('远端可能已执行')

      // 服务器那边只数到 `boom` 那一次（第二次压根没上路）
      expect(callsOf(join(dir, 'fake.jsonl')).map((call) => call.tool)).toEqual(['boom'])

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('非文本部件明确标示（不静默丢）', async () => {
    const dir = scrapDir()
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })

    try {
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'mcp__fake__shot', args: {} }] }, { text: '好' }],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '要个图' })
      await until(() => shell.requests().length >= 1, '审批询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => shell.result() !== undefined, '结果落定')

      const text = outputTextOf(shell.result())
      expect(text).toContain('这是截图')
      expect(text).toContain('image 部件（image/png）：5 字节')
      expect(text).toContain('本版不解析这类内容，未保留')

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('接续与切换（返工 A · 独立验收问题 1）', () => {
  test('显式接续（`--session`）：恢复后**第一轮**就带着完整外部工具', async () => {
    const dir = scrapDir()
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })

    try {
      // ① 先起一条会话（新会话那一路——对照组）
      const fresh = stage.assemble({ turns: [{ text: '起个头' }] })
      await fresh.ready()
      const seeded = attachShell(fresh.shell)
      await seeded.submit('起个头')
      const session = fresh.session as string
      seeded.dispose()

      const freshTools = toolNamesOf(lastModel(stage).requests[0])
      expect(freshTools).toContain('mcp__fake__echo')

      await fresh.shutdown()
      fresh.close()

      // ② **显式接续**：`assemble({session})` 这一步就会把会话链建好（早于 `ready()`），
      //    而发现要等 `ready()` —— 工具表要是「建链那一刻的快照」，这一条就是空的
      const resumed = stage.assemble({ turns: [{ text: '接着干' }], session })
      await resumed.ready()
      await resumed.boot()

      const shell = attachShell(resumed.shell)
      await shell.submit('接着干')
      shell.dispose()

      const resumedTools = toolNamesOf(lastModel(stage).requests[0])

      // 接续的首轮与新建的首轮**能力一致**（外部那几件一件不少）
      expect(resumedTools.filter(isExternal)).toEqual(freshTools.filter(isExternal))
      expect(resumedTools.filter(isExternal).length).toBeGreaterThan(0)

      // ② 再来一次**切换会话**（单活跃那一路）：切过去的首轮同样带着
      const switched = stage.assemble({ turns: [{ text: '切过去了' }], session })
      await switched.ready()
      await switched.boot()
      const other = attachShell(switched.shell)
      await other.submit('切过去了')
      other.dispose()

      expect(toolNamesOf(lastModel(stage).requests[0]).filter(isExternal)).toEqual(
        freshTools.filter(isExternal),
      )

      await switched.shutdown()
      switched.close()
    } finally {
      stage.dispose()
    }
  })
})

/** 一趟模型请求带出去的**工具名**（没有工具表＝空表）。 */
function toolNamesOf(request: { readonly tools?: readonly { readonly name: string }[] } | undefined): readonly string[] {
  return (request?.tools ?? []).map((tool) => tool.name)
}

const isExternal = (name: string): boolean => name.startsWith('mcp__')

describe('恢复', () => {
  test('崩溃留下的那次外部调用**不自动重放**——交人裁决（服务器计数零）', async () => {
    const dir = scrapDir()
    const log = join(dir, 'fake.jsonl')
    const stage = stageWith({ fake: serverEntry(dir, 'fake') })

    try {
      // ① 起一条会话（第一条消息按下回车才开张——D5）——`attachShell` 的 `submit`
      //    **等这一轮收束**再交回，故摆现场时那一轮已经写完（不然关库会撞上在途的写）
      const first = stage.assemble({ turns: [{ text: '起个头' }] })
      await first.ready()
      const seeded = attachShell(first.shell)
      await seeded.submit('起个头')
      const session = first.session as string
      seeded.dispose()

      // ② 照崩溃的**原始数据**摆现场：有 `tool.call` 无 `tool.result` 的一次**外部调用**
      //    （已批准、未回填——用户按了 y，然后进程没了）。摆法与 `recovery.test.ts` 同款。
      const records = first.records.serviceFor(session)
      const stamp = (kind: string, data: unknown): number => {
        const id = records.nextId()
        records.appendEvent({ id, session, turn: 2, at: Date.now(), kind, data } as KernelEvent)
        return id
      }
      records.appendEntry({
        kind: 'tool-call',
        content: { text: '' },
        payload: { name: 'mcp__fake__echo', args: { text: '没跑完的那次' } },
        at: Date.now(),
      })
      stamp('turn.start', {})
      const callRef = stamp('tool.call', { name: 'mcp__fake__echo', args: { text: '没跑完的那次' } })
      stamp('tool.decision.request', {
        call: callRef,
        name: 'fake / echo',
        material: '参数：\n{\n  "text": "没跑完的那次"\n}',
        weight: 'heavy',
        external: true,
      })
      stamp('tool.decision', { call: callRef, decision: 'approve', decider: 'user', elapsedMs: 90 })
      first.close()

      // ③ 重起接续：`boot` 跑恢复那一趟（装载 ＋ 在途处置 ＋ 重建）
      const resumed = stage.assemble({ turns: [{ text: '接着干' }], session })
      await resumed.ready()
      const shell = bareShell(resumed)
      await resumed.boot()

      // **一次都没打到服务器**——「已批准」只说明有资格跑，不说明跑没跑到哪一步
      expect(callsOf(log)).toEqual([])

      await resumed.shell.send({ type: 'input.submit', text: '接着干' })
      await until(() => lastModel(stage).requests.length >= 1, '续跑那一句的模型请求')
      const messages = lastModel(stage).requests.at(-1)?.messages ?? []
      const backfill = messages.find((message) => message.role === 'tool')

      expect(backfill).toMatchObject({ name: 'mcp__fake__echo', ok: false })
      expect(
        messages.map((m) => (m.role === 'tool' ? m.output : 'content' in m ? m.content : '')).join('\n'),
      ).toContain('未自动重跑')

      shell.dispose()
      await resumed.shutdown()
      resumed.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('关闭与隔离', () => {
  test('关闭释放自有子进程；用户自己的进程仍在；密钥不进事件与模型请求', async () => {
    const dir = scrapDir()
    const sentinel = 'sk-mcp-sentinel-不能出现在任何地方'
    const stage = stageWith({ fake: serverEntry(dir, 'fake', { FAKE_MCP_TOKEN: sentinel }) })
    const log = join(dir, 'fake.jsonl')

    // **用户自己的服务**（不是本进程拉起的那个）——关闭时不许碰它
    const mine = Bun.spawn([process.execPath, FAKE_SERVER], {
      env: { ...process.env, FAKE_MCP_NAME: 'mine', FAKE_MCP_LOG: join(dir, 'mine.jsonl') },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'mcp__fake__echo', args: { text: '带密钥跑一趟' } }] }, { text: '好' }],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '调一下' })
      await until(() => shell.requests().length >= 1, '审批询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => shell.result() !== undefined, '跑完')

      const child = callsOf(log)[0]?.pid
      expect(typeof child).toBe('number')
      expect(alive(child as number)).toBe(true)

      // **密钥哨兵不出现在模型请求里**（提示词与消息都查）
      const asked = lastModel(stage).requests
      const text = JSON.stringify(asked)
      expect(text).not.toContain(sentinel)
      // 事件与开屏那几句话里也没有
      expect(JSON.stringify(shell.events)).not.toContain(sentinel)
      expect(JSON.stringify(assembly.notices)).not.toContain(sentinel)
      expect(JSON.stringify(assembly.mcpServers())).not.toContain(sentinel)

      shell.dispose()
      await assembly.shutdown()

      // 自有子进程没了；**用户自己那个还在**
      await until(() => !alive(child as number), '自有子进程退出')
      expect(alive(mine.pid)).toBe(true)

      assembly.close()
    } finally {
      mine.kill()
      stage.dispose()
    }
  })
})

/** 结果的文本（`tool.result` 的 `output` 是记录侧形态——内联才拿得到文本）。 */
function outputTextOf(event: { readonly data: { readonly output: unknown } } | undefined): string {
  const output = event?.data.output as { readonly text?: string } | undefined
  return output?.text ?? ''
}

/** 进程还在不在（`kill 0` 只探活，不发信号）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
