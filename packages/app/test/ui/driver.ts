/**
 * 界面验收 · 共用驱动（U40）——**同一支驱动，自动测试与助手共用**。
 *
 * ## 它驱动的是什么
 *
 * **真的那个应用**：`bun <checkout>/packages/app/src/cli.ts`——真装配 → 真外壳（Ink）→
 * 真模型适配链。按键**经真 PTY** 送到 CLI 的 stdin（不是往 React 组件的 props 里塞事件），
 * 屏上的字**从它写出的字节里读**（不是拿视图对象算出来的）。
 *
 * ## 六件操作（就是公开面的全部）
 *
 * | 操作 | 语义 |
 * | --- | --- |
 * | `send(text)` | 往 PTY 写一串正文（与手打同形——逐字进同一个 stdin） |
 * | `key(name)` | 敲一个**闭集里**的键；不认识的名字**当场报错**（不悄悄换成另一种按键） |
 * | `resize(cols, rows)` | 改窗口：**同一有序操作**里更新 PTY 与 VT，并给自己那个子进程发 `SIGWINCH` |
 * | `wait(cond)` | 等**可见屏**上的条件成立（超时有界；超时＝结构化失败 ＋ 留现场） |
 * | `capture(label)` | **只观察**：读此刻的屏（文本 ＋ 字格 ＋ 光标）并存成一帧 |
 * | `close()` | 收摊：杀掉自己起的那个应用、停掉自己的夹具、留产物 |
 *
 * ## 三处是量出来的，不是想出来的
 *
 * 1. **resize 只调 `terminal.resize()`，子进程的 stdout 尺寸不会刷新**（探针实测：
 *    子进程一个字节都不吐）；**补一发 `SIGWINCH` 才刷新**。故三件必须同序做：
 *    `pty.resize` → `vt.resize` → `SIGWINCH`。
 * 2. **正文与回车分两次写**（早先 pty 那几轮实测：挤在同一次写里整段按键会被丢掉），
 *    故 `send()` 与 `key('enter')` 是两次写——这也是「与手打同形」的应有之义。
 * 3. **等条件只查可见屏**：内联渲染下旧内容会滚进 scrollback（实测 resize 之后
 *    `viewportY` 直接跳到 10），拿整块历史去匹配＝旧文字让新步骤误过。
 *
 * ⚠️ `capture` 不发送、不重启、不重绘——它只读 VT 状态并落一帧文件；
 * 应用**一直在跑**（「取帧发生在应用仍运行时，不能先 unmount 再量光标」）。
 */

