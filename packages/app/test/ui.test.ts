/**
 * U40 · 界面验收工具 —— **自证 ＋ 六组场景**（依据 `交接/工单/U40.md` 与 `界面验收工具`）。
 *
 * 这个文件分两半，来历不同、别混着读：
 *
 * - **上半：工具自己的判据**——工单点名要自证的几条（按键确实经 PTY 到 CLI · `wait` 查的是
 *   可见终端帧而不是历史关键词 · resize 后应用 stdout 尺寸与 VT 一致 · `capture` 不重启也
 *   不影响内容 · 失败/EOF 后自有应用与 HTTP 服务都已退出而产物仍在）。它们验的是**工具**，
 *   不是产品；
 * - **下半：六组代表场景**——`界面验收工具`「首批验收场景」那六条，走的是与产品同一条路。
 *
 * ⚠️ 用例只断言**当前已确认行为**（工单的话）：真产品有缺陷就记下来报规划侧，
 * 不放宽断言把它盖过去、也不在这里顺手改产品。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { UiWaitTimeout, createUiSession, rawBytesOf } from './ui/driver.ts'
import { SCENARIOS, runScenario } from './ui/scenarios.ts'
import type { ScenarioResult } from './ui/scenarios.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 一段「起手就回一句话」的剧本——多数用例只要链子走通。 */
const HELLO = [{ kind: 'text', text: '收到，我在。' }] as const

/**
 * 剥掉 CSI / OSC 转义序列——只为在**原始字节**里认那几段字。
 *
 * 为什么需要它：带样式的字在字节里是被色码**切开**的（实测：`会话在` ＋ `[1m` ＋
 * `你按下第一次回车` ＋ `[22m` ＋ `时才建立。`），不剥就匹配不上整句。
 * 这一份是本文件里的**最小**一份（仓里既有的取景层在 tui 侧；跨包相对引用会被
 * `test/scaffold.test.ts` 的边界守护拦下，理由与 `ui/vt.ts` 头注同）。
 */
function plain(bytes: string): string {
  return bytes
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9:;<=>?]*[@-~]/g, '')
}

