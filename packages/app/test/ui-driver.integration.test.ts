import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createUiSession } from './ui/driver.ts'

import { createSandbox } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'

import { removeDir, tempDir } from './tmp.ts'

let artifacts: string
beforeEach(() => { artifacts = tempDir('magic-ui-test-') })
afterEach(() => { removeDir(artifacts) })

/** 一段「起手就回一句话」的剧本——多数用例只要链子走通。 */
const HELLO = [{ kind: 'text', text: '收到，我在。' }] as const

describe('工具自证', () => {

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

    const session = await createUiSession({ artifacts, label: '自证-resize尺寸', command: probe, columns: 100, rows: 40 })
    try {
      await session.wait({ text: 'SIZE 100x40' })
      await session.resize(200, 40)

      // 子进程**自己说**它现在看到的尺寸——与 VT 报的（driver 交给它的）对得上才算数
      await session.wait({ text: 'SIZE 200x40' })

      const screen = await session.screen()
      expect(screen.columns).toBe(200)
      expect(screen.rows).toBe(40)
      expect((await session.capture({ label: '改窗之后' })).lines.join('\n')).toContain('SIZE 200x40')
      expect(existsSync(join(session.runDir, 'host'))).toBe(false)
    } finally {
      await session.close()
    }
  }, 40_000)
})

