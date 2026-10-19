import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { UiWaitTimeout, createUiSession, rawBytesOf, type UiSession } from './ui/driver.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import { hostDiscoveryPath } from '../src/run/host-discovery.ts'
import type { HostDiscovery } from '@magic/contracts'
import { createSandbox } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'
import { createControl } from './ui/control.ts'

import { removeDir, tempDir } from './tmp.ts'

let artifacts: string
beforeEach(() => { artifacts = tempDir('magic-ui-test-') })
afterEach(() => { removeDir(artifacts) })

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

describe('工具自证', () => {
  test('按键经真 PTY 到 CLI：敲进去的字，既能上屏、也能到模型请求里', async () => {
    const session = await createUiSession({ artifacts, label: '自证-按键经PTY', turns: HELLO })

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
    // 主规格下用长回话把起手字标推入滚动区，不依赖小窗口。
    const session = await createUiSession({ artifacts,
      label: '自证-只查可见屏',
      columns: 100,
      rows: 40,
      turns: [
        { kind: 'text', text: Array.from({ length: 60 }, (_, i) => `第一答 ${i + 1}`).join('\n') },
        { kind: 'text', text: Array.from({ length: 60 }, (_, i) => `第二答 ${i + 1}`).join('\n') },
      ],
    })

    try {
      for (const [ask, answer] of [['甲', '第一答'], ['乙', '第二答']] as const) {
        await session.send(ask)
        await session.wait({ text: `› ${ask}` })
        await session.key('enter', { until: { text: answer }, timeoutMs: 4_000 })
      }

      // 目标字：开机那块**字标**（100 列 ＝ 块字版，起手就印在屏上）。
      // ⚠️ **换过一次取材**（U31 三轮）：原锚用的是起手那句空态引导语——那句已由用户定删
      //    （没有动作价值，原型早已删掉）。字标是这一屏上现在**唯一**起手就有、又一定会被
      //    两轮真回话顶进存档区的东西 ⇒ 判据（「`wait` 只查可见屏」）一个字没变。
      const needle = '█   █  ███'
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

  test('`capture` 只观察：不重启（同一 PID）、不改内容、之后还能接着敲', async () => {
    const session = await createUiSession({ artifacts, label: '自证-取帧不扰', turns: HELLO })

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
    const session = await createUiSession({ artifacts, label: '自证-清场', turns: HELLO })
    const runDir = session.runDir

    await session.send('清场')
    await session.wait({ text: '› 清场' })
    await session.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 4_000 })

    const report = await session.close()

    // 应用：进程没了（`kill(pid, 0)` 抛 ＝ 确实不在了）
    expect(() => process.kill(session.pid, 0)).toThrow()
    const host = JSON.parse(readFileSync(join(runDir, 'host/host.json'), 'utf8')) as { pid: number; code: number; state: HostDiscovery }
    expect(host.code).toBe(0)
    expect(host.state.state === 'stopped').toBe(true)
    expect(() => process.kill(host.pid, 0)).toThrow()
    expect(existsSync(session.facts().home)).toBe(false)

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

describe('常驻测试宿主的归属', () => {
  // ⚠️ 标题原为「…最后一窗才核销」——那是**旧口径**（U109 按归属改判后不再是它）。
  // 改成说清**谁**核销，免得标题与下面那段判据打架。
  test('同一外借沙地的并发窗口共用一个自有宿主，核销落在沙地的主人收摊那一拍', async () => {
    const runs = tempDir('magic-u40-host-share-')
    const fixture = startFixture({ turns: HELLO })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const windows: UiSession[] = []
    try {
      const results = await Promise.allSettled([
        createUiSession({ label: '宿主共享甲', artifacts: runs, sandbox, fixture }).then((window) => { windows.push(window); return window }),
        createUiSession({ label: '宿主共享乙', artifacts: runs, sandbox, fixture }).then((window) => { windows.push(window); return window }),
      ])
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      const opened = results.map((result) => (result as PromiseFulfilledResult<UiSession>).value)
      const [first, second] = opened as [UiSession, UiSession]
      const hostPid = stepsOf(first.runDir).find((step) => step['action'] === 'host-acquired')?.['pid'] as number
      expect(Number.isInteger(hostPid)).toBe(true)
      expect(stepsOf(second.runDir).find((step) => step['action'] === 'host-acquired')?.['pid']).toBe(hostPid)
      expect(fixture.requests()).toHaveLength(0)
      await first.close()
      windows.splice(windows.indexOf(first), 1)
      expect(() => process.kill(hostPid, 0)).not.toThrow()
      await second.send('共享宿主仍可使用', { until: { text: '共享宿主仍可使用' } })
      await second.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 4_000 })
      expect(fixture.requests()).toHaveLength(1)
      await second.close()
      windows.splice(windows.indexOf(second), 1)
      // **原预期 → 新预期**（U109 · 断言点搬家，不是放宽）：原来是「最后一扇窗 `close()`
      // ⇒ 共享宿主当场核销」（两条判据都量在**这一拍**上）；现在是**归属说了算**——
      // 这块沙地是**用例自己造的**（外借给窗口），宿主便归**沙地的主人**，窗口收摊**只释放
      // 自己那一份**，核销落在主人的 `dispose()` 上。依据：`设计/会话与运行管理`「选择转后台、
      // 直接关终端或终端输入断流，**只释放该客户端**；明确的停止操作才中断工作」＋
      // `driver.ts` 的 `useHost` 那段注（与 main 的 `run-terminal` 接回用例同一条）。
      //
      // **没变弱**：两条硬判据（真进程探活 `kill(pid,0)`、真文件探存 `host.json` 在不在）
      // 一条没少，只是**各量两次**——主人收摊前量一次（不许提前核销），收摊后量一次
      // （必须真核销）。两扇窗都关了宿主还活着，正是「转后台」（窗口走了、工作还在宿主里）
      // 那条路要的形状。
      expect(() => process.kill(hostPid, 0)).not.toThrow()
      expect(existsSync(hostDiscoveryPath(sandbox.home))).toBe(true)
      // 主人收摊 ⇒ **这一刻才核销**
      await sandbox.dispose()
      expect(() => process.kill(hostPid, 0)).toThrow()
      expect(existsSync(hostDiscoveryPath(sandbox.home))).toBe(false)
      expect(opened.filter((window) => existsSync(join(window.runDir, 'host/host.json')))).toHaveLength(1)
      expect(existsSync(sandbox.root)).toBe(false)
    } finally {
      for (const window of windows) await window.close()
      await fixture.stop()
      await sandbox.dispose()
      removeDir(runs)
    }
  }, 30_000)

  test('已有明确 owner 的宿主只连接，窗口关闭不替 owner 停宿主', async () => {
    const runs = tempDir('magic-u40-host-borrow-')
    const fixture = startFixture({ turns: HELLO })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const host = await startResidentHost(sandbox, join(runs, 'owner'))
    let window: UiSession | undefined
    try {
      const discovery = readFileSync(hostDiscoveryPath(sandbox.home), 'utf8')
      window = await createUiSession({ label: '借用明确宿主', artifacts: runs, sandbox, fixture })
      expect(readFileSync(hostDiscoveryPath(sandbox.home), 'utf8')).toBe(discovery)
      expect(stepsOf(window.runDir).some((step) => step['action'] === 'host-acquired')).toBe(false)
      expect(existsSync(join(window.runDir, 'host'))).toBe(false)
      expect(host.executorStarts()).toBe(0)
      await window.close()
      window = undefined
      expect(() => process.kill(host.pid, 0)).not.toThrow()
      expect(fixture.requests()).toHaveLength(0)
      await host.close()
      expect(() => process.kill(host.pid, 0)).toThrow()
    } finally {
      try { await window?.close() } finally {
        try { await host.close() } finally { await fixture.stop(); await sandbox.dispose() }
      }
      removeDir(runs)
    }
  }, 30_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 退回四条（U40-2）—— 每条都是首轮验收**实测踩出来的**真故障，各留一个回归
// ═══════════════════════════════════════════════════════════════════════

describe('-2 · 退回的四处回归', () => {
  test('写一次就是一次：`until` 只等待，不重放（超时留档，不重发动作）', async () => {
    const session = await createUiSession({ artifacts, label: '回归-只写一次', turns: HELLO })

    try {
      let failure: unknown
      try {
        // 等一句**永远不来**的话：驱动只该写一遍「甲」，然后**超时留档**
        await session.send('甲', { until: { text: '这句话永远不会有' }, timeoutMs: 500 })
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(UiWaitTimeout)
      // ⚠️ 三个「甲」＝ 重发的物证（首轮验收就是这么看见 `XXX` 的）
      const draft = await session.capture({ label: '超时之后' })
      expect(draft.text).toContain('甲')
      expect(draft.text).not.toContain('甲甲')

      // 时间线上也只该有**一次** send——重发会连着留下好几次
      const sends = stepsOf(session.runDir).filter(
        (step) => step['action'] === 'send' && step['text'] === '甲',
      )
      expect(sends.length).toBe(1)
    } finally {
      await session.close()
    }
  }, 40_000)

  test('回包写的是解析出来的那个会话（双实例里显式写号不许串）', async () => {
    const control = createControl({ artifacts, log: () => {} })

    try {
      const first = await control.handle(JSON.stringify({ id: 1, cmd: 'start', label: '回归-实例甲' }))
      const second = await control.handle(JSON.stringify({ id: 2, cmd: 'start', label: '回归-实例乙' }))
      expect(reply(first)['session']).toBe('s1')
      expect(reply(second)['session']).toBe('s2')
      const pidOfFirst = reply(first)['pid'] as number
      const pidOfSecond = reply(second)['pid'] as number
      expect(pidOfFirst).not.toBe(pidOfSecond)

      // 显式写号：答复的 session 与 pid 都得是**那一个**（首轮实测写成当前那个，pid 却是它）
      const shot = await control.handle(JSON.stringify({ id: 3, cmd: 'capture', session: 's1', label: '问甲' }))
      expect(reply(shot)['session']).toBe('s1')
      expect(reply(shot)['pid']).toBe(pidOfFirst)

      const sent = await control.handle(JSON.stringify({ id: 4, cmd: 'send', session: 's1', text: '甲' }))
      expect(reply(sent)['session']).toBe('s1')
      expect(reply(sent)['pid']).toBe(pidOfFirst)

      const sized = await control.handle(JSON.stringify({ id: 5, cmd: 'resize', session: 's1', columns: 100, rows: 40 }))
      expect(reply(sized)['session']).toBe('s1')

      // 没写号＝当前那个（最后起的那个），不是随机的另一个
      const current = await control.handle(JSON.stringify({ id: 6, cmd: 'capture', label: '不问号' }))
      expect(reply(current)['session']).toBe('s2')
      expect(reply(current)['pid']).toBe(pidOfSecond)
    } finally {
      await control.closeAll()
    }
  }, 60_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 看帧补正（U40-2）—— 光标显隐取样 ＋ 查看页翻帧
// ═══════════════════════════════════════════════════════════════════════

describe('-2 · 光标显隐与翻帧', () => {

  test('真应用那一趟：跑的时候光标**显示在编辑位置上**（不是藏着）', async () => {
    const session = await createUiSession({ artifacts, label: '回归-真应用光标', turns: HELLO })

    try {
      // ⚠️ **换过锚的断言**（U31 三轮 · 规划侧把这一处划给真光标那一单）。
      //
      // - **原锚**：`expect(live.cursor.hidden).toBe(true)`——「跑着的时候光标是藏着的」。
      //   那会儿产品起手就把终端光标藏了、另画一个**反色空格**冒充分身，这一条量的是
      //   **那个冒充**：跑起来之后终端光标**永远**不出现在任何位置上。
      // - **为何变**：U31 起**真光标就是插入点的提示**（`useCursor` ＋ `measureElement`，
      //   反色那一格已删）——「产品在跑」与「光标藏着」不再是一回事：**编辑位置上是显示着的**，
      //   只有**裁决 / 选择接管**那几屏才藏（接管期间打不进草稿，没有插入点可指；见
      //   `composer-editing.test.ts` 的「裁决接管中」，以及归还之后**回到原插入点**那一条）。
      //   旧的隐藏形态本身就是那一单要收掉的缺陷，故**不保留**（留它就是把缺陷冻成判据）。
      // - **新锚**：跑着的时候光标**显示着**，而且**就在输入行上**——它指向的位置就是插入点
      //   （左留白 1 ＋ `› ` 2 ＝ 第 3 列）。
      const live = await session.capture({ label: '应用中' })
      const inputRow = live.lines.findIndex((line) => line.includes('› 交代一件事，回车发送'))

      expect(inputRow).toBeGreaterThanOrEqual(0) // 输入行在屏上（这一帧才有得量）
      expect(live.cursor.hidden).toBe(false) // 显示着——不是藏着的
      expect(live.cursor.y).toBe(inputRow) // **编辑位置**那一行（不是帧末的回退位）
      expect(live.cursor.x).toBe(3) // 左留白 1 ＋ `› ` 2

      // ⚠️ **「退出时终端把它还回来」那半截随旧锚一起去掉**：光标跑的时候就一直显示着，
      //    那里已经没有「藏 → 显」这一翻（留着是恒真的空转）。应用的起手与收尾另有
      //    「`失败/EOF` 后自有应用与 HTTP 服务都已退出而产物仍在」那几条看着；接管中退出
      //    该不该还回来归产品，不靠这一条钉。
      //
      // 收摊照产品的方式走：空闲**按两次** `ctrl+c`（U46）——`quit()` 就是那一套
      await session.quit()
    } finally {
      await session.close({ graceMs: 2_000 })
    }
  }, 40_000)
})

/** 一行答复 → 对象（这三种用例只读几个字段）。 */
function reply(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

/** 一趟运行的时间线（`steps.ndjson` 逐行）。 */
function stepsOf(runDir: string): Record<string, unknown>[] {
  return readFileSync(join(runDir, 'steps.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// ═══════════════════════════════════════════════════════════════════════
// 助手那条入口 —— **跨多次独立进程调用**（不是同一个进程里连点六下）
// ═══════════════════════════════════════════════════════════════════════

describe('助手入口（常驻控制进程 · stdin ←→ stdout 逐行 JSON）', () => {
  test('跨多次写操作同一实例（同一 PID、现场保持）；close 清场', async () => {
    const dir = tempDir('magic-u40-ctl-')
    const serve = Bun.spawn(
      [process.execPath, 'packages/app/scripts/ui.ts', 'serve', '--out', join(dir, 'runs')],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    )
    const lines = readerOf(serve.stdout)

    try {
      // —— 每一次 write 就是助手的一次工具调用：**stdin 一直开着**，进程自始至终是那个 ——
      const started = await call(serve, lines, {
        id: 1,
        cmd: 'start',
        label: '助手-一现场',
        cols: 100,
        rows: 40,
        turns: [{ kind: 'text', text: '助手答' }],
      })
      expect(started['ok']).toBe(true)
      const pid = started['pid'] as number

      expect((await call(serve, lines, { id: 2, cmd: 'send', text: '第一件' }))['ok']).toBe(true)
      await call(serve, lines, { id: 3, cmd: 'wait', condition: { text: '› 第一件' }, timeoutMs: 5_000 })
      await call(serve, lines, { id: 4, cmd: 'key', key: 'enter' })
      const waited = await call(serve, lines, { id: 5, cmd: 'wait', condition: { text: '助手答' }, timeoutMs: 8_000 })
      expect(waited['ok']).toBe(true)

      const shot = await call(serve, lines, { id: 6, cmd: 'capture', label: '第一次取帧' })
      expect(shot['ok']).toBe(true)
      expect(shot['pid']).toBe(pid) // 同一个进程——跨调用现场保持
      const frame = shot['frame'] as { lines: readonly string[] }
      expect(frame.lines.join('\n')).toContain('助手答')

      const resized = await call(serve, lines, { id: 7, cmd: 'resize', columns: 100, rows: 40 })
      expect(resized['ok']).toBe(true)
      expect(resized['columns']).toBe(100)

      expect((await call(serve, lines, { id: 8, cmd: 'send', text: '第二件' }))['ok']).toBe(true)
      await call(serve, lines, { id: 9, cmd: 'wait', condition: { text: '› 第二件' }, timeoutMs: 5_000 })

      // 未支持的键**明确报错**，不悄悄换一种按键（工单的话）
      const bogus = await call(serve, lines, { id: 10, cmd: 'key', key: 'f13' })
      expect(bogus['ok']).toBe(false)
      expect((bogus['error'] as { kind: string }).kind).toBe('bad-request')

      // 等一件永远不来的东西：**结构化失败**，且**现场还在**（会话不退场）
      const timeout = await call(serve, lines, { id: 11, cmd: 'wait', condition: { text: '永远不来' }, timeoutMs: 700 })
      expect(timeout['ok']).toBe(false)
      expect((timeout['error'] as { kind: string }).kind).toBe('timeout')
      expect((timeout['error'] as { screen: readonly string[] }).screen.length).toBeGreaterThan(0)

      // 超时之后照样能接着使唤（单条失败不掀桌子），而且还是**同一只**
      const after = await call(serve, lines, { id: 12, cmd: 'capture', label: '超时之后' })
      expect(after['ok']).toBe(true)
      expect(after['pid']).toBe(pid)

      // —— close 清场 ——
      const closed = await call(serve, lines, { id: 13, cmd: 'close' })
      expect(closed['ok']).toBe(true)
      expect(closed['exit']).toBeDefined()
      expect(() => process.kill(pid, 0)).toThrow()
      expect(existsSync(closed['viewer'] as string)).toBe(true)
    } finally {
      serve.kill()
      await serve.exited.catch(() => {})
      removeDir(dir)
    }
  }, 90_000)

  test('SIGTERM：收摊走人，常驻进程自己退场（不留孤儿、不吊在那儿）', async () => {
    const dir = tempDir('magic-u40-term-')
    const serve = Bun.spawn(
      [process.execPath, 'packages/app/scripts/ui.ts', 'serve', '--out', join(dir, 'runs')],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    )

    try {
      const lines = readerOf(serve.stdout)
      const started = await call(serve, lines, { id: 1, cmd: 'start', label: '助手-SIGTERM', turns: [] })
      expect(started['ok']).toBe(true)
      const pid = started['pid'] as number

      // ⚠️ 这一条守的是「挂了信号处理器之后信号不再自己杀进程」那个坑：主流程堵在 stdin 的读上，
      // 信号那条路必须**自己 exit**——不然进程不死，助手那边 `kill` 完就干等着
      serve.kill('SIGTERM')
      const code = await Promise.race([serve.exited, Bun.sleep(15_000).then(() => 'stuck')])
      expect(code).toBe(0)
      expect(() => process.kill(pid, 0)).toThrow()
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
      const started = await call(serve, lines, { id: 1, cmd: 'start', label: '助手-EOF', turns: [] })
      expect(started['ok']).toBe(true)
      const pid = started['pid'] as number

      // 管道这一头一关：**EOF 就是收摊信号**（TTY 那条路上的 Ctrl-D 同理）
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

// ═══════════════════════════════════════════════════════════════════════
// D26 · 断流退出与清场（P0）—— 「终端没了」与「控制端没了」各留一个回归
// ═══════════════════════════════════════════════════════════════════════

describe('D26 · 断流退出与清场', () => {
  test('终端被抽掉（关窗口）——应用**自己**退出，不是我们杀的', async () => {
    const session = await createUiSession({ artifacts, label: 'D26-抽掉终端', turns: [] })
    let report: Awaited<ReturnType<typeof session.close>> | undefined

    try {
      // 等「放开输入」那一句（起手那道闸放开了＝这是**真实空闲态**，
      // 不是「启动中」那一段——两条路的收场理由不同，别测错对象）
      await session.wait({ text: 'ctrl+c 退出' })

      // **只关 PTY master**：不发任何信号。终端窗口关了就是这个形状。
      session.dropTerminal()

      // 宽限期内它自己走 ⇒ `by === 'app'`；到点还没走就成 'sigterm'（那条断言当场红）
      report = await session.close({ graceMs: 5_000 })
      expect(report.exit.by).toBe('app')
      // 干净退出（不是被信号带走、也不是非零码）
      expect(report.exit.code).toBe(0)
    } finally {
      report ??= await session.close().catch(() => undefined)
    }
  }, 60_000)

  test('收摊重入：第二路进来也要**等收完**，不许把「已开始」当「已完成」', async () => {
    const dir = tempDir('magic-d26-reentry-')
    const serve = Bun.spawn(
      [process.execPath, 'packages/app/scripts/ui.ts', 'serve', '--out', join(dir, 'runs')],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    )

    try {
      const lines = readerOf(serve.stdout)
      const started = await call(serve, lines, { id: 1, cmd: 'start', label: 'D26-重入', turns: [] })
      expect(started['ok']).toBe(true)
      const runDir = started['runDir'] as string

      // 第一路：EOF —— 收摊**开始**了，但 `closeAll` 还在跑（关一个会话要发信号、等它退）
      serve.stdin.end()
      await Bun.sleep(50)
      // 第二路：信号。旧写法里那个 `closed` 布尔只记「开始了」，这一路会**当场 resolve**，
      // 调用方的 `then(() => process.exit(0))` 就抢在 `closeAll` 前头退场——
      // 应用半途没人管，产物也停在半截
      serve.kill('SIGTERM')

      const code = await Promise.race([serve.exited, Bun.sleep(15_000).then(() => 'stuck')])
      expect(code).not.toBe('stuck')

      // 判据取**产物**而不是进程在不在：serve 一退，应用的 PTY master 也跟着没了，
      // 应用会被断流带走——「它没了」分不清是「收摊收的」还是「断流带的」。
      // `outcome` 只由 `close()` 走到最后那一步写（`artifacts.finish('closed')`），
      // 半途退场就停在 `running`。
      const info = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as {
        outcome: string
        exit?: { by: string }
      }
      expect(info.outcome).toBe('closed')
    } finally {
      serve.kill()
      await serve.exited.catch(() => {})
      removeDir(dir)
    }
  }, 90_000)

  test('控制端 stdout 断了——serve 收摊退场，自起的应用一个不留', async () => {
    const dir = tempDir('magic-d26-pipe-')
    const serve = Bun.spawn(
      [process.execPath, 'packages/app/scripts/ui.ts', 'serve', '--out', join(dir, 'runs')],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    )

    try {
      const lines = readerOf(serve.stdout)
      const started = await call(serve, lines, { id: 1, cmd: 'start', label: 'D26-断管', turns: [] })
      expect(started['ok']).toBe(true)
      const pid = started['pid'] as number

      // 控制端把**读答复的那一头**关掉（助手进程没了就是这个形状）：
      // 再写一句答复当场 EPIPE —— 那条路原先会把整条链带进 rejected，
      // 收摊那一步 `closeAll` 被跳过，应用就留在了机器上
      lines.stop()
      await Bun.sleep(100)
      serve.stdin.write(`${JSON.stringify({ id: 2, cmd: 'sessions' })}\n`)
      serve.stdin.flush()
      await Bun.sleep(100)
      // 收尾**已经开始**了：这一条不该再被受理——受理了就会晚于 `closeAll` 落地，
      // 而 `start` 会在那之后建起一个**没人再收**的会话（这条链已经不在收尾的视野里）
      serve.stdin.write(`${JSON.stringify({ id: 3, cmd: 'start', label: 'D26-晚到' })}\n`)
      serve.stdin.flush()

      const code = await Promise.race([serve.exited, Bun.sleep(15_000).then(() => 'stuck')])
      expect(code).not.toBe('stuck')
      expect(code).toBe(0)
      expect(() => process.kill(pid, 0)).toThrow()
      // 产物根下只有最初那一个现场——「晚到」那条一个目录都没留下
      expect(readdirSync(join(dir, 'runs')).filter((name) => name.includes('D26-晚到'))).toEqual([])
    } finally {
      serve.kill()
      await serve.exited.catch(() => {})
      removeDir(dir)
    }
  }, 90_000)
})

/**
 * 助手的一次「工具调用」——往**同一个进程**的 stdin 写一行 JSON，等它那一行答复。
 *
 * ⚠️ 两次之间**不关 stdin**：常开的那根水道正是这个入口能「多次操作同一现场」的原因
 * （`tty:false` 起的话 stdin 当场就关，这条道走不成——见 `control.ts` 头注）。
 */
async function call(
  proc: { readonly stdin: { write(chunk: string): unknown; flush(): void } },
  lines: { next(timeoutMs: number): Promise<unknown> },
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  proc.stdin.write(`${JSON.stringify(command)}\n`)
  proc.stdin.flush()

  return (await lines.next(30_000)) as Record<string, unknown>
}

/** 一行一行读（控制通道是逐行 JSON）。`stop()` ＝ 把**读端**关掉（写的那一头随即 EPIPE）。 */
function readerOf(stream: ReadableStream<Uint8Array>): {
  next: (timeoutMs: number) => Promise<unknown>
  stop: () => void
} {
  const decoder = new TextDecoder()
  let buffered = ''
  const queue: unknown[] = []
  // 等着的那几个（通常就一个）——用一组 resolver，不用一个可变槽：
  // 变量槽会在闭包里被 TS 收窄成 `never`（实测），而这一层本来就只是「叫醒等着的人」
  const waiters: (() => void)[] = []
  // 自己拿 reader（不用 `for await`）——只为**能从外面取消**：「控制端断了」
  // 那条路要的正是「读端没了」（`for await` 里 break 不出去）
  const reader = stream.getReader()

  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined || value.length === 0) continue
        buffered += decoder.decode(value, { stream: true })
        let at = buffered.indexOf('\n')
        while (at !== -1) {
          const line = buffered.slice(0, at).trim()
          buffered = buffered.slice(at + 1)
          if (line !== '') queue.push(JSON.parse(line))
          at = buffered.indexOf('\n')
        }
        for (const waiter of waiters.splice(0)) waiter()
      }
    } catch {
      // 读端被自己关掉（`stop`）——收场，不是错
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
    stop: () => {
      void reader.cancel().catch(() => {})
    },
  }
}