import { mkdirSync, readFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
// 判「放开输入了没有」的那句提示——**取产品自己那个常量**（不是抄一份字面量：
// 文案改了它跟着改，抄的那份会悄悄过期，而这类过期最坏的表现是「等条件永远为真」）
import { HINT_IDLE } from '@magic/tui'
import { createArtifacts } from './artifacts.ts'
import type { Artifacts, FrameRecord } from './artifacts.ts'
import { startFixture } from './fixture.ts'
import type { Fixture, FixtureRequest, FixtureTurn } from './fixture.ts'
import { createSandbox } from './sandbox.ts'
import type { Sandbox } from './sandbox.ts'
import { createVt } from './vt.ts'
import type { Vt, VtCell, VtScreen } from './vt.ts'
import { writeViewer } from './viewer.ts'

/** 本仓根——被测 checkout 的缺省值（从本文件往上四层：ui → test → app → packages → 根）。 */
export const REPO_ROOT = resolve(import.meta.dir, '../../../..')

/** 产物根缺省落这儿（`.gitignore` 已忽略）——**给人看的东西不进临时目录**。 */
export const DEFAULT_ARTIFACTS_ROOT = join(REPO_ROOT, '.ui-runs')

/** 闭集：认得的键。**不在表内即报错**（绝不猜——猜错＝判据验的不是那件事）。 */
const KEYS: Record<string, string> = {
  enter: '\r',
  // 裸 LF ＝ 外壳判的「换行」（`toShellKeys` 里 `input === '\n'` 那一支）
  'shift+enter': '\n',
  esc: '\u001b',
  // 空闲＝退出 · 工作中＝中断（原型 · 键盘）——**归外壳判**，故这里就是这一个字节
  'ctrl+c': '\u0003',
  tab: '\t',
  backspace: '\u007f',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
}

export type UiKey = keyof typeof KEYS

/** 键名的合法值（报错时列给人看）。 */
export const UI_KEYS = Object.keys(KEYS) as UiKey[]

/**
 * 等条件的闭集——「文字出现 / 文字消失 / 某个坐标上出现」。
 *
 * ⚠️ **`text` 是逐行比的**（某一行`includes`它），不是整屏拼起来比：屏上的长句会被**折行**
 * 劈成两截（实测：`还没有授` / `权——批准时…`），挑判据时要用**一行装得下**的那一截。
 * 要按坐标判就明写 `at`（行号从 0 起，指**可见区**顶行）。
 */
export type WaitCondition =
  | { readonly text: string }
  | { readonly absent: string }
  | { readonly at: { readonly row: number; readonly text: string } }

export type WaitOptions = {
  /** 超时（毫秒）——**必须有界**；缺省 8 秒（真模型那条路要等流式收尾）。 */
  readonly timeoutMs?: number
}

/**
 * 「敲下去，**直到屏上出现这个条件**」——pty 这一层**偶尔会吞掉一次按键**（早先几轮与
 * 本工具都实测过，症状是「屏上什么都没动」）。既然判据本来就是「屏上出现了什么」，
 * 那就以它为准：没出现就再敲一次（上限 `tries`），出现了就停（**不重复敲**）。
 *
 * ⚠️ 只用在**幂等**的键上（回车 / 批准 / 退格这类）：重发的依据是「效果没出现」，
 * 不等于「这一下没送到」——第一次其实送到了、只是慢（模型慢、屏还没刷），
 * 重发的那一下必须**无害**（草稿已空时再敲回车本来就是空操作）。
 */
export type WriteUntil = {
  readonly until: WaitCondition
  /** 重发上限（含第一次；缺省 3）。 */
  readonly tries?: number
  /** 每一次等多久（缺省 2500ms；真模型那条路给大一点）。 */
  readonly timeoutMs?: number
}

export type WaitResult = {
  readonly ok: true
  /** 命中的条件描述（人读的一句话）。 */
  readonly matched: string
  readonly elapsedMs: number
  readonly step: number
}

/** 等超了——**结构化失败**：条件、等了多久、此刻的屏、现场在哪儿，全带上。 */
export class UiWaitTimeout extends Error {
  readonly condition: WaitCondition
  readonly timeoutMs: number
  readonly elapsedMs: number
  readonly screen: readonly string[]
  readonly runDir: string
  readonly frameStep: number

  constructor(init: {
    condition: WaitCondition
    timeoutMs: number
    elapsedMs: number
    screen: readonly string[]
    runDir: string
    frameStep: number
  }) {
    super(
      `等「${describeCondition(init.condition)}」超时（${Math.round(init.elapsedMs)}ms / 上限 ${init.timeoutMs}ms）。\n` +
        `此刻屏上（可见区）是：\n${init.screen.join('\n')}\n` +
        `现场：${init.runDir}`,
    )
    this.name = 'UiWaitTimeout'
    this.condition = init.condition
    this.timeoutMs = init.timeoutMs
    this.elapsedMs = init.elapsedMs
    this.screen = init.screen
    this.runDir = init.runDir
    this.frameStep = init.frameStep
  }
}

/** 一帧（`capture` 交出来的那份）。 */
export type Capture = {
  readonly n: number
  readonly step: number
  readonly label: string
  readonly columns: number
  readonly rows: number
  /** 可见屏的纯文本（一行一行，右侧空白已裁）。 */
  readonly lines: readonly string[]
  readonly text: string
  /** **整个缓冲**（含滚进 scrollback 的）——判「记录不丢不重」用它，别用可见那一截。 */
  readonly history: readonly string[]
  readonly cursor: { readonly x: number; readonly y: number }
  /** 可见区之上压着多少行（滚进 scrollback 的）。 */
  readonly scrollback: number
  /** 第 `row` 行的格子（到最后一个非空格为止）——量色与重量走它。 */
  cellsOf(row: number): readonly VtCell[]
  /** 这一帧落成的两个文件（相对运行目录）。 */
  readonly files: { readonly data: string; readonly text: string }
}

export type CloseReport = {
  readonly runDir: string
  readonly viewer: string
  readonly exit: {
    readonly code: number | null
    readonly signal: string | null
    /** 谁让它退的场：应用自己 `app` · 我们发的 SIGTERM `sigterm` · 只好 SIGKILL `sigkill`。 */
    readonly by: 'app' | 'sigterm' | 'sigkill'
  }
  readonly rawBytes: number
  readonly truncated: boolean
  readonly frames: number
}

export type UiSession = {
  /** 应用进程号——「同一 PID / 现场保持」那条判据看它。 */
  readonly pid: number
  readonly runDir: string
  readonly columns: number
  readonly rows: number
  /**
   * 这一趟的几件底细（进程 · 落点 · 端点）——判据里「两次运行各是各的」那几条靠它，
   * 助手排查也靠它。
   */
  facts(): SessionFacts
  /** 应用写出的全部字节（**有界**；触界即 `truncated`）。 */
  rawText(): string
  /**
   * 本地模型夹具收到的请求（按次序）——「提交前是不是零请求」「实际发出去的是什么」看它。
   * 没起夹具（`turns` 没给）时是空数组。
   */
  requests(): readonly FixtureRequest[]
  send(text: string, options?: WriteUntil): Promise<void>
  key(name: UiKey, options?: WriteUntil): Promise<void>
  resize(columns: number, rows: number): Promise<void>
  wait(condition: WaitCondition, options?: WaitOptions): Promise<WaitResult>
  capture(options?: { readonly label?: string }): Promise<Capture>
  /** 此刻的屏（不落帧、不记步）——驱动内部的等与判据用它。 */
  screen(): Promise<VtScreen>
  /**
   * 收摊：先给它一点**自己走**的余地（`graceMs`，如刚敲过 ctrl+c 时），再 SIGTERM、再 SIGKILL。
   * 结果里的 `exit.by` 说清它是哪一种。
   */
  close(options?: { readonly keepSandbox?: boolean; readonly graceMs?: number }): Promise<CloseReport>
}

/** 一趟运行的底细——读到的是**当场**的值（不是收尾时补的）。 */
export type SessionFacts = {
  readonly pid: number
  readonly runDir: string
  readonly checkout: string
  readonly home: string
  readonly workspace: string
  readonly dataDir: string
  readonly columns: number
  readonly rows: number
  /** 本地模型夹具的端口（没起夹具＝`null`）。 */
  readonly fixturePort: number | null
}

export type UiSessionOptions = {
  /** 被测 checkout（缺省＝本仓根）。应用路径从它解析，**工作目录仍是隔离工作区**。 */
  readonly checkout?: string
  /** 产物根（缺省 `<checkout>/.ui-runs`）。 */
  readonly artifacts?: string
  /** 这次运行叫什么（进目录名与 `run.json`）。 */
  readonly label?: string
  readonly columns?: number
  readonly rows?: number
  /** 存档上限（行）——**有界**。 */
  readonly scrollback?: number
  /** 模型夹具的剧本——**不给就不起夹具**（`baseURL` 指向丢弃端口，一个请求都发不出去）。 */
  readonly turns?: readonly FixtureTurn[]
  readonly model?: string
  /** 额外的 CLI 参数（如 `['--session','s-1']`）。 */
  readonly argv?: readonly string[]
  /**
   * **换掉整个被测命令**（缺省＝`bun <checkout>/packages/app/src/cli.ts`）。
   *
   * 给**自证探针**用：把被测命令换成一个能自报 `process.stdout.columns/rows` 的小进程——
   * 它验的是**本驱动这条 resize 路径**（PTY 尺寸 ＋ VT 尺寸 ＋ `SIGWINCH` 三件同序），
   * 不是产品。产品那一头另看布局是否跟着窗口重排。
   */
  readonly command?: readonly string[]
  /** 配置里额外的键。 */
  readonly config?: Record<string, unknown>
  /** 子进程的 `FORCE_COLOR`（缺省 3）。 */
  readonly forceColor?: string
  /** 起手就等到的「应用已经挂上」判据——缺省等**首帧出现**（见 `waitForFrame`）。 */
  readonly skipReady?: boolean
}

/** 等条件时重查的间隔——**不是**同步手段，只是「没新字节时也看一眼」的心跳。 */
const POLL_MS = 20

/**
 * 写一次（`send` 或 `key`），**要看效果就看效果**——给了 `until` 就等它，没等到再写一次。
 *
 * 一处写、两个入口共用（`send` / `key` 的选项走的是同一段），免得两边各写一套重发规则。
 */
async function writeUntil(
  options: WriteUntil | undefined,
  write: () => Promise<void>,
  session: UiSession,
): Promise<void> {
  if (options === undefined) {
    await write()
    return
  }

  const tries = options.tries ?? 3
  const timeoutMs = options.timeoutMs ?? 2_500

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    await write()
    try {
      await session.wait(options.until, { timeoutMs })
      return
    } catch (error) {
      if (!(error instanceof UiWaitTimeout)) throw error
      if (attempt === tries) throw error
    }
  }
}

