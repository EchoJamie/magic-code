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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { UiWaitTimeout, createUiSession, hasFreshFrame, rawBytesOf } from './ui/driver.ts'
import { createControl } from './ui/control.ts'
import { createVt } from './ui/vt.ts'
import { VIEW_LOGIC, writeViewer } from './ui/viewer.ts'
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

  test('改窗判据：旧宽折行输出必须判**不通过**（44 与 70 两档），真帧才通过（D27）', async () => {
    const ESC = String.fromCharCode(27)
    const DASH = '─'

    // —— 反例一：**VT** 折行。100 列的分隔线画在 100 列窗口里，然后改窄——
    //    屏上「出现 44 个横线」＝旧判据（`text`）当场通过，而应用一个字节都没写。
    const ruler = createVt({ columns: 100, rows: 30 })
    ruler.write(`${DASH.repeat(100)}\n`)
    await ruler.settled()
    ruler.resize(44, 16)
    await ruler.settled()
    expect(ruler.screen().lines.some((line) => line.text.includes(DASH.repeat(44)))).toBe(true)
    ruler.dispose()

    // —— 反例二：**输出阶段**折行（这一族被实测连打出来四次，故**按网格生成**，不举单例）——
    //    改窗后应用先按旧宽度画一帧，Ink 把旧 W 列分隔线折成 ⌈W/N⌉ 段写在字节里。
    //    ⚠️ W 是 N 的**整数倍**时，末段就是一段干净的 N 横线、后面还跟着干净行——与真帧一模一样；
    //    拦它得看**上游**（首段靠下游、末段靠上游、中间两头顶住）。
    const OLD_WIDTHS = [80, 100, 120, 132, 160] as const
    const NEW_WIDTHS = [40, 44, 50, 60, 70] as const
    const foldedOldFrame = (oldWidth: number, columns: number): string => {
      const parts: string[] = []
      for (let at = 0; at < oldWidth; at += columns) {
        parts.push(`${ESC}[38;5;66m${DASH.repeat(Math.min(columns, oldWidth - at))}${ESC}[39m`)
      }

      return `${parts.join('\n')}\n › 交代一件事，回车发送\n`
    }
    for (const oldWidth of OLD_WIDTHS) {
      for (const columns of NEW_WIDTHS) {
        expect(hasFreshFrame(foldedOldFrame(oldWidth, columns), columns)).toBe(false)
      }
    }
    // 整数倍那几格单独点名——四次退回里两次出在这里（半屏分栏：120→60、80→40）
    expect(hasFreshFrame(foldedOldFrame(120, 60), 60)).toBe(false)
    expect(hasFreshFrame(foldedOldFrame(80, 40), 40)).toBe(false)
    expect(hasFreshFrame(foldedOldFrame(120, 40), 40)).toBe(false)

    // —— 反例二·补 A 族：旧宽只比新宽大 **1..7** 列（把窗口拖窄一点点，最常见的操作）——
    //    折行的**余数段**只有 1–7 个横线 ⇒ 下游一旦用「少于 N 个」的阈值就会被它骗过，
    //    故下游必须是**严格零横线**。
    for (const columns of [40, 80, 100, 120]) {
      for (let over = 1; over <= 7; over += 1) {
        expect(hasFreshFrame(foldedOldFrame(columns + over, columns), columns)).toBe(false)
      }
    }

    // —— 正例（成组，先摆正例好读）：**上一行是记录行**，里面**可以带横线** ——
    //    真帧分隔线上面紧挨的是记录行的末行；模型答一张表或一条 markdown 分隔线时那一行就带横线，
    //    上游若写成「上一行有没有横线」就会把真帧判成不过（套件在合法内容上超时）。
    for (const columns of [40, 44, 100]) {
      const freshWith = (above: string): string =>
        `${above}\n${ESC}[38;5;66m${DASH.repeat(columns)}${ESC}[39m\n › 交代一件事，回车发送\n`
      expect(hasFreshFrame(freshWith('│ ──────────────── │'), columns)).toBe(true) // 模型答的表
      expect(hasFreshFrame(freshWith(DASH.repeat(14)), columns)).toBe(true) // markdown 分隔线
      expect(hasFreshFrame(freshWith(DASH.repeat(8)), columns)).toBe(true)
      expect(hasFreshFrame(freshWith('› 上一件记录'), columns)).toBe(true)
      expect(hasFreshFrame(freshWith(''), columns)).toBe(true) // 空行
    }

    // —— 反例三：**字节停在半截**（第二轮实测打出来的洞）——
    //    分隔线那一行写完了、下一行还没到：「看不到下一行」被当成「下一行没有横线」就会假阳。
    //    旧宽重画被折成多段时，观测正好停在第一段之后，就是这一形。
    const rulerLine = `${ESC}[38;5;66m${DASH.repeat(44)}${ESC}[39m`
    expect(hasFreshFrame(`${rulerLine}\n`, 44)).toBe(false)
    expect(hasFreshFrame(`${rulerLine}\n${ESC}[38;5`, 44)).toBe(false)
    expect(hasFreshFrame(rulerLine, 44)).toBe(false)

    // —— 正例（成组）：分隔线按**新宽度**只画一行，两侧都是干净的记录行／输入行 ——
    for (const columns of NEW_WIDTHS) {
      const fresh = `› 上一件\n${ESC}[38;5;66m${DASH.repeat(columns)}${ESC}[39m\n › 交代一件事，回车发送\n`
      expect(hasFreshFrame(fresh, columns)).toBe(true)
      // 记录行里**偶尔带一个横线**不该把真帧判掉（判的是横线「段」，不是「有没有」）
      const dashed = `› 用 ─ 分隔的那条记录\n${ESC}[38;5;66m${DASH.repeat(columns)}${ESC}[39m\n › 交代一件事，回车发送\n`
      expect(hasFreshFrame(dashed, columns)).toBe(true)
    }
    // 下一行是**空行**（审批卡那种帧：分隔线下面直接跟空行）也算写完——不能把真帧等成超时
    expect(hasFreshFrame(`${rulerLine}\n\n › 等你的答复\n`, 44)).toBe(true)

    // —— 正例（真会话）：改窗之后应用确实按新宽度画出了整帧 ——
    const session = await createUiSession({ label: '自证-改窗判据', columns: 100, rows: 24, turns: HELLO })
    try {
      await session.resize(60, 18)
      await session.wait({ writtenFrame: 60 }, { timeoutMs: 8_000 })
      expect(rawBytesOf(session.runDir).includes(DASH.repeat(60))).toBe(true)
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
// 退回四条（U40-2）—— 每条都是首轮验收**实测踩出来的**真故障，各留一个回归
// ═══════════════════════════════════════════════════════════════════════

describe('U40-2 · 退回的四处回归', () => {
  test('写一次就是一次：`until` 只等待，不重放（超时留档，不重发动作）', async () => {
    const session = await createUiSession({ label: '回归-只写一次', turns: HELLO })

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

  test('起手失败也清干净：子进程、端点、沙地一个不留，失败留档还在', async () => {
    const runs = tempDir('magic-u40-boot-runs-')
    const stash = tempDir('magic-u40-boot-pid-')
    const pidFile = join(stash, 'stall.pid')
    // 探针：**一个字节都不吐**——外壳永远画不出第一帧，起手那一跳必然超时
    const stall = [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(() => {}, 1000)`,
    ]

    let failure: unknown
    try {
      await createUiSession({
        label: '回归-起手失败',
        artifacts: runs,
        command: stall,
        readyTimeoutMs: 1_200,
        turns: [{ kind: 'text', text: '没人会看到这句' }],
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    // 子进程**确实起来过**（不是「压根没起」冒充通过），且真没了
    await untilExists(pidFile, 5_000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(Number.isInteger(pid)).toBe(true)
    expect(() => process.kill(pid, 0)).toThrow()

    const runDir = join(runs, readdirSync(runs)[0] as string)
    const info = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as {
      outcome: string
      failure?: { kind: string }
      fixture: { port: number } | null
      app: { home: string }
    }

    // 端点：端口真释放了
    expect(info.fixture).not.toBeNull()
    await expect(
      fetch(`http://127.0.0.1:${(info.fixture as { port: number }).port}/v1/models`),
    ).rejects.toBeDefined()

    // 沙地：整块没了（HOME 是它的招牌）
    expect(existsSync(info.app.home)).toBe(false)

    // 留档：说得出这趟是失败的，有查看页、有时间线、也留了「卡在什么画面上」那一帧
    expect(info.outcome).toBe('failed')
    expect(info.failure).toBeDefined()
    expect(existsSync(join(runDir, 'viewer.html'))).toBe(true)
    expect(readFileSync(join(runDir, 'steps.ndjson'), 'utf8')).toContain('boot-failed')
    expect(existsSync(join(runDir, 'frames'))).toBe(true)
    // （探针一个字节都不吐，故这一趟没有 raw.bin——没字节就没得留，不是丢了证据）

    removeDir(stash)
    removeDir(runs)
  }, 60_000)

  test('回包写的是解析出来的那个会话（双实例里显式写号不许串）', async () => {
    const control = createControl({ log: () => {} })

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

      const sized = await control.handle(JSON.stringify({ id: 5, cmd: 'resize', session: 's1', columns: 72, rows: 18 }))
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

describe('U40-2 · 光标显隐与翻帧', () => {
  test('VT 取样带上光标真实显隐：显示 → 藏起 → 再显示 → 软复位回到显示', async () => {
    const vt = createVt({ columns: 20, rows: 4 })

    try {
      const hidden = async (): Promise<boolean> => {
        await vt.settled()

        return vt.screen().cursor.hidden
      }

      // 起手：终端光标本来是显示着的
      vt.write('x')
      expect(await hidden()).toBe(false)

      // 藏（DECTCEM：`CSI ?25l`）——产品起手就是这么干的
      vt.write('\u001b[?25l')
      expect(await hidden()).toBe(true)

      // 显（`CSI ?25h`）
      vt.write('\u001b[?25h')
      expect(await hidden()).toBe(false)

      // 再藏，然后**软复位**（DECSTR `CSI !p`）——重置之后回到「显示」
      vt.write('\u001b[?25l\u001b[!p')
      expect(await hidden()).toBe(false)

      // 坐标还是**同一套**（显隐不另造一份坐标）：显隐那几发转义不动位置，
      // 再打两个字符，光标就落在原处往后两格（实测）
      vt.write('ab')
      await vt.settled()
      const screen = vt.screen()
      expect(screen.cursor.x).toBe(3)
      expect(screen.cursor.y).toBe(0)
    } finally {
      vt.dispose()
    }
  })

  test('真应用那一趟：跑的时候光标**显示在编辑位置上**（不是藏着）', async () => {
    const session = await createUiSession({ label: '回归-真应用光标', turns: HELLO })

    try {
      // ⚠️ **换过锚的断言**（U31 三轮 · 规划侧把这一处划给真光标那一单）。
      //
      // - **原锚**：`expect(live.cursor.hidden).toBe(true)`——「跑着的时候光标是藏着的」。
      //   那会儿产品起手就把终端光标藏了、另画一个**反色空格**冒充分身，这一条量的是
      //   **那个冒充**：跑起来之后终端光标**永远**不出现在任何位置上。
      // - **为何变**：U31 起**真光标就是插入点的提示**（`useCursor` ＋ `measureElement`，
      //   反色那一格已删）——「产品在跑」与「光标藏着」不再是一回事：**编辑位置上是显示着的**，
      //   只有**裁决 / 选择接管**那几屏才藏（接管期间打不进草稿，没有插入点可指；见
      //   `spec.u31.test.ts` 的「裁决接管中」，以及归还之后**回到原插入点**那一条）。
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
      await session.key('ctrl+c')
    } finally {
      await session.close({ graceMs: 2_000 })
    }
  }, 40_000)

  test('查看页：帧里说「藏着」就不画那个黄框，元信息写明「隐藏」', () => {
    const dir = tempDir('magic-u40-view-')
    const html = viewerOf(dir, [
      { step: 1, label: '藏着', hidden: true },
      { step: 2, label: '显示着', hidden: false },
    ])

    const logic = viewLogic()
    const frameHidden = { cursor: { x: 3, y: 0, hidden: true } }
    const frameShown = { cursor: { x: 3, y: 0, hidden: false } }
    const frameOld = { cursor: { x: 3, y: 0 } } // 旧帧没这一格

    // 画不画：隐藏 → 不画（-1）；显示 → 画在原处
    expect(logic.caretColumnAt(frameHidden, 0)).toBe(-1)
    expect(logic.caretColumnAt(frameShown, 0)).toBe(3)
    // 不是光标那一行本来就不画
    expect(logic.caretColumnAt(frameShown, 1)).toBe(-1)
    // 旧帧（这一格是后加的）照旧画——不把老现场弄成没光标
    expect(logic.caretColumnAt(frameOld, 0)).toBe(3)

    // 元信息：隐藏时写明
    expect(logic.cursorNote(frameHidden)).toContain('隐藏')
    expect(logic.cursorNote(frameShown)).not.toContain('隐藏')

    // 数据得进页面（帧文件里那一格，查看页认的就是它）
    const payload = payloadOf(html)
    expect((payload['frames'] as { cursor: { hidden: boolean } }[])[0]?.cursor.hidden).toBe(true)
    expect((payload['frames'] as { cursor: { hidden: boolean } }[])[1]?.cursor.hidden).toBe(false)
    // 页面里跑的就是上面那几段源码（一处写两处用，见 `VIEW_LOGIC` 的注）
    expect(html).toContain('function caretColumnAt')
    expect(html).toContain('function cursorNote')

    removeDir(dir)
  })

  test('查看页翻帧沿全局检查点：末尾无帧那一步也能往回翻，前后往返一致', () => {
    const dir = tempDir('magic-u40-nav-')
    // 三步取过帧（1 / 3 / 5），末尾第 7 步（close 之后）**没有**帧——首轮实测卡在这儿
    const html = viewerOf(dir, [
      { step: 1, label: '第一帧', hidden: false },
      { step: 3, label: '第二帧', hidden: false },
      { step: 5, label: '第三帧', hidden: false },
    ], [1, 3, 5, 7])
    const logic = viewLogic()
    const frames = [0, 1, 2].map((at) => ({ step: [1, 3, 5][at] as number }))

    // 借帧：第 7 步（没有自己的帧）看到的是**它之前最近**那一帧
    expect(logic.nearestFrameAtOrBefore(frames, 7)).toBe(2)
    expect(logic.nearestFrameAtOrBefore(frames, 4)).toBe(1)
    expect(logic.nearestFrameAtOrBefore(frames, 0)).toBe(-1)

    // 翻帧：从末尾那一帧**往回**能走（首轮的毛病正是「这一步没帧就直接 return」）
    const at = logic.nearestFrameAtOrBefore(frames, 7)
    expect(logic.shiftFrame(frames, at, -1)).toBe(1)
    expect(logic.shiftFrame(frames, 1, -1)).toBe(0)
    // 前后往返一致
    expect(logic.shiftFrame(frames, logic.shiftFrame(frames, 0, 1), -1)).toBe(0)
    expect(logic.shiftFrame(frames, logic.shiftFrame(frames, 2, -1), 1)).toBe(2)

    // 边界：到头就不再挪（按钮那边据此禁用）
    expect(logic.canShift(frames, 0, -1)).toBe(false)
    expect(logic.canShift(frames, 0, 1)).toBe(true)
    expect(logic.canShift(frames, 2, 1)).toBe(false)
    expect(logic.canShift(frames, 2, -1)).toBe(true)
    expect(logic.canShift([], -1, 1)).toBe(false)
    expect(logic.canShift([], -1, -1)).toBe(false)

    expect(html).toContain('function shiftFrame')
    expect(html).toContain('function canShift')
    removeDir(dir)
  })
})

/**
 * 起一份**页面里那段判断逻辑**——与内联进查看页的是**同一段源码**（`VIEW_LOGIC`）。
 *
 * 查看页是自包含的单文件（没有 import 可言），故「跑在浏览器里的」与「用例验的」
 * 只能靠同一份源码保证是同一件事：这里 `new Function` 起的，就是内联进去的那段。
 */
function viewLogic(): {
  nearestFrameAtOrBefore(frames: readonly { step: number }[], step: number): number
  shiftFrame(frames: readonly unknown[], at: number, delta: number): number
  canShift(frames: readonly unknown[], at: number, delta: number): boolean
  caretColumnAt(frame: { cursor: { x: number; y: number; hidden?: boolean } }, y: number): number
  cursorNote(frame: { cursor: { x: number; y: number; hidden?: boolean } }): string
} {
  return new Function(
    `${VIEW_LOGIC}\nreturn { nearestFrameAtOrBefore, shiftFrame, canShift, caretColumnAt, cursorNote }`,
  )() as never
}

/** 造一份最小现场（只有查看页要读的那几格）＋生成查看页，返回 HTML。 */
function viewerOf(
  dir: string,
  frames: readonly { step: number; label: string; hidden: boolean }[],
  steps: readonly number[] = [1, 2],
): string {
  const runDir = join(dir, 'run')
  mkdirSync(join(runDir, 'frames'), { recursive: true })
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      run: 'run',
      label: '用例-查看页',
      startedAt: '2026-09-20T00:00:00.000Z',
      checkout: dir,
      commit: '0000000',
      dirty: false,
      bun: Bun.version,
      app: { argv: [], cwd: dir, home: dir, dataDir: dir, configPath: '', forceColor: '0' },
      terminal: { columns: 20, rows: 4, scrollback: 100, term: 'xterm-256color' },
      fixture: null,
      rawLimitBytes: 1,
      steps: steps.length,
      frames: frames.length,
      truncated: false,
      outcome: 'closed',
    }),
  )
  writeFileSync(
    join(runDir, 'steps.ndjson'),
    steps.map((n) => `${JSON.stringify({ n, at: n, action: 'capture', bytes: 0 })}\n`).join(''),
  )
  frames.forEach((frame, at) => {
    const n = at + 1
    writeFileSync(
      join(runDir, 'frames', `${String(n).padStart(4, '0')}-${frame.label}.json`),
      JSON.stringify({
        n,
        step: frame.step,
        label: frame.label,
        at: 0,
        columns: 20,
        rows: 4,
        cursor: { x: 3, y: 0, hidden: frame.hidden },
        scrollback: 0,
        total: 4,
        styles: [''],
        lines: [{ wrapped: false, runs: [[0, 'x', 1, 0]] }],
      }),
    )
  })

  return readFileSync(writeViewer(runDir), 'utf8')
}

/** 查看页里那份内联数据（`<script id="payload">`）。 */
function payloadOf(html: string): Record<string, unknown> {
  const raw = /<script id="payload" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  return JSON.parse(raw.replaceAll('\\u003c', '<')) as Record<string, unknown>
}

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

describe('U40 · 助手入口（常驻控制进程 · stdin ←→ stdout 逐行 JSON）', () => {
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
        rows: 24,
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

      const resized = await call(serve, lines, { id: 7, cmd: 'resize', columns: 70, rows: 18 })
      expect(resized['ok']).toBe(true)
      expect(resized['columns']).toBe(70)

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
    const session = await createUiSession({ label: 'D26-抽掉终端', turns: [] })
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

async function untilExists(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等不到文件：${path}`)
    await Bun.sleep(50)
  }
}
