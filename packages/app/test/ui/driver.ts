/**
 * 界面验收 · 共用驱动（U40）——**同一支驱动，自动测试与助手共用**。
 *
 * ## 它驱动的是什么
 *
 * **真的那个应用**：`bun <checkout>/packages/app/src/cli.ts`——真装配 → 真外壳（Ink）→
 * 真模型适配链。按键**经真 PTY** 送到 CLI 的 stdin（不是往 React 组件的 props 里塞事件），
 * 屏上的字**从它写出的字节里读**（不是拿视图对象算出来的）。
 *
 * ## 七件操作（就是公开面的全部）
 *
 * | 操作 | 语义 |
 * | --- | --- |
 * | `send(text)` | 往 PTY 写一串正文（与手打同形——逐字进同一个 stdin） |
 * | `key(name)` | 敲一个**闭集里**的键；不认识的名字**当场报错**（不悄悄换成另一种按键） |
 * | `quit()` | **照产品的方式退出**：空闲连按两次 `ctrl+c`（U46——一次不再走得掉） |
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
import { createArtifacts } from './artifacts.ts'
import type { Artifacts, FrameRecord } from './artifacts.ts'
import { startFixture } from './fixture.ts'
import type { Fixture, FixtureRequest, FixtureTurn } from './fixture.ts'
import { createSandbox } from './sandbox.ts'
import type { Sandbox } from './sandbox.ts'
import { createVt } from './vt.ts'
import type { Vt, VtCell, VtCursor, VtScreen } from './vt.ts'
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
 * **被测对象那一侧的词汇**（U51 第九条）——**机制这一层不认识它，由调用方给**。
 *
 * 驱动认的是「往 PTY 写字节、从 VT 读屏」，可它有三步必须知道**某个词**才成立：
 * 起手那道闸什么时候算放开、空闲长什么样、按第一下 ctrl+c 之后哪句话该出现。
 * 那些词是**被测对象的话**，故从外面传进来——判据一句话：**换个被测命令，本文件不用改**。
 *
 * 缺省从沙地取（`Sandbox.anchors`，见 `sandbox.ts`）——Magic 那一条路走的就是缺省。
 */
export type UiAnchors = {
  /**
   * **起手那道闸放开时屏上该有的那句话**——等它＝「放开输入了」。
   *
   * 给的是**宽度到条件的函数**：窄窗上那句提示会被整段省掉（状态行「从右往左省」），
   * 那时**根本没有这道闸可等**——返回 `null` 明说这一档没有，驱动据此记一步
   * `ready-gate-absent`（**不假装等到**，见 `waitForFrame`）。
   */
  readonly ready: (columns: number) => WaitCondition | null
  /**
   * **空闲**那一格的锚（状态行左位）——`quit()` 等「它真闲下来了」用它。
   *
   * ⚠️ 取**左位**那一格：状态行窄窗从右往左省，右位那句最先让位（46 列上还在、30 列上就没了，
   * 实测）——拿右位当条件，窄窗那一趟必然等到超时。
   */
  readonly idle: string
  /**
   * **空闲按第一下 `ctrl+c` 之后屏上出现的那句话**。
   *
   * `quit()` 拿它判「第一下落地了」——连写两次会让两下**都成了第一下**（顺序由 PTY 保证，
   * 但两下之间没有发生任何事）。产品那边这句文案改了就传新的进来，本层不认识它。
   */
  readonly exitArmed: string
}

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
  /**
   * **应用按这个宽度画出了完整一帧**——只看**最后一次改窗之后**新写出的那一段（D27）。
   *
   * 为什么不能简单看「屏上/字节里有没有 N 个横线」：改窗之后应用**第一帧往往还是按旧宽度画的**
   * （Ink 的 `resized` 比 React 早），100 列的分隔线在输出阶段就被折成
   * `44 横线 / 44 横线 / 12 横线`（70 列下是 `70 / 30`）——只认长度会被它骗过（实测：那一刻
   * 「屏上的 44 个横线」为真、「字节里正好 44 个横线」也为真，而应用一个字节都还没按新宽度画）。
   *
   * 故判据落在**分隔线的整行结构**上：找到正好 `columns` 个横线的那一行，再要求它**下一行
   * 不是横线行**。按新宽度画出来的帧只有一条分隔线，后面紧跟的是输入行；折出来的那一串
   * 后面**必然**还跟着横线。两种假阳性（VT 折行、输出阶段折行）都挡得住。
   */
  | { readonly writtenFrame: number }