export async function createUiSession(options: UiSessionOptions = {}): Promise<UiSession> {
  const checkout = options.checkout ?? REPO_ROOT
  const cli = join(checkout, 'packages/app/src/cli.ts')
  const columns = options.columns ?? 100
  const rows = options.rows ?? 30
  const scrollback = options.scrollback ?? 2_000

  const fixture: Fixture | null =
    options.turns === undefined ? null : startFixture({ turns: options.turns, model: options.model })
  const sandbox: Sandbox = createSandbox({
    baseURL: fixture?.baseURL,
    model: options.model,
    forceColor: options.forceColor,
    config: options.config,
  })

  // 摊平成可变数组——`Bun.spawn` 收的是 `string[]`，而选项里给的是只读的
  const argv: string[] = [...(options.command ?? [process.execPath, cli, ...(options.argv ?? [])])]
  const artifacts: Artifacts = createArtifacts({
    root: options.artifacts ?? DEFAULT_ARTIFACTS_ROOT,
    label: options.label ?? 'ui',
    checkout,
    app: {
      argv,
      cwd: sandbox.workspace,
      home: sandbox.home,
      dataDir: sandbox.dataDir,
      configPath: sandbox.configPath,
      forceColor: sandbox.env['FORCE_COLOR'] as string,
    },
    terminal: { columns, rows, scrollback, term: sandbox.env['TERM'] as string },
    fixture: fixture === null ? null : { baseURL: fixture.baseURL, port: fixture.port },
  })

  const vt: Vt = createVt({ columns, rows, scrollback })
  const decoder = new TextDecoder()
  let rawTail: string[] = []
  let rawTailBytes = 0
  let waiter: (() => void) | null = null

  /** 新字节到了——唤醒正等着的那个 `wait`（不攒、不合并，只叫一声）。 */
  const wake = (): void => {
    const pending = waiter
    waiter = null
    pending?.()
  }

  const pty = new Bun.Terminal({
    cols: columns,
    rows,
    data: (_terminal: Bun.Terminal, chunk: Uint8Array) => {
      // 按块解（`stream: true`）——多字节字符会被切在块中间，不这样解会出乱码
      const text = decoder.decode(chunk, { stream: true })
      if (text === '') return
      artifacts.raw(text)
      rawTail.push(text)
      rawTailBytes += text.length
      // 尾部留一份给 `rawText()`（诊断用）——**有界**，超了就从头上丢
      while (rawTailBytes > 256 * 1024 && rawTail.length > 1) {
        rawTailBytes -= (rawTail[0] as string).length
        rawTail.shift()
      }
      vt.write(text)
      wake()
    },
  })

  const child = Bun.spawn(argv, { terminal: pty, cwd: sandbox.workspace, env: sandbox.env })
  const startedAt = Bun.nanoseconds()
  artifacts.step('start', { argv, cwd: sandbox.workspace, home: sandbox.home, columns, rows })

  // 尺寸**会变**（`resize` 那一跳），故留一个当前值的槽——`columns` / `rows` / `facts()`
  // 都从它取（早先写成构造时的常量，`resize` 之后报的还是老尺寸：实测发现）
  const size = { columns, rows }

  const session: UiSession = {
    pid: child.pid,
    runDir: artifacts.runDir,
    get columns() {
      return size.columns
    },
    get rows() {
      return size.rows
    },

    rawText: () => rawTail.join(''),
    requests: () => fixture?.requests() ?? [],
    facts: () => ({
      pid: child.pid,
      runDir: artifacts.runDir,
      checkout,
      home: sandbox.home,
      workspace: sandbox.workspace,
      dataDir: sandbox.dataDir,
      columns: size.columns,
      rows: size.rows,
      fixturePort: fixture?.port ?? null,
    }),

    send: async (text, writeOptions) => {
      await writeUntil(
        writeOptions,
        () => {
          artifacts.step('send', { text, bytes: artifacts.bytes() })
          pty.write(text)
          // 让子进程有机会读走再发下一件（正文与回车分两次写——见文件头注 2）
          return Bun.sleep(1)
        },
        session,
      )
    },

    key: async (name, writeOptions) => {
      const bytes = KEYS[name]
      if (bytes === undefined) {
        throw new Error(`不认得的键「${String(name)}」——认得的：${UI_KEYS.join(' / ')}（不替你猜）`)
      }
      await writeUntil(
        writeOptions,
        () => {
          artifacts.step('key', { key: name, bytes: artifacts.bytes() })
          pty.write(bytes)
          return Bun.sleep(1)
        },
        session,
      )
    },

    resize: async (nextColumns, nextRows) => {
      artifacts.step('resize', { columns: nextColumns, rows: nextRows, bytes: artifacts.bytes() })
      // 三件同序：PTY 尺寸 → VT 尺寸 → 通知子进程（缺了第三件子进程一个字节都不吐——注 1）
      pty.resize(nextColumns, nextRows)
      vt.resize(nextColumns, nextRows)
      size.columns = nextColumns
      size.rows = nextRows
      process.kill(child.pid, 'SIGWINCH')
      // 让尺寸那一跳先落地（此后 vt 读出来就是新尺寸）
      await vt.settled()
      await Bun.sleep(1)
    },

    wait: async (condition, waitOptions = {}) => {
      const timeoutMs = waitOptions.timeoutMs ?? 8_000
      const started = Bun.nanoseconds()
      const step = artifacts.step('wait', { condition, timeoutMs, bytes: artifacts.bytes() })

      for (;;) {
        await vt.settled()
        const screen = vt.screen()
        if (matches(condition, screen)) {
          const elapsedMs = (Bun.nanoseconds() - started) / 1e6
          artifacts.step('wait-ok', { step, matched: describeCondition(condition), elapsedMs: Math.round(elapsedMs) })
          return { ok: true, matched: describeCondition(condition), elapsedMs, step }
        }

        const elapsedMs = (Bun.nanoseconds() - started) / 1e6
        if (elapsedMs >= timeoutMs) {
          await vt.settled()
          const last = vt.screen()
          const plain = last.lines.map((line) => line.text).join('\n')
          const frameStep = artifacts.step('wait-timeout', {
            step,
            condition,
            elapsedMs: Math.round(elapsedMs),
            timeoutMs,
            bytes: artifacts.bytes(),
          })
          const painted = frameOf(paint(last))
          artifacts.frame(
            {
              step: frameStep,
              label: `超时-${describeCondition(condition)}`,
              at: round(elapsedMs),
              columns: last.columns,
              rows: last.rows,
              cursor: last.cursor,
              scrollback: last.scrollback,
              total: last.total,
              styles: painted.styles,
              lines: painted.lines,
            },
            plain,
          )
          artifacts.finish('failed', {
            failure: {
              step: `wait（第 ${step} 步）`,
              kind: 'timeout',
              detail: `等「${describeCondition(condition)}」超时：${Math.round(elapsedMs)}ms / 上限 ${timeoutMs}ms`,
              condition,
            },
            exit: { code: child.exitCode, signal: child.signalCode },
          })
          writeViewer(artifacts.runDir)
          throw new UiWaitTimeout({
            condition,
            timeoutMs,
            elapsedMs,
            screen: last.lines.map((line) => line.text),
            runDir: artifacts.runDir,
            frameStep,
          })
        }

        // 要么新字节到（马上重查），要么心跳到点（条件可能与字节无关，如 `absent`）
        await Promise.race([
          new Promise<void>((done) => {
            waiter = done
          }),
          Bun.sleep(POLL_MS),
        ])
      }
    },

    capture: async (captureOptions = {}) => {
      const label = captureOptions.label ?? '帧'
      await vt.settled()
      const screen = vt.screen()
      const plain = screen.lines.map((line) => line.text).join('\n')
      const step = artifacts.step('capture', {
        label,
        columns: screen.columns,
        rows: screen.rows,
        cursor: screen.cursor,
        scrollback: screen.scrollback,
        bytes: artifacts.bytes(),
      })
      const painted = frameOf(paint(screen))
      const n = artifacts.frame(
        {
          step,
          label,
          at: round((Bun.nanoseconds() - startedAt) / 1e6),
          columns: screen.columns,
          rows: screen.rows,
          cursor: screen.cursor,
          scrollback: screen.scrollback,
          total: screen.total,
          styles: painted.styles,
          lines: painted.lines,
        },
        plain,
      )
      const name = `${String(n).padStart(4, '0')}-${label.replace(/[\s/\\:*?"<>|]+/g, '-')}`

      return {
        n,
        step,
        label,
        columns: screen.columns,
        rows: screen.rows,
        lines: screen.lines.map((line) => line.text),
        text: plain,
        history: screen.history,
        cursor: screen.cursor,
        scrollback: screen.scrollback,
        cellsOf: (row) => screen.cellsOf(row),
        files: { data: join('frames', `${name}.json`), text: join('frames', `${name}.txt`) },
      }
    },

    screen: async () => {
      await vt.settled()

      return vt.screen()
    },

    close: async (closeOptions = {}) => {
      // ⚠️ 「还在不在」**不能只看 `exitCode`**：被信号带走的进程 `exitCode` 恒为 `null`
      // （信号在 `signalCode` 里），只看前者会把「早就退了的」当成「还活着」，
      // 于是一路 SIGTERM→SIGKILL 下去，结局记成「我们杀的」（实测）
      const gone = (): boolean => child.exitCode !== null || child.signalCode !== null

      // 夹具收到的请求一并留档（截断 lastUser，别把长正文灌进步骤时间线）
      artifacts.step('fixture-requests', {
        count: fixture?.requests().length ?? 0,
        requests: (fixture?.requests() ?? []).map((request) => ({
          ...request,
          lastUser: request.lastUser.slice(0, 60),
        })),
      })
      artifacts.step('close', { bytes: artifacts.bytes() })

      // 先给它一点**自己走**的余地：刚敲过 ctrl+c 时那一跳还在路上，
      // 一上来就 SIGTERM 会把「用户让它退的」记成「我们杀的」（判据当场分不出来）
      const graceMs = closeOptions.graceMs ?? 600
      const deadline = Date.now() + graceMs
      while (!gone() && Date.now() < deadline) await Bun.sleep(20)

      // 谁让它退的场——应用自己走的（如空闲 ctrl+c）与「我们杀的」是两件事，
      // 判据要分得出来（「退出」那一组等的就是前者）
      let by: 'app' | 'sigterm' | 'sigkill' = gone() ? 'app' : 'sigterm'
      if (!gone()) {
        child.kill('SIGTERM')
        // SIGTERM 之后给 1 秒：外壳收摊（卸挂载、关库）本就要一会儿，
        // 太急就落到 SIGKILL——那不是「收摊」，是「拔电」（现场还在，但不好看）
        await Promise.race([child.exited, Bun.sleep(1_000)])
      }
      if (!gone()) {
        by = 'sigkill'
        child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(1_000)])
      }

      await fixture?.stop()
      vt.dispose()
      pty.close()

      // 记录库与授权是**现场的一部分**（「记录不丢不重」这类判据要直读它）——
      // 在删沙地之前抄进产物目录（子进程已退，文件不再被占）
      snapshotSandbox(sandbox, artifacts)
      if (closeOptions.keepSandbox !== true) sandbox.dispose()

      const exit = { code: child.exitCode, signal: child.signalCode, by }
      // 这一趟要是**失败过**（等超时等），结局照失败记——收摊不把失败擦成「跑完了」
      artifacts.finish(artifacts.info.failure === undefined ? 'closed' : 'failed', { exit })
      const viewer = writeViewer(artifacts.runDir)

      return {
        runDir: artifacts.runDir,
        viewer,
        exit,
        rawBytes: artifacts.bytes(),
        truncated: artifacts.info.truncated,
        frames: artifacts.info.frames,
      }
    },
  }

  // 换了被测命令（自证探针）时**不等那道输入闸**——那是产品外壳的起手姿态，
  // 探针子进程根本没有它；等它只会白等到超时
  if (options.skipReady !== true) {
    await waitForFrame(session, artifacts, child, options.command === undefined)
  }

  return session
}

