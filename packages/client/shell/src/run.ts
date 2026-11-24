/**
 * 外壳 · 启动（缺陷轮 II 重画）——把一屏挂上终端。
 *
 * **内联渲染（经典）· 不接管整屏 · 不捕获鼠标**（原型开篇的渲染模型注）：
 * 内容写进终端**主缓冲** ⇒ 滚轮滚终端自己的 scrollback ✓ · 原生拖选复制 ✓ ——两个都免费。
 * （互斥的从来不是「滚轮 ↔ 拖选」，而是「**捕获鼠标** ↔ 原生拖选」。）
 *
 * **代价三条（用户已认下）**：输入框**不钉底**（跟内容走）· resize **不重排已滚出的历史** ·
 * 退出后内容**留在终端**。
 *
 * `useWindowSize` 仍在——尺寸一变，交互区与状态行按新尺寸重算（活动区那一小段就地重绘）；
 * **已滚出的历史不动**（它们在 `Static` 里，见 `components/app.ts`）。
 *
 * `exitOnCtrlC: false` —— Ctrl+C 归**外壳**判（空闲＝按两次退出 · **有在途工作＝开「当前任务
 * 去向」三选**，U100 起；见 `shell.ts` 的 `exitOrInterrupt`）。
 */

import { render } from 'ink'
import { createElement as h } from 'react'
import { createShell, type ShellOptions } from './shell.ts'
import { openFocusReport } from './focus.ts'
import { TuiApp } from './components/app.ts'
import { createSessionTitleTab } from './session-title-tab.ts'
import type { ControlTransport, ModelChoice, RunNotice, SessionId, StopScope } from '@magic/contracts'
import type { RunFeed, ResumeFeed, StopReport, SudoFeed } from './shell.ts'