describe('U40 · 工具自证', () => {
  test('按键经真 PTY 到 CLI：敲进去的字，既能上屏、也能到模型请求里', async () => {
    const session = await createUiSession({ label: '自证-按键经PTY', turns: HELLO })

    try {
      await session.send('你好')
      // 屏上出现草稿 ＝ 字节经 PTY 落到了 Ink 的输入行
      await session.wait({ text: '› 你好' })
      const draft = await session.capture({ label: '草稿' })
      expect(draft.text).toContain('你好')

      await session.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 4_000 })

      const sent = await session.capture({ label: '回话' })
      // 记录区里那一行「› 你好」＝ 应用自己把这次交代记下了（不是我们这头记的）
      expect(sent.text).toContain('› 你好')
    } finally {
      await session.close()
    }

    // 真模型请求里那条 user 正文，就是我们**经 PTY** 敲进去的那句话——
    // 「按键真到了 CLI」这条链一路到模型域，中途没有一处是我们这头代填的
    const requests = session.requests()
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.at(-1)?.lastUser).toBe('你好')
  }, 30_000)

  test('`wait` 只查可见屏：滚进 scrollback 的字，屏上没有就算没等到', async () => {
    // 窄屏（10 行）＋ 两轮真回话：起手那几句一定会被顶进存档区
    const session = await createUiSession({
      label: '自证-只查可见屏',
      columns: 100,
      rows: 10,
      turns: [
        { kind: 'text', text: '第一答' },
        { kind: 'text', text: '第二答' },
      ],
    })

    try {
      for (const [ask, answer] of [['甲', '第一答'], ['乙', '第二答']] as const) {
        await session.send(ask)
        await session.wait({ text: `› ${ask}` })
        await session.key('enter', { until: { text: answer }, timeoutMs: 4_000 })
      }

      // 目标字：起手时的空态引导语。它此刻只可能在**历史**里，可见屏上早已没有
      const needle = '会话在你按下第一次回车时才建立'
      expect(plain(rawBytesOf(session.runDir))).toContain(needle)

      const screen = await session.screen()
      expect(screen.lines.some((line) => line.text.includes(needle))).toBe(false)
      expect(screen.scrollback).toBeGreaterThan(0) // 确实滚出去了，不是从没出现过

      // 所以：等它＝等到超时（**有界**，且给的是结构化失败）
      let failure: unknown
      try {
        await session.wait({ text: needle }, { timeoutMs: 600 })
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(UiWaitTimeout)
      const timeout = failure as UiWaitTimeout
      expect(timeout.condition).toEqual({ text: needle })
      expect(timeout.screen.join('\n')).not.toContain(needle)
      // 失败现场是**当场落的**：那一步的帧文件里就有「最后屏幕」
      expect(existsSync(join(timeout.runDir, 'frames'))).toBe(true)
    } finally {
      await session.close()
    }
  }, 40_000)

  test('resize 三件同序：子进程 stdout 的尺寸与 VT 一致（只调 resize 不补 SIGWINCH 就不刷新）', async () => {
    // 探针子进程：一收到 WINCH 就把自己看到的 stdout 尺寸报出来
    const probe = [
      process.execPath,
      '-e',
      [
        // ⚠️ **先写一次、再挂 SIGWINCH**——次序不是洁癖：Bun 的尺寸读数由它**自己那个**
        // SIGWINCH 处理刷（随第一次写 stdout 装上的），故先注册的那个处理器会读到**旧值**
        // （实测：先挂登记、后写，改窗之后它照样报 100）。
        'const say = () => process.stdout.write("SIZE " + process.stdout.columns + "x" + process.stdout.rows + "\\n")',
        'say()',
        'process.on("SIGWINCH", say)',
        'setInterval(() => {}, 1000)',
      ].join(';'),
    ]

    const session = await createUiSession({ label: '自证-resize尺寸', command: probe, columns: 100, rows: 30 })
    try {
      await session.wait({ text: 'SIZE 100x30' })
      await session.resize(72, 20)

      // 子进程**自己说**它现在看到的尺寸——与 VT 报的（driver 交给它的）对得上才算数
      await session.wait({ text: 'SIZE 72x20' })

      const screen = await session.screen()
      expect(screen.columns).toBe(72)
      expect(screen.rows).toBe(20)
      expect((await session.capture({ label: '改窗之后' })).lines.join('\n')).toContain('SIZE 72x20')
    } finally {
      await session.close()
    }
  }, 40_000)

  test('`capture` 只观察：不重启（同一 PID）、不改内容、之后还能接着敲', async () => {
    const session = await createUiSession({ label: '自证-取帧不扰', turns: HELLO })

    try {
      const pid = session.pid
      await session.send('甲')
      await session.wait({ text: '› 甲' })

      const before = await session.capture({ label: '之前' })
      const again = await session.capture({ label: '再来一次' })

      expect(session.pid).toBe(pid)
      expect(again.lines.join('\n')).toBe(before.lines.join('\n'))
      expect(again.cursor).toEqual(before.cursor)

      // 现场还在：接着敲、接着发（capture 没有把它停掉或重启）
      await session.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 4_000 })
      expect(session.pid).toBe(pid)
    } finally {
      await session.close()
    }
  }, 40_000)

  test('收摊：自有应用与 HTTP 端点都已退出，产物仍在', async () => {
    const session = await createUiSession({ label: '自证-清场', turns: HELLO })
    const runDir = session.runDir

    await session.send('清场')
    await session.wait({ text: '› 清场' })
    await session.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 4_000 })

    const report = await session.close()

    // 应用：进程没了（`kill(pid, 0)` 抛 ＝ 确实不在了）
    expect(() => process.kill(session.pid, 0)).toThrow()

    // 端点：连不上了（端口真释放）
    const fixture = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as {
      fixture: { port: number } | null
    }
    expect(fixture.fixture).not.toBeNull()
    await expect(
      fetch(`http://127.0.0.1:${(fixture.fixture as { port: number }).port}/v1/models`),
    ).rejects.toBeDefined()

    // 产物：五件都在
    expect(existsSync(join(runDir, 'run.json'))).toBe(true)
    expect(existsSync(join(runDir, 'steps.ndjson'))).toBe(true)
    expect(existsSync(join(runDir, 'raw.bin'))).toBe(true)
    expect(existsSync(report.viewer)).toBe(true)
    expect(existsSync(join(runDir, 'sandbox', 'records.db'))).toBe(true)
  }, 30_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 六组代表场景 —— 判据写在 `ui/scenarios.ts`，这里只负责「跑 + 记账」