/**
 * 等「应用已经挂上、并且放开输入了」——**两跳**，缺一跳就会丢键。
 *
 * 1. **首帧落屏**：外壳起来的第一件事就是画一屏（字标 ＋ 空态引导语）；
 * 2. **放开输入**：起手那一段外壳把输入**闸着**（`boot` ＝恢复跑完才受理），
 *    这期间敲进去的字只会躺在草稿里、**回车不受理**（实测踩过：`ready` 后 1.6ms 就发
 *    回车，屏上一直是那条草稿，模型请求数 0）。放开的判据取**产品自己那句提示常量**
 *    `HINT_IDLE`——启动那一段右位一律铺 `启动中……`，`boot` 完才换成它
 *    （`shell.ts` 里写着「这个口子是唯一的」）。
 *
 * 等不到就**报出此刻的屏**（十有八九是配置读坏了 / 装配抛了，那些话会打在同一个 tty 上）
 * ——而不是默默往下走、让后面的步骤红在一个莫名其妙的地方。
 */
async function waitForFrame(
  session: UiSession,
  artifacts: Artifacts,
  child: Bun.Subprocess,
  /** 等不等「放开输入」那一跳——被测命令是**产品外壳**时才等（见函数头注第 2 条）。 */
  waitInputGate: boolean,
): Promise<void> {
  const deadline = Bun.nanoseconds() + 20_000 * 1e6

  for (;;) {
    const screen = await session.screen()
    if (screen.lines.some((line) => line.text.trim() !== '')) {
      // 首帧落了以后给 Ink 一点余量（它那一下 `tcsetattr` 落定之前来的按键会被丢掉——
      // 早先 pty 那几轮实测的坑 1）。这是**起手一次的余量**，不是场景同步手段。
      await Bun.sleep(120)
      if (waitInputGate) await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
      artifacts.step('ready', { columns: screen.columns, rows: screen.rows })
      return
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `应用还没画出第一帧就退了（退出码 ${child.exitCode} / 信号 ${child.signalCode}）——它说出的话在原始字节里：\n` +
          `${session.rawText().slice(-2_000)}\n现场：${artifacts.runDir}`,
      )
    }

    if (Bun.nanoseconds() > deadline) {
      throw new Error(`等了 20 秒还没等到第一帧——现场：${artifacts.runDir}`)
    }

    await Bun.sleep(10)
  }
}