/** 启动入参——传输由装配注入；`boot` 是「订阅之后、放开输入之前」那一跳。 */
export type RunTuiOptions = {
  readonly settingsOnly?: boolean
  readonly copyText?: ShellOptions['copyText']
  readonly detached?: ((listener: (why: string) => void) => void) | undefined
  readonly reopen?: (() => Promise<void>) | undefined
  readonly transport: ControlTransport
  /**
   * 启动流转（装配给）——恢复 / 重建要发事件，故**必须在订阅之后**跑
   * （技术方案 · 控制域：无订阅方时命令与事件都丢）。
   */
  readonly boot?: (() => Promise<void>) | undefined
  /** 注入终端流（测试用）——缺省＝真 stdin / stdout。 */
  readonly stdin?: NodeJS.ReadStream | undefined
  readonly stdout?: NodeJS.WriteStream | undefined
  /**
   * **上下文窗总量**（④ 的分母 · U20 留的位）——装配把**缺省条目声明的**那个数递进来
   * （`providers.<id>.contextWindow`），屏上 ④ 才一开局就是 `12.4k/200k`。
   *
   * 不给 / 条目没声明 ⇒ `null` ⇒ 只报已用量——**不编一个总量**（`D10` 那条判据）。
   * 另有一条来路：`/model` 跑过一次之后由 `model.catalog` 定（那一路要**换过模型**才对得上）。
   */
  readonly statusLine?: ShellOptions['statusLine']
  readonly turnDuration?: 'elapsed' | 'active' | undefined
  readonly reducedMotion?: boolean | undefined
  readonly contextWindow?: number | null | undefined
  /**
   * **开局落地的那一档模型**（状态行 ③ 的开机那一格）。
   *
   * 与 `contextWindow` **同一个来源**（`terminal.ts` 的 `startupRegistry().current()`）：
   * 那一位给分母，这一位给名字——两处各算一遍就会分叉。不给 ＝ 不知道 ⇒ 那一格省掉。
   */
  readonly modelChoice?: ModelChoice | undefined
  /**
   * **本进程的工作区**（U26）——`/resume` 那一屏据它认「别的项目」（分组头 ＋ 压暗）。
   * 装配把执行域的 `roots()` 递进来；**不给＝不知道自己在哪儿**（一组都不压暗）。
   * 见 `ShellOptions.workspaceRoots`。
   */
  readonly workspaceRoots?: readonly string[] | undefined
  /**
   * **数据目录**（U71 · `/config` 第 4 行那一格）——已解析的绝对路径。
   * 见 `ShellOptions.dataDir`。
   */
  readonly dataDir?: string | undefined
  /** **系统家目录**（U71 · 只用来把屏上的路径缩成 `~/…`）。见 `ShellOptions.home`。 */
  readonly home?: string | undefined
  /**
   * **Magic 的落点**（U100 · `MagicHome.base`）——转后台留接回入口时明确携带
   * 其父目录为 `MAGIC_HOME`。见 `ShellOptions.magicBase`。
   */
  readonly magicBase: string
  /**
   * **启动那几句要说的话**（U22 · 审计第 13 条）——装配把话备好（`Assembly.notices`：
   * 被拒的权限规则 / 授权文件读不懂），外壳开局落成记录区里的一行回执。
   *
   * 不给 / 空数组＝启动一句多余的话都不说（常态）。见 `ShellOptions.receipts`。
   */
  readonly receipts?: readonly string[] | undefined
  /**
   * **外面那一头（运行管理者）没了**（U48 · **U100 改判**）——订阅它；回调一响，把这件事
   * **交给外壳如实说**。
   *
   * ⚠️ **不再「窗口自己退」**（原锚：「那条连接一断，界面就没有任何可接的东西了，留着
   * 只是空转占着机器」）。规划裁决写着「控制连接丢失……**留在界面如实说明；不得自动退场**」，
   * 设计那一行也是：「管理者不可达时**界面显示失联**，不把历史 `running` 当现况」。
   * 空转的代价由此处认下：这一屏此刻**只负责说清与离开**（状态那一格改成「状态待确认」、
   * 输入不受理、`ctrl+c` 两下走）。
   *
   * ⚠️ **与 stdin 断开那条（D26）是两条独立的**「这一头没人了」：一条是**终端**没了
   * （那一头已经没人在看、也没人在按，收摊），一条是**内核**没了（这一头的人还在看）。
   */
  readonly onGone?: ((listener: (why?: string) => void) => void) | undefined
  /**
   * **运行事实的来路**（U49）——`/resume` 那一屏每一行的状态据它来。
   *
   * 由管理者推（**服务状态**，不是内核事件）：不给 ⇒ 那一屏照旧只有目录，一行状态都不标。
   * 见 `ShellOptions.runs`。
   */
  readonly runs?: RunFeed | undefined
  /** **接回快照的来路**（U49）——挂到某一代上之后取来那一代的「此刻」。见 `ShellOptions.resumed`。 */
  readonly resumed?: ResumeFeed | undefined
  /**
   * **这一趟开局就接的那条会话**（`resume <id>`）——只用于**开屏那张摘要**：
   * 它是「为它来的那条」，不算「别的活跃工作」（设计：摘要说的是**其他**活跃工作）。
   *
   * 拿不到就不给 ⇒ 摘要照常数全部——**不猜**（那一位本来就是可省的开局参数）。
   */
  readonly openingSession?: string | undefined
  /** **停一条运行**（U50）——整体 / 局部，由用户明确选择。见 `ShellOptions.stop`。 */
  readonly stop?: ((session: SessionId, scope: StopScope) => void) | undefined
  /** **停止走到了哪一拍**（U50）——受理 / 已核销 / 没能证实，各落一行回执。见 `ShellOptions.stopped`。 */
  readonly stopped?: ((listener: (report: StopReport) => void) => void) | undefined
  /** **管理者说的那句话**（U50 接上）——见 `ShellOptions.lines`。 */
  readonly lines?: ((listener: (text: string) => void) => void) | undefined
  /** **刚刚发生了一件事**（U50）——完成 / 失败 / 需要你。见 `ShellOptions.notices`。 */
  readonly markRead?: ((ids: readonly string[]) => void) | undefined
  readonly notices?: ((listener: (notice: RunNotice) => void) => void) | undefined
  /** **sudo 密码组件**（U129）——密码只经这条瞬时通道到 Engine。 */
  readonly sudo?: SudoFeed | undefined
  /** **语音输入**（U135）——装配把本机能力递进来；不给＝这台机器上没有语音入口。 */
  readonly voice?: ShellOptions['voice'] | undefined
  /** **实验性 · 语音输入开着没有**（D75）——缺省关，此后随 `prefs.state` 走。 */
  readonly voiceEnabled?: boolean | undefined
}

/** 挂上终端之后的把手。 */
export type TuiHandle = {
  /** 等外壳收摊（用户退出 / Ctrl+C）。 */
  waitUntilExit(): Promise<void>
}