// ═══════════════════════════════════════════════════════════════════════

describe('U40 · 六组代表场景（`界面验收工具`·首批验收场景）', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.name} · ${scenario.title}`, async () => {
      const result = await runScenario(scenario.name)

      // 挂了就把**判据名 + 最后那一眼**打出来——比一句「ok 是 false」有用得多
      expect(failureLine(result)).toBeNull()
      expect(result.checks.length).toBeGreaterThan(0)
      expect(result.checks.every((check) => check.ok)).toBe(true)
      expect(result.runDirs.length).toBeGreaterThan(0)
    }, 300_000)
  }
})

/** 失败的一句话（过了＝`null`）——把判据名、缘由、最后屏幕一并带上。 */
function failureLine(result: ScenarioResult): string | null {
  if (result.ok) return null

  const screen = (result.lastScreen ?? []).join('\n')
  return `${result.name} 挂在「${result.failure?.what}」：${result.failure?.detail}\n最后一眼：\n${screen}`
}

// ═══════════════════════════════════════════════════════════════════════
// 助手那条入口 —— **跨多次独立进程调用**（不是同一个进程里连点六下）
// ═══════════════════════════════════════════════════════════════════════

describe('U40 · 助手入口（常驻控制进程 ＋ 薄客户端）', () => {
  test('跨多次独立调用操作同一实例；close 与 EOF 两条都清场', async () => {
    const dir = tempDir('magic-u40-ctl-')
    const serve = Bun.spawn(
      [process.execPath, 'packages/app/scripts/ui.ts', 'serve', '--control', dir, '--out', join(dir, 'runs')],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    )

    try {
      await untilExists(join(dir, 'in.fifo'), 15_000)

      // —— 每一步都是一次**独立的进程调用**（助手就是这么用的） ——
      const started = await request(dir, {
        cmd: 'start',
        label: '助手-一现场',
        cols: 100,
        rows: 24,
        turns: [{ kind: 'text', text: '助手答' }],
      })
      expect(started.ok).toBe(true)
      const pid = started['pid'] as number

      const sent = await request(dir, { cmd: 'send', text: '第一件' })
      expect(sent.ok).toBe(true)
      await request(dir, { cmd: 'wait', condition: { text: '› 第一件' }, timeoutMs: 5_000 })
      await request(dir, { cmd: 'key', key: 'enter' })
      const waited = await request(dir, { cmd: 'wait', condition: { text: '助手答' }, timeoutMs: 8_000 })
      expect(waited.ok).toBe(true)

      const shot = await request(dir, { cmd: 'capture', label: '第一次取帧' })
      expect(shot.ok).toBe(true)
      expect(shot['pid']).toBe(pid) // 同一个进程——跨调用现场保持
      const frame = shot['frame'] as { lines: readonly string[] }
      expect(frame.lines.join('\n')).toContain('助手答')

      const resized = await request(dir, { cmd: 'resize', columns: 70, rows: 18 })
      expect(resized.ok).toBe(true)
      expect(resized['columns']).toBe(70)

      const second = await request(dir, { cmd: 'send', text: '第二件' })
      expect(second.ok).toBe(true)
      await request(dir, { cmd: 'wait', condition: { text: '› 第二件' }, timeoutMs: 5_000 })

      // 未支持的键**明确报错**，不悄悄换一种按键（工单的话）
      const bogus = await request(dir, { cmd: 'key', key: 'f13' })
      expect(bogus.ok).toBe(false)
      expect((bogus.error as { kind: string }).kind).toBe('bad-request')

      // 等一件永远不来的东西：**结构化失败**，且**现场还在**（会话不退场）
      const timeout = await request(dir, { cmd: 'wait', condition: { text: '永远不来' }, timeoutMs: 700 })
      expect(timeout.ok).toBe(false)
      expect((timeout.error as { kind: string }).kind).toBe('timeout')
      expect((timeout.error as { screen: readonly string[] }).screen.length).toBeGreaterThan(0)

      // 超时之后照样能接着使唤（单条失败不掀桌子）
      const after = await request(dir, { cmd: 'capture', label: '超时之后' })
      expect(after.ok).toBe(true)
      expect(after['pid']).toBe(pid)

      // —— close 清场 ——
      const closed = await request(dir, { cmd: 'close' })
      expect(closed.ok).toBe(true)
      expect(closed['exit']).toBeDefined()
      expect(() => process.kill(pid, 0)).toThrow()
      expect(existsSync(closed['viewer'] as string)).toBe(true)
    } finally {
      serve.kill()
      await serve.exited.catch(() => {})
      removeDir(dir)
    }
  }, 90_000)

  test('控制通道 EOF：收摊走人，自起的应用一个不留', async () => {
    const dir = tempDir('magic-u40-eof-')
    const serve = Bun.spawn(
      [process.execPath, 'packages/app/scripts/ui.ts', 'serve', '--out', join(dir, 'runs')],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    )

    try {
      const lines = readerOf(serve.stdout)
      serve.stdin.write(`${JSON.stringify({ id: 1, cmd: 'start', label: '助手-EOF', turns: [] })}\n`)
      const started = await lines.next(20_000)
      expect((started as { ok: boolean }).ok).toBe(true)
      const pid = (started as { pid: number }).pid

      // 管道这一头一关：**EOF 就是收摊信号**
      serve.stdin.end()
      const code = await Promise.race([serve.exited, Bun.sleep(15_000).then(() => 'stuck')])
      expect(code).toBe(0)
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      serve.kill()
      await serve.exited.catch(() => {})
      removeDir(dir)
    }
  }, 90_000)
})

/** 薄客户端：像助手那样——**另起一个进程**发一条命令，等答复。 */
async function request(dir: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(
    [process.execPath, 'packages/app/scripts/ui.ts', 'request', '--control', dir, JSON.stringify(command)],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  const line = out.trim().split('\n').at(-1) ?? ''
  expect(line, `薄客户端没有输出答复（退出码 ${code}）`).not.toBe('')

  return JSON.parse(line) as Record<string, unknown>
}

/** 一行一行读（控制通道是逐行 JSON）。 */
function readerOf(stream: ReadableStream<Uint8Array>): { next: (timeoutMs: number) => Promise<unknown> } {
  const decoder = new TextDecoder()
  let buffered = ''
  const queue: unknown[] = []
  // 等着的那几个（通常就一个）——用一组 resolver，不用一个可变槽：
  // 变量槽会在闭包里被 TS 收窄成 `never`（实测），而这一层本来就只是「叫醒等着的人」
  const waiters: (() => void)[] = []

  void (async () => {
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk as Uint8Array, { stream: true })
      let at = buffered.indexOf('\n')
      while (at !== -1) {
        const line = buffered.slice(0, at).trim()
        buffered = buffered.slice(at + 1)
        if (line !== '') queue.push(JSON.parse(line))
        at = buffered.indexOf('\n')
      }
      for (const waiter of waiters.splice(0)) waiter()
    }
  })()

  return {
    next: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      while (queue.length === 0) {
        if (Date.now() > deadline) throw new Error('等控制通道的答复超时')
        await Promise.race([new Promise<void>((done) => waiters.push(done)), Bun.sleep(50)])
      }

      return queue.shift()
    },
  }
}

async function untilExists(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等不到文件：${path}`)
    await Bun.sleep(50)
  }
}