/** 条件命中了吗（**只看可见屏**——`screen()` 交出来的就是可见区）。 */
function matches(condition: WaitCondition, screen: VtScreen): boolean {
  if ('text' in condition) return screen.lines.some((line) => line.text.includes(condition.text))
  if ('absent' in condition) return !screen.lines.some((line) => line.text.includes(condition.absent))
  const target = screen.lines[condition.at.row]

  return target !== undefined && target.text.includes(condition.at.text)
}

/** 条件的一句话（错误消息、步骤时间线、帧标签都用它）。 */
export function describeCondition(condition: WaitCondition): string {
  if ('text' in condition) return `出现「${condition.text}」`
  if ('absent' in condition) return `不再出现「${condition.absent}」`

  return `第 ${condition.at.row} 行出现「${condition.at.text}」`
}

/** 画出来的一段——`col` 起始列、`width` 占几列、`style` 是**记号**（落表见 `frameOf`）。 */
type PaintedRun = {
  readonly col: number
  readonly text: string
  readonly width: number
  readonly style: string
}

type PaintedLine = { readonly wrapped: boolean; readonly runs: readonly PaintedRun[] }

/**
 * 一屏 → 「画出来的一段段」（查看页按它重画）。
 *
 * 三条：
 * - **宽字符自成一段**（占两列，宽度**从格子上取**，不靠字体猜——猜错就与真终端对不上）；
 * - **同一样式的连续单宽格并成一段**（一份帧文件的体积小一半）；
 * - **默认样式的空档不存**（存了也没东西可画）。
 *
 * ⚠️ **带样式的空档要存**：整行铺了背景时，文字之后那些格子的文本仍是空格——
 * 裁掉它们，查看页上就看不见「铺到哪」（VT 那边 `rawCellsOf` 正是为这个留的）。
 */