export type WaitOptions = {
  /** 超时（毫秒）——**必须有界**；缺省 8 秒（真模型那条路要等流式收尾）。 */
  readonly timeoutMs?: number
}

/**
 * 写一次之后**只等条件**：`until` ＝「写完之后等这个」，**不是**「没出现就再写一遍」。
 *
 * ⚠️ **动作只做一遍，重放一律不做**。首轮验收实测：`tries: 3` 把一次 `send('X')` 变成了
 * `XXX`（步骤时间线上也是三次 send）。「屏上没出现」≠「这一下没送到」——第一次可能只是
 * **慢**（模型慢、Ink 还没刷），重发恰好把「慢渲染」这种问题掩盖掉；碰上**不幂等**的动作
 * （批准 `y`、回车把下一条也送出去），重放下去就是**误批**。
 *
 * 没等到就**超时留档**：抛 `UiWaitTimeout`（条件 · 等了多久 · 此刻的屏 · 现场目录），
 * 由调用方看着办——要再试一次的，自己决定是接着敲、还是换个判据。
 */
export type WriteUntil = {
  readonly until: WaitCondition
  /** 等多久（缺省 2500ms；真模型那条路给大一点）。 */
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
  /** 光标：坐标 ＋ **显隐**（藏起来时查看页不画它——见 `VtCursor`）。 */
  readonly cursor: VtCursor
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
  /**
   * **照产品的方式退出**（U46）——空闲 **连按两次 `ctrl+c`**：第一下**不退出**（只挂上
   * 「再按一次 ctrl+c 退出」那一行），第二下才走。
   *
   * 为什么不写一句 `key('ctrl+c')` 就完事：「空闲按一次 ＝ 退出」自 U46 起**不再是产品行为**
   * （设计 · 会话与运行管理：一个键在一个状态下只有一种走法，统一成按两次）。收尾那一段
   * 要判的正是「**应用自己走的**」（`close()` 报 `exit.by === 'app'`），那就得按它认的走完。
   *
   * ⚠️ **两下之间要等那一行上屏**：连着写两次会让「第一下」还没落地就发第二下——
   * 那还是两个「第一下」（顺序由 PTY 保证，但两下之间没有发生任何事）。
   */
  quit(): Promise<void>
  /**
   * **把终端抽掉**（D26）——关掉 PTY master，**一个信号都不发**：终端窗口关了 /
   * 管道断了就是这一下。随后用 `close()` 看它是**自己走的**（`exit.by === 'app'`）
   * 还是被我们杀的——那正是「应用认不认得出终端没了」的判据。
   */
  dropTerminal(): void
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
   * **外借的沙地**——给了就用它，**收摊不删它**（它归借出方管）。
   *
   * 由头（U34 联调收口）：一块沙地 ＝ 一份配置 ＋ 一个数据库 ＋ 一个工作区；
   * 「关掉应用、再开一个接着看」那条判据要的正是**同一个家目录**，而缺省那一条
   * 每趟 `mkdtemp` 一块新的——没有这个口子，只能另造一套终端驱动去复用，那正是
   * 要被删掉的那份重复（绕过同步帧、有界采样与运行档案）。
   *
   * ⚠️ **给了它就得同时给 `fixture`**：配置里的 `baseURL` 已经指着那一台夹具，
   * 另起一台＝指向一个没人听的端口。外借的两件**都不进**本驱动的清理清单
   * （正常收摊与起手失败两条路都不动它们），借出方自己停、自己删。
   *
   * ⚠️ **本趟自己的**东西照旧归本驱动：子进程（退出确认）· PTY · VT · 产物目录。
   */
  readonly sandbox?: Sandbox
  /** **外借的夹具**——与 `sandbox` 成对（见上）。 */
  readonly fixture?: Fixture
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
  /**
   * **被测对象那一侧的词汇**（U51 第九条）——不给就取沙地那份（`Sandbox.anchors`）。
   *
   * 显式给它是为了**换被测命令**：新对象写一份新锚传进来，本层一行都不用改。
   */
  readonly anchors?: UiAnchors
  /** 起手就等到的「应用已经挂上」判据——缺省等**首帧出现**（见 `waitForFrame`）。 */
  readonly skipReady?: boolean
  /**
   * 等第一帧的上限（缺省 20 秒）。
   *
   * 给**自证**用：起手失败那条路（超时 → 清场 → 留档）要能在几秒内跑完，
   * 不必真等满 20 秒。
   */
  readonly readyTimeoutMs?: number
}