export async function runTui(options: RunTuiOptions): Promise<TuiHandle> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout

  // **不是终端就说人话**（Ink 在非 TTY 上抛 raw mode 的栈——用户看不懂，也不是他的错）
  if (stdin.isTTY !== true) {
    throw new Error('外壳需要一个终端（stdin 不是 TTY）——请在终端里启动。')
  }

  // 页签标题（OSC 0）——**只在真终端上写**（管道 / 测试假流不碰；见 `ShellOptions.sessionTitleTab`）
  const sessionTitleTab = stdout.isTTY === true ? createSessionTitleTab(stdout) : undefined

  // ④ 的分母（装配给）——没给就是「拿不到」，屏上回退成只报已用量（见 `RunTuiOptions`）
  const shell = createShell(options.transport, {
    settingsOnly: options.settingsOnly,
    copyText: options.copyText,
    statusLine: options.statusLine,
    reducedMotion: options.reducedMotion,
    turnDuration: options.turnDuration,
    contextWindow: options.contextWindow ?? null,
    modelChoice: options.modelChoice,
    workspaceRoots: options.workspaceRoots,
    dataDir: options.dataDir,
    home: options.home,
    magicBase: options.magicBase,
    receipts: options.receipts,
    runs: options.runs,
    resumed: options.resumed,
    detached: options.detached,
    reopen: options.reopen,
    openingSession: options.openingSession,
    voice: options.voice,
    voiceEnabled: options.voiceEnabled,
    stop: options.stop,
    stopped: options.stopped,
    lines: options.lines,
    notices: options.notices,
    sudo: options.sudo,
    markRead: options.markRead,
    ...(sessionTitleTab === undefined ? {} : { sessionTitleTab }),
    // **「放开输入」以 `boot` 完成为界**（技术方案 · 装配视图第 5 步 · U25 收敛）——
    // 没有 `boot` 可等的调用方（测试 / 演示）照旧一挂载就能提交。
    inputReady: options.boot === undefined,
  })

  // **右 ⌥ 那一下**（U135）——不走终端：终端默认编码里没有裸修饰键，报它就得改键盘协议，
  // 而那个协议位会毁掉输入法。改由本机只读监听（`CGEvent` listen-only）取，监听器随 TUI 启停。
  //
  // ⚠️ **那一下是系统级的**（D75）：同一下按键，每个 Magic 窗口的监听都听得见。故先开
  //    终端的**焦点上报**（DECSET 1004），只有「这一屏此刻拿焦点」时才认——三条规矩
  //    （未知不触发 · 按下与松开要在同一屏 · 退出复原）都在 `focus.ts` 里。
  //
  // ⚠️ 上报是**从 stdin 进来的字节**，与 Ink 读的是同一根流：我们只认、不消费
  //    （`feed` 不动流）；Ink 那一头交上来的 `[I` / `[O` 由 `input.ts` 剥掉，不进草稿。
  /**
   * **这一跳接不接**（D75 · `/config` 的「实验性功能 › 语音输入」）——**缺省不接**。
   *
   * 开着才起监听器、才开焦点上报（`?1004h`）；关着时一件事都不做（连字节都不发）。
   * 开与关**随屏上的读数走**（`view.voiceEnabled`）：`/config` 里一按，落定读数经
   * `prefs.state` 回来，这一处就跟着起停——不用重启界面，也不各记一份。
   */
  let focusing: ReturnType<typeof openFocusReport> | null = null
  let stopHotkey: (() => void) | null = null
  const applyVoice = (enabled: boolean): void => {
    if (options.voice === undefined) return
    if (enabled && stopHotkey === null) {
      focusing = openFocusReport(stdin, stdout)
      stopHotkey = options.voice.listen((phase) => {
        // 没有闸门（这一帧还没开上报）＝不认：判不出焦点就不触发（见 `focus.ts`）
        if (focusing !== null && focusing.gate.tap(phase, Date.now())) shell.key({ kind: 'voice' })
      })
      return
    }
    if (!enabled && stopHotkey !== null) {
      stopHotkey()
      stopHotkey = null
      focusing?.close()
      focusing = null
    }
  }
  applyVoice(shell.getView().voiceEnabled)
  // 屏上那一格变了就跟着起停——**同一个读数**，不另存一份「我记得开着」
  const unsubscribeVoice = shell.subscribe(() => applyVoice(shell.getView().voiceEnabled))

  const app = render(h(TuiApp, { shell }), {
    stdin,
    stdout,
    // ⚠️ **不接管整屏**（第 21 轮 · 渲染模型＝内联）：内容写进终端主缓冲 ⇒
    // 滚轮滚终端自己的 scrollback ✓ · 原生拖选复制 ✓ ——两个都免费。
    // 代价（用户已认下）：输入框不钉底、resize 不重排已滚出的历史、退出后内容留在终端。
    // 也不捕获鼠标（Ink 默认不捕获；`usePaste` 开的是 bracketed paste `?2004h`，
    // 那是**粘贴**不是鼠标上报——拖选照旧可用）。
    alternateScreen: false,
    // Ctrl+C 由外壳判（空闲＝按两次退出 / 有在途工作＝开三选——见 `shell.ts`）
    exitOnCtrlC: false,
    // **键盘协议**（U20 · 差距 4）——`shift+回车` 要**分得出来**，只能靠它。
    //
    // 由头：裸终端里 `shift+回车` 与 `回车` 常常发的是同一个 `\r`，外壳**无从分辨**；
    // kitty 键盘协议（Ghostty / kitty / WezTerm 等）让它报成独立的 `CSI 13;2u`。
    // 要的旗标只一样：`disambiguateEscapeCodes`（带修饰的键不再与裸键同形）。
    //
    // ⚠️ 取 `enabled`（**不取 `auto`**）——理由是**实测**的：`auto` 那条路要在开工那一下
    //    发 `CSI ? u` 问终端、**200ms 内**收到应答才开，而那一跳正落在启动最吵的时候
    //    （pty 里真跑过：应答被终端的回显吃掉、协议没开起来，`shift+回车` 当场与 `回车` 同形）。
    //     `enabled` 是无条件推一把（`CSI > 1 u`）：支持的终端照办，**不支持的终端按规范忽略
    //     未知 CSI**——退化成今天的样子（`shift+回车` ＝ `回车`），不会更坏。退出时 Ink 弹回。
    // ⚠️ **不要加 `reportEventTypes`**（U135 撞过一次）：开了它，终端会把**松键**也报上来，
    //    而松键那一串照样带着正文（`CSI 97;1:3u` → `text: 'a'`），Ink 的 `useInput` 认不出
    //    「这是松手」——于是**每按一个字都落两遍**（按下一次、松手一次）。
    //    要的只是「裸修饰键按下了」，那一条 `reportAllKeysAsEscapeCodes` 就够了。
    // ⚠️ **不要加 reportAllKeysAsEscapeCodes / reportEventTypes**（U135 撞过两次）：
    //    前者让终端把输入法组字时的按键也送进来（空格不再选候选），后者把松键也当按键。
    //    语音键不走终端编码——由本机只读监听（`CGEvent` listen-only）取得，见 `voice.ts`。
    kittyKeyboard: { mode: 'enabled', flags: ['disambiguateEscapeCodes'] },
  })

  // ——**终端断流**（D26 · P0）——
  //
  // 窗口关了 / 管道断了：`stdin` 抬 `end` ＋ `close`（真跑实测：关掉 PTY master 后 1ms 内到）。
  // 产品原先**不消费**它，于是卡在一条**走不到的等待**上：`Ink` 在没有退出信号时的兜底是
  // `process.once('beforeExit')`，而 `beforeExit` **只在事件循环空了才触发**——fd 停在
  // 「可读（EOF）」的就绪态时，Bun 的事件循环每次都立刻转回来，那个回调**永远不会来**。
  // 实测（独立监督）：断开 3 秒 CPU 时间涨 5.0 秒、再 4 秒又涨 6.6 秒，状态 `R`，不退出。
  //
  // ## U100 起这一跳只剩「收摊」（那半套等待删掉了）
  //
  // 旧写法走的是「收尾语义」：空闲＝退出 · **工作中／有待答＝替用户发一次中断**，然后等它
  // 收束（有界 5 秒：一份自订订阅 ＋ 一只兜底计时器 ＋ `ending`/`unmounted` 两道闸）。而设计
  // 2026-09-21 起定的是：**关窗口只是离开界面，不是取消工作**（「停止是独立且明确的操作」）。
  // ⇒ 那一整套等待的由头跟着没了：断流不再触发任何一次中断，也就没有「等它收束」可言。
  // 这一跳于是回到它本来的样子——**终端这一头没人了，收摊**。
  //
  // ⚠️ **监听装在整个挂载周期上**（就在 `render` 之后、`boot` 之前那一行）：
  //    `end` / `close` 只在发生那一刻派发**一次**，恢复（`boot`）那一段里终端断了的话，
  //    装晚一步就永远收不到——那种「晚了」由下面那道状态补判据兜住。
  //
  // ⚠️ **`unmounted` 那道闸不能省**：`end` 与 `close` 前后脚（实测 1ms 内），信号还可能再来
  //    一下——`app.unmount()` 只该走一次（重入会让 Ink 抛「已经卸载」一类的话，把真因盖掉）。
  let unmounted = false
  let terminalGone = false

  /** 真收摊——**只走一遍**（`unmounted` 守门）。 */
  const closeOut = (): void => {
    if (unmounted) return
    unmounted = true
    applyVoice(false)
    app.unmount()
  }

  /**
   * 终端没了（或外面让我们收摊）——**收摊那一件只走一遍**（`unmounted` 守门）。
   *
   * ⚠️ **U100 起这里不再问外壳**：旧写法走 `Shell.hangUp()`——那一跳会**替用户发一次中断**
   * （「工作中／有待答 ⇒ 取消这一轮」）。设计 2026-09-21 裁掉的就是那件事：**关窗口只是
   * 离开界面，不是取消工作**。于是那一问没有了对象，`hangUp` 一并删掉（一个常量方法留着
   * 只是给旧分工留个壳）。断流这一跳从此只剩：**终端这一头没人了 ⇒ 收摊**。
   */
  const onTerminalGone = (): void => {
    terminalGone = true
    closeOut()
  }

  /** 把这一组监听摘掉——**两条出口共用这一份清单**（正常收尾 / `boot` 抛错）。 */
  const unhook = (): void => {
    // 语音那一跳收尾（D75 第三条）：监听器停掉、焦点模式复原——**两条出口共用这一处**
    unsubscribeVoice()
    applyVoice(false)
    for (const event of ['end', 'close', 'error'] as const) stdin.off(event, onTerminalGone)
    for (const signal of ['SIGHUP', 'SIGTERM'] as const) process.off(signal, onTerminalGone)
  }

  for (const event of ['end', 'close', 'error'] as const) stdin.on(event, onTerminalGone)
  // 退出信号同一条收尾（`SIGHUP`：真终端关窗那一路；`SIGTERM`：外部收摊那一路）。
  // ⚠️ 挂了处理器之后信号本身**不再杀进程**——所以必须真走到 `unmount`，
  //    否则就成了「按下不动」（`ui.ts serve` 那处踩过同一个坑）。
  for (const signal of ['SIGHUP', 'SIGTERM'] as const) process.on(signal, onTerminalGone)

  // **已经结束了的，也算数**：`end` / `close` 派发过了就不再重来——终端在监听装上之前
  // 就断了（起手那一段，或恢复跑到一半）的话，上面那些监听一个都不会响。故补一道
  // **状态**判据：流已经读到过头 / 已经销毁，就等于刚收到那一下。
  if (stdin.readableEnded === true || stdin.destroyed === true) onTerminalGone()

  // **外面那一头没了 ⇒ 交给外壳说清（不退场）**——见 `RunTuiOptions.onGone` 那一段
  options.onGone?.((why?: string) => {
    shell.disconnected(why)
  })

  try {
    // **先接订阅（构造即订阅）→ 再跑启动流转 → 最后才放开输入**
    //
    // 中间这一跳（`boot` ＝应用层的恢复用例：装载 ＋ 在途处置 ＋ 重建）**要发事件**，
    // 故必须在订阅之后；而**输入要到它跑完才受理**——反了就是「恢复还没完、用户先把
    // 下一轮派出去了」，两条流当场抢同一条记录。`releaseInput` 就是那道闸。
    await options.boot?.()
    shell.releaseInput()
    // 同进程 boot 期间输入闸门拦住了历史查询，启动完成后补读。
    // 常驻连接由首次 session.state 读取；重复重建会抹掉已呈现的接回流式快照。
    if (options.boot !== undefined) shell.readHistory()
  } catch (error) {
    // 监听现在装在整个挂载周期上（见上），这条出口**也得把它们摘掉**——
    // 否则 `boot` 抛错之后，那些监听还挂在一根已经没人管的流上
    unhook()
    app.unmount()
    shell.dispose()
    throw error
  }

  let exitPrinted = false
  return {
    waitUntilExit: async () => {
      try {
        await app.waitUntilExit()
        if (!terminalGone && !exitPrinted) {
          exitPrinted = true
          const note = shell.exitNote()
          if (note !== null) stdout.write(`\n${note}\n`)
        }
      } finally {
        unhook()
        shell.dispose()
      }
    },
  }
}