function paint(screen: VtScreen): readonly PaintedLine[] {
  return screen.lines.map((_line, row) => {
    const cells = screen.rawCellsOf(row)
    const runs: PaintedRun[] = []
    let current: PaintedRun | null = null

    const flush = (): void => {
      if (current !== null) runs.push(current)
      current = null
    }

    for (let col = 0; col < cells.length; col += 1) {
      const cell = cells[col] as VtCell
      // 宽字符的右半格：不落段（占位由左边那一格说了算）
      if (cell.width === 0) continue

      const style = styleToken(cell)
      if (cell.text.trim() === '' && style === '') {
        flush()
        continue
      }

      // 单宽 ＋ 同样式 ＋ 紧挨着 ⇒ 并进上一段（宽字符不并：它的占位得自己说了算）
      if (current !== null && current.style === style && current.width === col - current.col) {
        current = {
          col: current.col,
          text: current.text + cell.text,
          width: current.width + cell.width,
          style,
        }
        continue
      }

      flush()
      current = { col, text: cell.text, width: cell.width, style }
    }
    flush()

    return { wrapped: screen.lines[row]?.wrapped ?? false, runs }
  })
}

/**
 * 画出来的行 → 帧里的行（样式换成**下标**）。
 *
 * 先按出现次序建表再换号：`paint` 那一遍只管「哪些格同样式」，不必知道表里排第几。
 * 0 号位留给「默认样式」（空串那一支不进表，省得每条默认段都指一次）。
 */