/** 等条件时重查的间隔——**不是**同步手段，只是「没新字节时也看一眼」的心跳。 */
const POLL_MS = 20

/**
 * 写一次（`send` 或 `key`）：**写就是一遍**；给了 `until` 就**只等它**（见 `WriteUntil`）。
 *
 * 一处写、两个入口共用（`send` / `key` 的选项走的是同一段），免得两边各有一套规则。
 */
async function writeOnce(
  options: WriteUntil | undefined,
  write: () => Promise<void>,
  session: UiSession,
): Promise<void> {
  await write()
  if (options === undefined) return
  await session.wait(options.until, { timeoutMs: options.timeoutMs ?? 2_500 })
}

/**
 * 起手一路上**拿到手**的资源——失败时照这份清单**倒着还**（谁拿的谁负责）。
 *
 * ⚠️ 起手不是一步，是五步（夹具 → 沙地 → 现场 → VT → PTY → 子进程）。中间任何一步炸掉、
 * 或者「起来了但画不出第一帧」超时，前面几步拿到的东西都还在——首轮验收实测：
 * BOOT_STALL 探针超时之后，子进程、端点、HOME 三样一个没少（会话压根没进
 * `control.sessions`，`closeAll` 自然也够不着它）。
 */
type Owned = {
  fixture: Fixture | null
  sandbox: Sandbox | null
  artifacts: Artifacts | null
  vt: Vt | null
  pty: Bun.Terminal | null
  child: Bun.Subprocess | null
}

export async function createUiSession(options: UiSessionOptions = {}): Promise<UiSession> {
  const owned: Owned = { fixture: null, sandbox: null, artifacts: null, vt: null, pty: null, child: null }

  try {
    return await bootSession(options, owned)
  } catch (error) {
    // 起手失败＝**由创建者就地收摊**（不是扔给调用方、更不是扔给 closeAll——它还没被登记过）
    await salvage(owned, error)
    throw error
  }
}