describe('常驻测试宿主的归属', () => {

  test('宿主起手失败也收回本轮资源，保留宿主错误证据', async () => {
    const runs = tempDir('magic-u40-host-failure-')
    const checkout = tempDir('magic-u40-missing-checkout-')
    try {
      await expect(createUiSession({ artifacts: runs, checkout, turns: HELLO })).rejects.toThrow('隔离 Engine 未就绪')
      const runDir = join(runs, readdirSync(runs)[0]!)
      const info = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as { outcome: string; app: { home: string }; fixture: { port: number } }
      const host = JSON.parse(readFileSync(join(runDir, 'host/host.json'), 'utf8')) as { pid: number; code: number }
      expect(info.outcome).toBe('failed')
      expect(host.code).not.toBe(0)
      expect(() => process.kill(host.pid, 0)).toThrow()
      expect(existsSync(info.app.home)).toBe(false)
      await expect(fetch(`http://127.0.0.1:${info.fixture.port}/v1/models`)).rejects.toBeDefined()
      expect(existsSync(join(runDir, 'host/host.stderr.log'))).toBe(true)
    } finally {
      removeDir(checkout)
      removeDir(runs)
    }
  }, 15_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 退回四条（U40-2）—— 每条都是首轮验收**实测踩出来的**真故障，各留一个回归
// ═══════════════════════════════════════════════════════════════════════

describe('-2 · 退回的四处回归', () => {

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
})

/** 一趟运行的时间线（`steps.ndjson` 逐行）。 */
function stepsOf(runDir: string): Record<string, unknown>[] {
  return readFileSync(join(runDir, 'steps.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function untilExists(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等不到文件：${path}`)
    await Bun.sleep(50)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// D30 · 取帧与字节数同刻 —— 帧必须是应用**画完的整帧**，且与它自己记的字节数同刻
// ═══════════════════════════════════════════════════════════════════════

/**
 * 探针：照 Ink 的帧协议吐两帧，**第二帧写到一半停住**。
 *
 * 为什么要照抄这个协议：Ink 每渲染一帧，两头各发一次同步更新（`CSI ?2026h` … `CSI ?2026l`，
 * 见 `ink/build/write-synchronized.js` 的 `bsu` / `esu`），**认得这个开关的终端在 `esu` 那一下
 * 整帧一次落地**——中间那半截谁也看不见。驱动那台 VT 若不认它，就会把「擦完还没画」的空档
 * 也当成屏上的样子，取帧正好落在里面就成了「半截帧」。
 *
 * 探针把**自己写出的字节数**（不写 `\n`，故与驱动记的字节数同口径）落进状态文件：
 * 帧一画完记一个、第二帧写到一半记一个、全画完再记一个。用例据此断言。
 */
function framingProbe(statePath: string): string[] {
  return [
    process.execPath,
    '-e',
    [
      "const fs = require('node:fs')",
      "const BSU = '\\u001b[?2026h'",
      "const ESU = '\\u001b[?2026l'",
      `const state = ${JSON.stringify(statePath)}`,
      'let bytes = 0',
      'const write = (s) => { bytes += Buffer.byteLength(s, "utf8"); process.stdout.write(s) }',
      'const save = (phase, extra) => { fs.writeFileSync(state + ".next", JSON.stringify({ phase, bytes, ...extra })); fs.renameSync(state + ".next", state) }',
      // 帧一：完整的一帧（起手这一帧也把「第一帧落屏」那一跳给满足掉）
      "write(BSU); write('\\u001b[1;1HMARK-1'); write(ESU)",
      'const frame1End = bytes',
      "save('frame1', { frame1End })",
      'process.stdin.setRawMode(true)',
      'process.stdin.resume()',
      "let started = false",
      "process.stdin.on('data', () => {",
      "  if (!started) { started = true",
      // 帧二：先写半截就**停住**（半截上了屏，就是「撕裂」；整帧没落地，就不该算数）
      "  write(BSU); write('\\u001b[2;1HTEAR-2-HALF')",
      "  save('half2', { frame1End })",
      '  } else {',
      "    write('\\u001b[3;1HMARK-2-FULL'); write(ESU)",
      "    save('done', { frame1End, frame2End: bytes })",
      '  }',
      '})',
    ].join(';'),
  ]
}

type ProbeState = { phase: string; bytes: number; frame1End: number; frame2End?: number }

describe('D30 · 取帧与字节数同刻', () => {
  test('取帧只认**画完的整帧**：应用正写在半截时取的帧，不许是那半截', async () => {
    const dir = tempDir('magic-d30-framing-')
    const statePath = join(dir, 'probe.json')
    const session = await createUiSession({ artifacts,
      label: 'D30-整帧',
      command: framingProbe(statePath),
      columns: 100,
      rows: 40,
    })

    try {
      await session.wait({ text: 'MARK-1' })
      await untilExists(statePath, 5_000)

      // 触发第二帧；取完半截后再明确放行尾段。
      await session.send('go')
      const half2 = await untilPhase(statePath, 'half2', 5_000)

      const torn = await session.capture({ label: '半截时取的帧' })
      const tornStep = captureStepsOf(session.runDir).at(-1)

      // ① 帧必须是**画完的整帧**——半截那行在字节里、但没画完，不该出现在帧上
      expect(torn.text).toContain('MARK-1')
      expect(torn.text).not.toContain('TEAR-2-HALF')

      // ② 帧的「屏」与它自己记的「字节数」**同刻**：字节数就是第一帧画完那一点
      expect(tornStep?.['bytes']).toBe(half2.frame1End)

      // —— 对照（正例）：等第二帧**真画完**，同一条观测方法必须能看见那半截 ——
      //    没有这一条，「① 里没看见」就分不清是「不该看见」还是「方法根本看不见」
      await session.send('finish')
      const done = await untilPhase(statePath, 'done', 5_000)
      await session.wait({ text: 'MARK-2-FULL' })
      const whole = await session.capture({ label: '第二帧画完' })
      const wholeStep = captureStepsOf(session.runDir).at(-1)

      expect(whole.text).toContain('MARK-2-FULL')
      expect(whole.text).toContain('TEAR-2-HALF') // 方法看得见那半截——第一帧那一条才算数
      expect(wholeStep?.['bytes']).toBe(done.frame2End)
    } finally {
      // 探针那几个字节数留在现场里（它是这份帧「该对应哪一段字节」的独立凭据）
      copyFileSync(statePath, join(session.runDir, 'probe.json'))
      await session.close()
      removeDir(dir)
    }
  }, 90_000)
})

/** 等的那个「相位」——探针把进度落进状态文件，用例盯着文件（不是 sleep 猜时机）。 */
async function untilPhase(path: string, phase: string, timeoutMs: number): Promise<ProbeState> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(path)) {
      const state = JSON.parse(readFileSync(path, 'utf8')) as ProbeState
      if (state.phase === phase) return state
    }
    if (Date.now() > deadline) throw new Error(`等不到探针走到「${phase}」：${path}`)
    await Bun.sleep(10)
  }
}

/** 这趟里所有 `capture` 步（按次序）。 */
function captureStepsOf(runDir: string): Record<string, unknown>[] {
  return stepsOf(runDir).filter((step) => step['action'] === 'capture')
}

/**
 * U34 联调收口 · **沙地外借**（共用驱动加的那一个最小口子）。
 *
 * 联调要「关掉应用、再开一个接着看」——那要的是**同一个家目录**（同一份配置 / 数据库 /
 * 工作区），而缺省那一条每趟 `mkdtemp` 一块新的。这一组守两件：
 *
 * ① **外借的**（`sandbox` / `fixture`）收摊时**不删不停**，且第二趟起得在同一条上
 *    ——联调那条「关闭重开」就靠它；
 * ② **本趟自己的**东西照旧归本驱动（子进程退出确认 · PTY 释放）——外借不等于撒手。
 */
describe('沙地外借：收摊不动别人的东西', () => {
  /** 探针：报一句话就赖着不走（退出由 `close()` 那三跳来）。 */
  const PROBE = [
    process.execPath,
    '-e',
    'console.log("BORROW-OK"); setInterval(() => {}, 1000)',
  ]

  test('外借的沙地与夹具：收摊不删不停，第二趟还能起在同一条上', async () => {
    const runs = tempDir('magic-u40-borrow-runs-')
    const fixture = startFixture({ turns: [{ kind: 'text', text: '收到' }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })

    try {
      const first = await createUiSession({ label: '外借-一', artifacts: runs, command: PROBE, sandbox, fixture })
      await first.wait({ text: 'BORROW-OK' })
      const closed = await first.close()

      // 本趟自己的东西照旧收了（子进程真退了、终端也放了）
      expect(closed.exit.by).toBe('sigterm')
      // 外借的两件原封不动
      expect(existsSync(sandbox.root)).toBe(true)
      expect(existsSync(sandbox.configPath)).toBe(true)

      // 第二趟起在**同一块**上——「关闭重开」正是这么走的
      const second = await createUiSession({ label: '外借-二', artifacts: runs, command: PROBE, sandbox, fixture })
      await second.wait({ text: 'BORROW-OK' })
      await second.close()

      expect(existsSync(sandbox.root)).toBe(true)
      expect(readdirSync(runs).length).toBe(2) // 两趟各自的产物都在
    } finally {
      // 外借的**由借出方**收：夹具先停，再删沙地，最后清产物
      await fixture.stop()
      await sandbox.dispose()
      removeDir(runs)
    }
  })

  test('起手失败那条路：本趟的进程清干净、**外借的沙地与夹具原封不动**', async () => {
    const runs = tempDir('magic-u40-borrow-boot-')
    const stash = tempDir('magic-u40-borrow-pid-')
    const pidFile = join(stash, 'stall.pid')
    // 探针：**一个字节都不吐**——起手那一跳必然超时（同上面那条「起手失败也清干净」）
    const stall = [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(() => {}, 1000)`,
    ]

    const fixture = startFixture({ turns: [{ kind: 'text', text: '没人会看到这句' }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })

    try {
      let failure: unknown
      try {
        await createUiSession({
          label: '外借-起手失败',
          artifacts: runs,
          command: stall,
          sandbox,
          fixture,
          readyTimeoutMs: 1_200,
        })
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(Error)
      // **本趟自己的**照旧收干净：子进程确实起来过，且真没了
      await untilExists(pidFile, 5_000)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      expect(Number.isInteger(pid)).toBe(true)
      expect(() => process.kill(pid, 0)).toThrow()

      // 失败也留档（起手那条路自己那一帧「卡在什么画面上」）
      const runDir = join(runs, readdirSync(runs)[0] as string)
      const info = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as { outcome: string }
      expect(info.outcome).toBe('failed')

      // **外借的两件原封不动**：沙地还在，夹具还在听着（借出方没收摊之前不动它们）
      expect(existsSync(sandbox.root)).toBe(true)
      expect(existsSync(sandbox.configPath)).toBe(true)
      const alive = await fetch(`${fixture.baseURL}/models`)
        .then(() => true)
        .catch(() => false)
      expect(alive).toBe(true)
    } finally {
      await fixture.stop()
      await sandbox.dispose()
      removeDir(runs)
      removeDir(stash)
    }
  }, 60_000)
})