function frameOf(lines: readonly PaintedLine[]): {
  readonly styles: readonly string[]
  readonly lines: FrameRecord['lines']
} {
  const table = new Map<string, number>()
  const indexOf = (token: string): number => {
    const known = table.get(token)
    if (known !== undefined) return known
    const next = table.size + 1
    table.set(token, next)

    return next
  }

  const rows = lines.map((line) => ({
    wrapped: line.wrapped,
    runs: line.runs.map(
      (run): [number, string, number, number] => [
        run.col,
        run.text,
        run.width,
        run.style === '' ? 0 : indexOf(run.style),
      ],
    ),
  }))

  return { styles: ['', ...table.keys()], lines: rows }
}

/** 一格的样式记号——`前景|背景|重量`（`''` ＝ 全默认）。 */
function styleToken(cell: VtCell): string {
  const attrs = `${cell.bold ? 'b' : ''}${cell.strikethrough ? 's' : ''}${cell.inverse ? 'i' : ''}`
  if (cell.fg === null && cell.bg === null && attrs === '') return ''

  return `${cell.fg ?? ''}|${cell.bg ?? ''}|${attrs}`
}

/**
 * 把沙地里那几件**现场证据**抄进产物目录——之后沙地就可以删干净了。
 *
 * 抄什么、为什么：
 * - `records.db`（连 `-wal` / `-shm`）——「记录不丢不重」这类判据要直读库；
 * - `grants.json`——点 `a` 之后授权落在哪儿、落成什么样；
 * - `config.json`——**合成配置的物证**（假 key 一眼可见，真配置从未被碰）。
 */
function snapshotSandbox(sandbox: Sandbox, artifacts: Artifacts): void {
  const target = join(artifacts.runDir, 'sandbox')
  mkdirSync(target, { recursive: true })
  const copied: string[] = []

  const copy = (from: string, name = ''): void => {
    if (!existsSync(from)) return
    const to = join(target, name === '' ? from.slice(from.lastIndexOf('/') + 1) : name)
    copyFileSync(from, to)
    copied.push(to.slice(artifacts.runDir.length + 1))
  }

  for (const name of readdirSync(sandbox.dataDir)) {
    if (name.startsWith('records.db')) copy(join(sandbox.dataDir, name))
  }
  copy(sandbox.grantsPath)
  copy(sandbox.configPath)

  artifacts.step('sandbox-snapshot', { copied })
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** 直读产物里的原始字节（判据用：某些话只可能在字节里）。 */
export function rawBytesOf(runDir: string): string {
  const path = join(runDir, 'raw.bin')

  return existsSync(path) ? readFileSync(path).toString('utf8') : ''
}