/** 起手正戏——**拿到一件记一件**（`owned` 就是失败时要清的那份清单，见 `Owned`）。 */
async function bootSession(options: UiSessionOptions, owned: Owned): Promise<UiSession> {
  const checkout = options.checkout ?? REPO_ROOT
  const cli = join(checkout, 'packages/app/src/cli.ts')
  const columns = options.columns ?? 100
  const rows = options.rows ?? 30
  const scrollback = options.scrollback ?? 2_000

  // **外借的**（`options.fixture` / `options.sandbox`）**不进 `owned`**——收摊那两条路
  // 只动 `owned` 里那几件，于是外借的沙地与夹具原封不动（见 `UiSessionOptions.sandbox`）
  const fixture =
    options.fixture ??
    (options.turns === undefined
      ? null
      : (owned.fixture = startFixture({ turns: options.turns, model: options.model })))
  const sandbox =
    options.sandbox ??
    (owned.sandbox = createSandbox({
      baseURL: fixture?.baseURL,
      model: options.model,
      forceColor: options.forceColor,
      config: options.config,
    }))
  // 锚：显式给的优先；没给就取沙地那份（＝被测对象那一侧的适配器给的，见 `UiAnchors`）
  const anchors = options.anchors ?? sandbox.anchors

  // 摊平成可变数组——`Bun.spawn` 收的是 `string[]`，而选项里给的是只读的
  const argv: string[] = [...(options.command ?? [process.execPath, cli, ...(options.argv ?? [])])]
  const artifacts = (owned.artifacts = createArtifacts({
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
  }))

  const vt = (owned.vt = createVt({ columns, rows, scrollback }))
  const decoder = new TextDecoder()
  let rawTail: string[] = []
  let rawTailBytes = 0
  /**
   * **最后一次改窗之后**应用新写出的字节（`written` 判据看它——见 `WaitCondition`）。
   *
   * 为什么单记一份而不是从 `rawTail` 里切：`rawTail` 是**有界**的（超了从头上丢），
   * 按长度切会切错位置。这一份同样有界，只留改窗之后那一段，故不会无限长。
   */
  let sinceResize = ''
  let waiter: (() => void) | null = null

  /** 新字节到了——唤醒正等着的那个 `wait`（不攒、不合并，只叫一声）。 */
  const wake = (): void => {
    const pending = waiter
    waiter = null
    pending?.()
  }

  const pty = (owned.pty = new Bun.Terminal({
    cols: columns,
    rows,
    data: (_terminal: Bun.Terminal, chunk: Uint8Array) => {
      // 按块解（`stream: true`）——多字节字符会被切在块中间，不这样解会出乱码
      const text = decoder.decode(chunk, { stream: true })
      if (text === '') return
      artifacts.raw(text)
      rawTail.push(text)
      rawTailBytes += text.length
      // 改窗之后那一段单独留一份（`written` 判据）——同样有界，只留尾部
      sinceResize = (sinceResize + text).slice(-64 * 1024)
      // 尾部留一份给 `rawText()`（诊断用）——**有界**，超了就从头上丢
      while (rawTailBytes > 256 * 1024 && rawTail.length > 1) {
        rawTailBytes -= (rawTail[0] as string).length
        rawTail.shift()
      }
      vt.write(text)
      wake()
    },
  }))

  const child = (owned.child = Bun.spawn(argv, { terminal: pty, cwd: sandbox.workspace, env: sandbox.env }))
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
      await writeOnce(
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
      await writeOnce(
        writeOptions,
        () => {
          artifacts.step('key', { key: name, bytes: artifacts.bytes() })
          pty.write(bytes)
          return Bun.sleep(1)
        },
        session,
      )
    },

    quit: async () => {
      // **先等它真闲下来**：忙的时候 `ctrl+c` 是**中断**（外壳的既有语义），两下会被吃掉一下
      // ——那正是产品该有的样子，但不是收尾该走的姿势（会卡在「那一行没出现」上超时）。
      //
      // ⚠️ **等两次、中间睡一下**：「空闲」那句在**上一轮刚收口、下一跳还没画出来**时
      //    就已经是那个样子了——立刻按下去会按在「其实还在跑」上（`frames-copy-tui.ts`
      //    那一处记过同一跤：卡收了、下一趟模型还没回来的那半秒）。
      //
      // ⚠️ **锚用状态行左位那两个空格加「○ 空闲」，不用右位那句 `/ 命令 · ctrl+c 退出`**：
      //    窄窗上右位会被省掉（状态行「从右往左省」），拿它当条件在 46 列上永远等不到。
      await session.wait({ text: anchors.idle }, { timeoutMs: 15_000 })
      await Bun.sleep(300)
      await session.wait({ text: anchors.idle }, { timeoutMs: 15_000 })

      // 第一下：等那一行**真上屏**（那就是「这一下落地了」的证据，也顺带判了产品真印了它）
      await session.key('ctrl+c', { until: { text: anchors.exitArmed }, timeoutMs: 5_000 })
      // 第二下：走
      await session.key('ctrl+c')
    },

    resize: async (nextColumns, nextRows) => {
      artifacts.step('resize', { columns: nextColumns, rows: nextRows, bytes: artifacts.bytes() })
      // 从这里开始记「应用改窗之后写出的字节」——`written` 判据的起点
      sinceResize = ''
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
        // 与 `capture` 同一条规矩：**水位先抓、队列紧跟着抓**，两条语句之间没有 `await`
        // （理由见 `capture` 里那段注）——「等了多久」那一栏的屏与 `bytes` 也据此同刻。
        const bytes = vt.screenBytes()
        await vt.settled()
        const screen = vt.screen()
        if (matches(condition, screen, sinceResize)) {
          const elapsedMs = (Bun.nanoseconds() - started) / 1e6
          artifacts.step('wait-ok', {
            step,
            matched: describeCondition(condition),
            elapsedMs: Math.round(elapsedMs),
            bytes,
            written: artifacts.bytes(),
          })
          return { ok: true, matched: describeCondition(condition), elapsedMs, step }
        }

        const elapsedMs = (Bun.nanoseconds() - started) / 1e6
        if (elapsedMs >= timeoutMs) {
          const plain = screen.lines.map((line) => line.text).join('\n')
          const frameStep = artifacts.step('wait-timeout', {
            step,
            condition,
            elapsedMs: Math.round(elapsedMs),
            timeoutMs,
            bytes,
            written: artifacts.bytes(),
          })
          const painted = frameOf(paint(screen))
          artifacts.frame(
            {
              step: frameStep,
              label: `超时-${describeCondition(condition)}`,
              at: round(elapsedMs),
              columns: screen.columns,
              rows: screen.rows,
              cursor: screen.cursor,
              scrollback: screen.scrollback,
              total: screen.total,
              styles: painted.styles,
              lines: painted.lines,
              // 与屏同刻那两格（D30）：`bytes` 是**屏对应的**水位
              bytes,
              written: artifacts.bytes(),
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
            screen: screen.lines.map((line) => line.text),
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
      // ⚠️ **水位与屏必须同刻取**（D30）：先抓水位、**紧接着**抓 VT 那条队列——两条语句挨着，
      //    中间没有 `await`，故随后读到的屏反映的正是这个水位之前的字节。
      //
      //    反过来（先 `await settled()` 再读水位）就是 D30：`settled()` 等的是**它被调用那一刻**
      //    已入队的那些；等它落地的这段时间里应用又写出来的字节会**算进水位、却还没进屏**
      //    （实测那一趟：帧的屏停在 34488，而帧上标注的是 35721）。实测也确认了「把水位改成
      //    在 `settled()` 之后、`screen()` 之前读」**不管用**——两条语句同处一个同步块，
      //    先后无所谓，要挪的是**那个 `await`**。
      const bytes = vt.screenBytes()
      await vt.settled()
      const screen = vt.screen()
      const plain = screen.lines.map((line) => line.text).join('\n')
      const step = artifacts.step('capture', {
        label,
        columns: screen.columns,
        rows: screen.rows,
        cursor: screen.cursor,
        scrollback: screen.scrollback,
        // `bytes` ＝**屏对应的**水位（帧与它同刻）；`written` ＝应用这一刻一共写出了多少
        // （含正写在半截、还没上屏的那一帧）——两个数不是一回事，别混（见 `Vt.screenBytes`）。
        bytes,
        written: artifacts.bytes(),
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
          // 与屏同刻那两格（D30）——`bytes` 与 `written` 的口径差见 `WaitCondition.writtenFrame`
          bytes,
          written: artifacts.bytes(),
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

    dropTerminal: () => {
      artifacts.step('drop-terminal', { bytes: artifacts.bytes() })
      // 关掉 master ⇒ slave 那一头的 `stdin` 抬 end/close（这正是「窗口没了」的形状）。
      // 只做这一件：不发信号、不杀进程——退不退是**应用自己**的事。
      pty.close()
    },

    close: async (closeOptions = {}) => {
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
      const by = await shutDown(child, closeOptions.graceMs ?? 600)
      await releaseTerminal(owned.fixture, vt, pty)

      // 记录库与授权是**现场的一部分**（「记录不丢不重」这类判据要直读它）——
      // 在删沙地之前抄进产物目录（子进程已退，文件不再被占）
      snapshotSandbox(sandbox, artifacts)
      // 自有沙地才删（外借的归借出方）——`owned.sandbox === null` ⇔ 外借
      if (owned.sandbox !== null && closeOptions.keepSandbox !== true) owned.sandbox.dispose()

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
    await waitForFrame(session, artifacts, child, {
      // 被测命令被换掉时不等那道闸——那是**产品外壳**的起手姿态，别的进程根本没有它
      readyGate: options.command === undefined ? anchors.ready(columns) : null,
      timeoutMs: options.readyTimeoutMs ?? 20_000,
    })
  }

  return session
}

/**
 * 起手失败的收摊：**先留档，再清场**（倒序——后拿的先还）。
 *
 * 为什么留档要在清场之前：失败也是现场。`run.json` 记下失败缘由、屏上那一刻落一帧
 * （它卡在什么画面上）、查看页照样生成——清完场，这些文件还在原处等人看。
 *
 * ⚠️ 倒序不是洁癖：子进程还占着沙地里的库文件，得先让它退场（且真退了），
 * 抄库、删沙地才有意义。
 */
async function salvage(owned: Owned, error: unknown): Promise<void> {
  const { artifacts, vt, pty, fixture, sandbox, child } = owned

  if (artifacts !== null) {
    try {
      artifacts.step('boot-failed', { bytes: artifacts.bytes() })
      if (vt !== null) {
        await vt.settled()
        recordFrame(artifacts, vt.screen(), '起手失败-最后一眼')
      }
      artifacts.finish('failed', {
        failure: {
          step: '起手',
          kind: 'boot',
          detail: error instanceof Error ? error.message : String(error),
        },
        exit: { code: child?.exitCode ?? null, signal: child?.signalCode ?? null },
      })
      writeViewer(artifacts.runDir)
    } catch {
      // 留档自己炸了不该盖掉起手那个错——把原来的错抛回去就是了
    }
  }

  if (child !== null) await shutDown(child, 300)
  await releaseTerminal(fixture, vt, pty)
  if (sandbox !== null) {
    if (artifacts !== null) snapshotSandbox(sandbox, artifacts)
    sandbox.dispose()
  }
}

/**
 * 让子进程退场：先给一点**自己走**的余地，再 SIGTERM，再 SIGKILL——返回**谁让它退的场**。
 *
 * ⚠️ 「还在不在」**不能只看 `exitCode`**：被信号带走的进程 `exitCode` 恒为 `null`
 * （信号在 `signalCode` 里），只看前者会把「早就退了的」当成「还活着」，
 * 于是一路 SIGTERM→SIGKILL 下去，结局记成「我们杀的」（实测）。
 */
async function shutDown(child: Bun.Subprocess, graceMs: number): Promise<'app' | 'sigterm' | 'sigkill'> {
  const gone = (): boolean => child.exitCode !== null || child.signalCode !== null

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

  return by
}

/** 收尾三件：停夹具（端口跟着释放）· 放 VT · 关 PTY——`close` 与起手失败两条路共用。 */
async function releaseTerminal(
  fixture: Fixture | null,
  vt: Vt | null,
  pty: Bun.Terminal | null,
): Promise<void> {
  await fixture?.stop()
  vt?.dispose()
  try {
    pty?.close()
  } catch {
    // 已经关过了（`dropTerminal` 那条路先关的）——正常收场，不是错
  }
}

/** 把此刻的屏落成一帧（起手失败那条路要它：「卡在什么画面上」得有物证）。 */
function recordFrame(artifacts: Artifacts, screen: VtScreen, label: string): void {
  const painted = frameOf(paint(screen))
  artifacts.frame(
    {
      step: artifacts.info.steps,
      label,
      at: round(Date.now() - Date.parse(artifacts.info.startedAt)),
      columns: screen.columns,
      rows: screen.rows,
      cursor: screen.cursor,
      scrollback: screen.scrollback,
      total: screen.total,
      styles: painted.styles,
      lines: painted.lines,
      // 起手失败这一条**没有**取帧那一刻的 VT 水位可读（VT 可能就是没起来的那一件）——
      // 不编一个数：给 0，并由抬头那一行照实说这是起手失败那一张。
      bytes: 0,
      written: artifacts.bytes(),
    },
    screen.lines.map((line) => line.text).join('\n'),
  )
}

/**
 * 等「应用已经挂上、并且放开输入了」——**两跳**，缺一跳就会丢键。
 *
 * 1. **首帧落屏**：外壳起来的第一件事就是画一屏（字标 ＋ 分隔线 ＋ 输入行 ＋ 状态行）；
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
  options: {
    /**
     * 「放开输入」那一跳的判据——被测命令是**产品外壳**时才给（见函数头注第 2 条），
     * 且由被测对象那一侧给（`UiAnchors.ready`）。
     *
     * `null` ＝ **这一档没有这道闸**（如极窄窗上那句提示被整段省掉，等它必然白等满十五秒）。
     * 两条路都**记一步**：`ready`（闸真的开了）／`ready-gate-absent`（这一档没有闸，
     * 给一点起步余量就走）——**不把「没有闸」记成「闸开了」**。
     */
    readonly readyGate: WaitCondition | null
    /** 等第一帧的上限（缺省 20 秒；自证把它压小，好把起手失败那条路跑得完）。 */
    readonly timeoutMs: number
  },
): Promise<void> {
  const deadline = Bun.nanoseconds() + options.timeoutMs * 1e6

  for (;;) {
    const screen = await session.screen()
    if (screen.lines.some((line) => line.text.trim() !== '')) {
      // 首帧落了以后给 Ink 一点余量（它那一下 `tcsetattr` 落定之前来的按键会被丢掉——
      // 早先 pty 那几轮实测的坑 1）。这是**起手一次的余量**，不是场景同步手段。
      await Bun.sleep(120)
      if (options.readyGate !== null) {
        await session.wait(options.readyGate, { timeoutMs: 15_000 })
        artifacts.step('ready', { columns: screen.columns, rows: screen.rows })
      } else {
        // **没有闸可等**：不拿一句「等着等着就超时」把窄窗那一档整趟废掉，但也**不假装**——
        // 记一步说清是「这一档没有这道闸」，那几步起步余量是补它的（有界、且记账）。
        artifacts.step('ready-gate-absent', { columns: screen.columns, rows: screen.rows })
        await Bun.sleep(300)
      }
      return
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `应用还没画出第一帧就退了（退出码 ${child.exitCode} / 信号 ${child.signalCode}）——它说出的话在原始字节里：\n` +
          `${session.rawText().slice(-2_000)}\n现场：${artifacts.runDir}`,
      )
    }

    if (Bun.nanoseconds() > deadline) {
      throw new Error(`等了 ${options.timeoutMs}ms 还没等到第一帧——现场：${artifacts.runDir}`)
    }

    await Bun.sleep(10)
  }
}

/** 条件命中了吗（**只看可见屏**——`screen()` 交出来的就是可见区）。 */
function matches(condition: WaitCondition, screen: VtScreen, writtenSinceResize: string): boolean {
  if ('text' in condition) return screen.lines.some((line) => line.text.includes(condition.text))
  if ('absent' in condition) return !screen.lines.some((line) => line.text.includes(condition.absent))
  if ('writtenFrame' in condition) return hasFreshFrame(writtenSinceResize, condition.writtenFrame)
  const target = screen.lines[condition.at.row]

  return target !== undefined && target.text.includes(condition.at.text)
}

/** 一行里最长的一段连续横线。 */
function longestDashRun(line: string): number {
  let best = 0
  let run = 0
  for (const char of line) {
    run = char === '─' ? run + 1 : 0
    if (run > best) best = run
  }

  return best
}

/**
 * 有没有**按 `columns` 列画出来的那一帧**（见 `WaitCondition.writtenFrame` 的注）。
 *
 * 判据是**一整块的结构**：找到「正好 `columns` 个横线」的那一行（前后不紧挨横线——100 个横线里
 * 切得出 44 个），再看它两侧，且**两侧的行都得写完**：
 *
 * - **下游：下一行一个横线都不许有**。旧宽重画在输出阶段被 Ink 折成多段时，首段后面必然还跟着
 *   折行段；余数段只有 1–7 个横线（旧宽比新宽只大一点点的时候），所以这里是**严格零横线**，
 *   不是「少于几个」——阈值一放，余数段就被当成干净行了。
 * - **上游：上一行不能是「一整行横线且长度 ≥ 列数」**。折行的**末段**后面是干净行、长得和真帧
 *   一样，只能靠上游拦：它上一行正是上一折行段（正好 `columns` 个横线）。这里**不能**写成
 *   「上一行有没有横线」——真帧分隔线上面紧挨的是**记录行的末行**，模型答一张表或一条 markdown
 *   分隔线时那一行就带横线，那样会把真帧判成不过（套件在合法内容上超时，比假阳性更难查）。
 * - 「这一行是本段字节的第一行 ⇒ 上游不存在」**算干净**：改窗后的擦除序列不带换行，真帧的分隔线
 *   可能正是新写出的第一行。
 * - 「还没看到的下一行」不等于「下一行没有横线」：字节停在半截时继续等，既不判通过也不判拒绝
 *   （不能改成「下一行必须非空」：审批卡那种帧里分隔线下面就跟着空行）。
 *
 * 已知限度：记录行里若出现**整行、且长到列数**的横线（例如模型给的、宽度正好铺满的一条 markdown
 * 分隔线），它与折行段在字节上无从区分，会被当成上游而拒——这是这一层判据的固有边界，
 * 写进 `研发/界面验收工具` 的限度里。
 */
export function hasFreshFrame(bytes: string, columns: number): boolean {
  if (!Number.isInteger(columns) || columns <= 0) return false
  const needle = '─'.repeat(columns)

  for (let from = 0; ; ) {
    const at = bytes.indexOf(needle, from)
    if (at === -1) return false
    if (bytes[at - 1] !== '─' && bytes[at + needle.length] !== '─') {
      const lineEnd = bytes.indexOf('\n', at)
      const nextEnd = lineEnd === -1 ? -1 : bytes.indexOf('\n', lineEnd + 1)
      // 下一行得**写完**、且一个横线都没有
      if (lineEnd !== -1 && nextEnd !== -1 && !bytes.slice(lineEnd + 1, nextEnd).includes('─')) {
        const lineStart = bytes.lastIndexOf('\n', at - 1)
        // 上游：只在确有一整行时才判；「一整行横线且够长」才是折行的上一段
        if (lineStart === -1) return true
        const aboveStart = bytes.lastIndexOf('\n', lineStart - 1) + 1
        if (longestDashRun(bytes.slice(aboveStart, lineStart)) < columns) return true
      }
    }
    from = at + 1
  }
}

/** 条件的一句话（错误消息、步骤时间线、帧标签都用它）。 */
export function describeCondition(condition: WaitCondition): string {
  if ('text' in condition) return `出现「${condition.text}」`
  if ('absent' in condition) return `不再出现「${condition.absent}」`
  if ('writtenFrame' in condition) return `改窗之后应用按 ${condition.writtenFrame} 列画出完整一帧`

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
