import type { WorkEnvironment } from '../work-environment.ts'
import { diagnosticsOf, validDiagnosticsChange } from '@magic/contracts'
import { DiagnosticLog } from '../diagnostic-log.ts'
import type { RecordsStore } from '@magic/records'
import type { ProcessLedger } from '@magic/contracts'

import type {
  CollaborationReply,
  KernelEvent,
  MagicHome,
  ModelSwitchRequest,
  RunSnapshot,
  SnapshotDecision,
} from '@magic/contracts'
import { assemble } from '../assembly.ts'
import type { Assembly } from '../assembly.ts'
import { loadConfig } from '../config.ts'
import { isProgress, progressOf, tailOf } from './facts.ts'
import type { ExecutorToManager, Link, ManagerToExecutor } from './wire.ts'

/**
 * 收缩前那一段余量（毫秒）——见 `considerShrink` 的注。
 *
 * 半秒：够一次「窗口走了、另一个窗口立刻接上」的往返（本机 socket，实际是毫秒级），
 * 又不至于让一个真没人要的进程白占着机器。
 */
const SHRINK_SETTLE_MS = 400

/**
 * **接回快照里那份流式正文带多大**（字符）——见 `liveOf` 的注。
 *
 * 十万字符≈五万 token：一条助手消息长到这个量级已经不是常态。留这么大是为了
 * **绝大多数接回都不必截断**——而真截断的时候要**说得出来**（`textTruncated`）。
 */
const SNAPSHOT_TEXT_LIMIT = 100_000

/** 快照里一条在飞工具的输出留多少行——取**末尾**（末尾才是「刚才在说什么」）。 */
const SNAPSHOT_OUTPUT_LINES = 20

/** 攒一条工具输出时留多少字符——**先按字符封顶**（长测试一行能吐几十万字符）。 */
const SNAPSHOT_OUTPUT_CHARS = 4_000

/** 在飞的一条工具调用——输出按末尾一截攒，快照时再切成行。 */
type LiveTool = {
  readonly call: number
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly at: number
  output: string
}

export type ExecutorOptions = {
  readonly network: WorkEnvironment
  readonly link: Link<ManagerToExecutor>
  readonly executionId: string
  readonly records: RecordsStore
  readonly ledger: ProcessLedger
  readonly environment: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  /** **显式接续**那条会话（`magic resume` 同义物）；`null` ＝ 还没开张（D5）。 */
  readonly session: string | null
  /** **启动目录**——窗口在哪儿起的（配置没写 `workspaceRoots` 时它就是默认根）。 */
  readonly cwd: string
  /**
   * **统一基础路径**（U42）——配置 / 授权 / 用户技能都从它派生。
   *
   * ⚠️ **由管理者给，不从环境解析**：`MAGIC_HOME` 只说得清「Magic 落在哪」，而
   * `home`（`~/…` 展开到哪）与 `base` 是两件——测试沙地指到临时目录时，执行者若照
   * 环境自己解析一遍，读到的是开发者**真那份**配置（`launch.ts` 头注同此）。
   */
  readonly magic: MagicHome
  /** **开局的换模型请求**（`--model`）——装配之后、开工之前落地。 */
  readonly switch?: ModelSwitchRequest | undefined
  /**
   * **全放行**（U73）——命令行 `--allow-all` 在这一个窗口上定下的那个布尔。
   *
   * ⚠️ **它必须赶在装配之前**（不像 `switch` 能等装配之后落地）：闸门是**装配期造的**，
   * 造完就没有改它的口——它正是「对话期间切不进去」那条规矩在代码里的形状。
   */
  readonly allowAll?: boolean | undefined
  /** 诊断——缺省不打印（这条线上不写业务日志）。 */
  readonly log?: ((line: string) => void) | undefined
}

/** 收场——`runExecutor` 的几种结局，交回给入口去定退出码。 */
export type ExecutorOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * 跑一个执行者——**连上管理者、装配、报 ready、架桥，然后一直服务到收摊**。
 *
 * 返回时**保证**收尾两跳已经走过（外部服务器释放 ＋ 关库）：调用方随即可以退进程。
 */
export async function runExecutor(options: ExecutorOptions): Promise<ExecutorOutcome> {
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, options.signal])
  const link = options.link
  const disconnected = new Promise<void>(resolve => link.onClose(() => resolve()))
  const requests = new Map<string, (reply: CollaborationReply) => void>()
  link.onMessage(message => {
    if (message.t !== 'collaboration.reply') return
    const done = requests.get(message.requestId)
    requests.delete(message.requestId)
    done?.(message.reply)
  })
  link.onClose(() => {
    for (const done of requests.values()) done({ ok: false, reason: '管理者连接已断开；请求结果可按原 operationId 查询，不自动重做' })
    requests.clear()
  })
  let diagnosticLog: DiagnosticLog | undefined
  let assembly: Assembly
  try {
    const magic = options.magic
    let config = loadConfig({ magic })
    diagnosticLog = new DiagnosticLog('executor', options.magic.base, diagnosticsOf(config.config).logLevel)
    diagnosticLog.write('info', 'executor.started', options.session === null ? {} : { session: options.session })
    let cwd = options.cwd
    if (options.session !== null) {
      const records = options.records
      {
        const session = (await records.listSessions()).find((one) => one.id === options.session)
        if (session === undefined) throw new Error('会话已不可达')
        if (session.workspace !== undefined && session.workspace.length > 0) {
          cwd = session.workspace[0]!
          config = { ...config, config: { ...config.config, workspaceRoots: session.workspace } }
        }
      }
    }
    assembly = assemble({
      executionId: options.executionId,
      records: options.records, ledger: options.ledger, environment: options.environment, network: options.network, signal,
      collaborationChanged: () => { link.send({ t: 'collaboration.changed' }) },
      collaboration: (_session, request) => new Promise(resolve => {
        const requestId = crypto.randomUUID()
        requests.set(requestId, resolve)
        if (!link.send({ t: 'collaboration.request', requestId, request })) {
          requests.delete(requestId)
          resolve({ ok: false, reason: '管理者连接不可用' })
        }
      }),
      cwd,
      config,
      magic,
      // **显式接续**：给了 id 就是那条会话；不给＝一个会话都不开（D5）
      ...(options.session === null ? {} : { session: options.session }),
      // 全放行——**造闸门用的那一跳**（见 `ExecutorOptions.allowAll`）
      ...(options.allowAll === true ? { allowAll: true } : {}),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 失败也先用启动令牌登记，管理者才能把具体原因回传给所属终端。
    link.send({ t: 'assembled',
      session: options.session, workspace: [] })
    link.send({ t: 'done', why: `装配没成：${reason}` })
    link.close()
    diagnosticLog?.write('error', 'executor.failed')
    await diagnosticLog?.close()
    return { kind: 'failed', reason }
  }

  /**
   * **开局的换模型请求**——落地在**登记之前、收命令之前**（「开局选中在放开输入之前
   * 落地：开局那几轮就该走它，而不是第一轮走缺省、第二轮才换」——`cli.ts` 那条先例）。
   *
   * 它落在**这一代自己的**注册表上（注册表是执行者件的、进程级的），故不去动别的
   * 执行者的选中——「模型选择按 Agent 独立装配，不共享可变选择」。
   */
  if (options.switch !== undefined) {
    const result = assembly.switchModel(options.switch)
    if (!result.ok) {
      link.send({ t: 'assembled', session: options.session, workspace: [] })
      link.send({ t: 'done', why: result.reason })
      await assembly.shutdown()
      assembly.close()
      link.close()
      return { kind: 'failed', reason: result.reason }
    }
    options.log?.(`开局选中 → ${result.selection.choice}`)
  }

  // **登记**（`hello`）在装配之后发：工作区整组根是装配才算得出来的
  // （配置里的 `workspaceRoots` 或启动目录，判断归执行域）——登记里要它。
  link.send({
    t: 'assembled',
    session: options.session,
    workspace: assembly.workspaceRoots,
  })

  // 收缩只认执行责任：在途轮次、待答裁决和后台命令；观察连接不保活。
  let busy = false
  /** 待答的裁决——按**那次工具调用**记（请求与答复两头都带 `call`，配对键就是它）。 */
  const pendingDecisions = new Set<number>()

  /**
   * **此刻这一轮长什么样**（U49）——**接回快照**的取材（设计 · 状态可信度、独占与重新连接 ③）。
   *
   * 为什么得由执行者攒：流式增量（`model.delta` / `tool.output.delta`）**不落库**
   * （记录域那条「不逐条落库」的规矩），故**记录里根本没有它们**——一个刚接回来的窗口
   * 若只读记录，看到的是一段**没有开头**（或者更坏：把上一轮半段当完整结果）的回复。
   * 那份「此刻」只有一直看着事件流的这一头有。
   *
   * 攒的规矩**与外壳那一侧同一套**（`view.ts` 的归约）——两处各写一套「哪条增量算哪一段」
   * 必然分叉，而分叉的症状是「接回来之后那一段与别人屏幕上不一样」。
   */
  const live = {
    /** 水位——这一头见过的**最后一条事件的 id**（快照就停在这儿）。 */
    lastId: 0,
    /** 这一轮开着吗（`turn.start` 之后、`turn.end` 之前）。 */
    turnOpen: false,
    /** 在飞的助手正文 / 思考（按通道攒）。 */
    text: '',
    thinking: '',
    /** 攒到头了没有——攒到头就**只留末尾**，并如实标出来（不冒充完整）。 */
    textTrimmed: false,
    thinkingTrimmed: false,
    /** 在飞的工具调用（有 `tool.call`、还没有 `tool.result`）——输出按**末尾一截**攒。 */
    tools: new Map<number, LiveTool>(),
    /** 还挂着的裁决卡（有请求、还没答复）——答复了／轮收束了就撤。 */
    decisions: new Map<number, SnapshotDecision>(),
    /** 最近一次可确认进展与最近一次输出（与管理者那一侧同一份口径）。 */
    progress: undefined as { readonly at: number; readonly what: string } | undefined,
    output: undefined as { readonly at: number; readonly sample: string } | undefined,
    /** 在跑的模型与它的窗（`model.call.start` 自带）——状态行那两格。 */
    model: undefined as string | undefined,
    window: undefined as number | undefined,
  }

  /** 攒一段流式正文——**有界**：超了就只留末尾，并记下「截过」。 */
  function gather(which: 'text' | 'thinking', chunk: string): void {
    const merged = `${live[which]}${chunk}`
    if (merged.length <= SNAPSHOT_TEXT_LIMIT) {
      live[which] = merged
      return
    }
    live[which] = merged.slice(-SNAPSHOT_TEXT_LIMIT)
    if (which === 'text') live.textTrimmed = true
    else live.thinkingTrimmed = true
  }

  /** 一次新回复开始时把在飞那一段清空（`turn.start` / `model.call.start` / 助手落账三处）。 */
  function resetStream(): void {
    live.text = ''
    live.thinking = ''
    live.textTrimmed = false
    live.thinkingTrimmed = false
  }

  /** 这一轮的「此刻」——一份**现算**的快照（收到请求当场答，中间不 await，见 `wire.ts`）。 */
  function snapshotNow(): RunSnapshot {
    return {
      watermark: live.lastId,
      turnOpen: live.turnOpen,
      ...(live.text === '' ? {} : { text: live.text }),
      ...(live.thinking === '' ? {} : { thinking: live.thinking }),
      ...(live.textTrimmed ? { textTruncated: true } : {}),
      ...(live.thinkingTrimmed ? { thinkingTruncated: true } : {}),
      tools: [...live.tools.values()].map((tool) => ({
        call: tool.call,
        name: tool.name,
        args: tool.args,
        at: tool.at,
        output: tool.output.split('\n').slice(-SNAPSHOT_OUTPUT_LINES),
      })),
      decisions: [...live.decisions.values()],
      ...(live.progress === undefined ? {} : { progress: live.progress }),
      ...(live.output === undefined ? {} : { output: live.output }),
      ...(live.model === undefined ? {} : { model: live.model }),
      ...(live.window === undefined ? {} : { window: live.window }),
      // **这一代的它**（U73）——**由这一代自己报**，不押窗口那一侧的 argv：
      // 挂上一条**已经活着**的那一代时，那一代带的是它起手带的那个布尔，与此刻这个窗口
      // 敲的命令行无关（同一个会话可能正被两个窗口看着）。窗口据它画状态行那一格——
      // 「报的是闸门此刻真的怎么判」，不是「我以为我带没带那个参数」。
      ...(options.allowAll === true ? { allowAll: true } : {}),
    }
  }

  /**
   * 一条事件进来了——**两件事同一次过一遍**：① 收缩的判据（`busy` / 待答项）；
   * ② 快照的取材（`live`）。分两个 switch 写同一件事，迟早有一处只更新了一半。
   */
  function track(event: KernelEvent): void {
    diagnosticLog?.write(event.kind === 'error' ? 'error' : event.kind === 'turn.start' || event.kind === 'turn.end' ? 'info' : 'trace', `kernel.${event.kind}`, { ...(event.session ? { session: event.session } : {}) })
    // 水位跟着事件走——快照停在「这一条上」，水位之后的都还没发生
    live.lastId = event.id

    if (isProgress(event)) {
      const what = progressOf(event)
      if (what !== undefined) live.progress = { at: event.at, what }
    }

    switch (event.kind) {
      case 'agent.state':
        busy = event.data.state !== 'waiting'
        return

      // —— 这一轮那几件（快照的取材）——

      case 'turn.start':
        live.turnOpen = true
        resetStream()
        live.tools.clear()
        live.decisions.clear()
        return

      case 'turn.end': {
        live.turnOpen = false
        resetStream()
        live.tools.clear()
        live.decisions.clear()
        /**
         * **轮收束 ⇒ 悬着的裁决作废**——与外壳那一侧**同一个口径**（`view.ts` 的
         * `turn.end`：「悬着的裁决作废（那件工具跑不成了）：撤卡 ＋ 归还草稿」）。
         *
         * ⚠️ **不清这一下，会漏一个永远收不掉的执行者**（实测跑出来的）：卡挂在半路、
         * 这一轮被中断（Ctrl+C）或出错时，**裁决答复那一条事件不会来**——于是这个集合里
         * 那一格永远留着，而「有在途调用或待答项」是**不收**的一条判据 ⇒ 它就此钉在那儿，
         * 管理者也跟着不走（它以为手上还压着一件待办）。
         *
         * 清了之后设计那一条不受影响：**卡还挂着**的时候这一轮没结束，`turn.end` 就不会来
         * ——「等待用户的有效工作可保留事件阻塞的执行者」照旧成立。
         */
        pendingDecisions.clear()
        return
      }

      // 一次模型调用＝一段回复：新的一段从空开始（视图那一边的「同通道增量并进上一行」
      // 也是这么分的——两段之间隔着工具行）
      case 'model.call.start':
        resetStream()
        live.model = event.data.model
        live.window = event.data.inputBudget
        return

      case 'model.delta':
        if (event.data.channel === 'text') gather('text', event.data.text)
        if (event.data.channel === 'thinking') gather('thinking', event.data.text)
        return

      // 助手那条**已落账**（内容进了条目）⇒ 在飞的那一段到此为止
      case 'message.assistant':
        resetStream()
        return

      case 'tool.call':
        live.tools.set(event.id, {
          call: event.id,
          name: event.data.name,
          args: event.data.args,
          at: event.at,
          output: '',
        })
        return

      case 'tool.output.delta': {
        live.output = { at: event.at, sample: tailOf(live.output?.sample, event.data.text) }
        const tool = live.tools.get(event.data.call)
        // 末尾一截就够（快照里那几行说的是「刚才在说什么」）
        if (tool !== undefined) {
          tool.output = tailOf(tool.output, event.data.text, SNAPSHOT_OUTPUT_CHARS)
        }
        return
      }

      case 'tool.result':
        live.tools.delete(event.data.call)
        return

      case 'tool.decision.request':
        pendingDecisions.add(event.data.call)
        live.decisions.set(event.id, {
          id: event.id,
          call: event.data.call,
          name: event.data.name,
          material: event.data.material,
          weight: event.data.weight,
          ...(event.data.external === true ? { external: true } : {}),
        })
        return

      case 'tool.decision':
        pendingDecisions.delete(event.data.call)
        for (const [id, one] of live.decisions) {
          if (one.call === event.data.call) live.decisions.delete(id)
        }
        return

      default:
        return
    }
  }

  /** 收缩的等待器——只留一个（重新判一次就够，不必每个事件都排一个）。 */
  let shrinkTimer: ReturnType<typeof setTimeout> | undefined

  /** 合并相邻事件后再确认无责任，避免当前调用链尚未派完就释放进程。 */
  function considerShrink(): void {
    if (closing) return
    if (busy || assembly.hasPendingInput() || live.turnOpen || pendingDecisions.size > 0 || (assembly.background?.running().length ?? 0) > 0) {
      if (shrinkTimer !== undefined) {
        clearTimeout(shrinkTimer)
        shrinkTimer = undefined
      }
      return
    }
    if (shrinkTimer !== undefined) return

    shrinkTimer = setTimeout(() => {
      shrinkTimer = undefined
      if (closing || busy || assembly.hasPendingInput() || live.turnOpen || pendingDecisions.size > 0 || (assembly.background?.running().length ?? 0) > 0) return

      // **持久化状态后释放**（设计 · 收缩）：收尾那两跳里就有「把没落完的落完」
      // ——故它是释放，不是丢下。
      link.send({ t: 'done', why: '没有在途调用、后台命令或待答项' })
      void closeOut('当前工作已结束')
    }, SHRINK_SETTLE_MS)
  }

  /** 收摊只走一遍——断开来一次、`bye` 来一次，两条路汇到这儿。 */
  const inFlight = new Set<Promise<void>>()
  function trackOperation(operation: Promise<unknown>): void {
    const pending = operation.then(() => {}, error => {
      link.send({ t: 'done', why: `操作失败：${error instanceof Error ? error.message : String(error)}` })
      queueMicrotask(() => { void closeOut('本项操作失败') })
    }).finally(() => inFlight.delete(pending))
    inFlight.add(pending)
  }
  let closing = false
  let closingTask: Promise<void> | undefined
  let initialization = Promise.resolve()
  let off = () => {}
  const closeOut = (why: string): Promise<void> => closingTask ??= closeOnce(why).catch(error => {
    closingTask = undefined
    link.send({ t: 'stopping', why: `未完成收尾：${error instanceof Error ? error.message : String(error)}` })
  })
  const closeOnce = async (why: string): Promise<void> => {
    closing = true
    lifetime.abort()
    if (shrinkTimer !== undefined) clearTimeout(shrinkTimer)
    options.log?.(`执行者收摊（${why}）`)

    /**
     * **先说一声「我受理了、正在退资源」**（U49）——那一格就是**停止中**。
     *
     * 它必须**排在收尾两跳之前**：那两跳（等外部服务器释放、再关库）可能要几秒，而
     * 那几秒里这一代既不是「在跑」也不是「已经没了」——正是设计说的「**已受理停止，
     * 资源尚未全部退出**」。晚一步说（等收完了再说）就成了「先显示已停止」，而那一条
     * 判据明写着不许（「停止中不能提前显示已停止」）。
     */
    link.send({ t: 'stopping', why })

    await initialization.catch(() => undefined)
    await Promise.all([assembly.shutdown(), ...inFlight])
    off()
    assembly.close()
    diagnosticLog?.write('info', 'executor.stopped')
    await diagnosticLog?.close()
    link.close()
  }

  link.onMessage((message: ManagerToExecutor) => {
    diagnosticLog?.write('trace', `control.${message.t}`)
    try { switch (message.t) {
      case 'settings.inspect':
        link.send({ t: 'settings.synced', request: message.request, mcp: assembly.mcpServers() }); return
      case 'diagnostics.sync':
        if (!validDiagnosticsChange(message.value)) { link.send({ t: 'settings.synced', request: message.request, error: '诊断设置无效', mcp: assembly.mcpServers() }); return }
        diagnosticLog?.setLevel(message.value.logLevel)
        diagnosticLog?.write('info', 'diagnostics.applied', { request: message.request })
        if (diagnosticLog) trackOperation(diagnosticLog.flush().then(() => link.send({ t: 'settings.synced', request: message.request, ...(diagnosticLog?.problem ? { error: diagnosticLog.problem } : {}), mcp: assembly.mcpServers() })))
        return
      case 'settings.sync':
        try { assembly.refreshSettings(); link.send({ t: 'settings.synced', request: message.request, mcp: assembly.mcpServers() }) }
        catch { link.send({ t: 'settings.synced', request: message.request, error: '无法受理当前设置，请重新读取', mcp: assembly.mcpServers() }) }
        return
      case 'settings.reconnect':
        if (closing) return
        trackOperation(assembly.reconnectMcp(message.server).then(note => link.send({ t: 'settings.synced', request: message.request, note, mcp: assembly.mcpServers() }))
          .catch(() => link.send({ t: 'settings.synced', request: message.request, error: '重连失败', mcp: assembly.mcpServers() })))
        return
      case 'collaboration.configure':
        if (closing) return
        link.send({ t: 'collaboration.configured', requestId: message.requestId, result: assembly.applyModel(message.model) })
        return
      case 'collaboration.input':
        if (closing) return
        trackOperation(assembly.supplementCollaboration(message.input, message.shared))
        return
      case 'collaboration.wake':
        if (closing) return
        assembly.wakeCollaboration()
        return
      case 'cmd':
        if (closing) return
        assembly.shell.send(message.cmd)
        return
      /**
       * **接回快照**（U49）——**当场答，中间一步都不 await**。
       *
       * 那条纪律是这一整条链成立的前提：水位（`live.lastId`）与快照里的内容必须是
       * **同一刻**的。中间只要让出一次事件循环，就可能有一条事件既进了水位、又没进快照
       * （或者反过来）——而另一头正是按「水位之后的都还没发生」来放行的。
       */
      case 'snapshot':
        link.send({ t: 'snapshot', seq: message.seq, snapshot: snapshotNow() })
        return
      case 'bye':
        void closeOut(message.why)
        return
      default:
        return
    } } catch (error) { trackOperation(Promise.reject(error)) }
  })

  link.onClose(() => {
    // **管理者那一头断了**——专用生命连接那一条（见文件头注）。
    // 注意这里是**同步**回调：收尾是异步的，故起一条 promise 走，不阻塞断开这一跳。
    void closeOut('管理者不在了')
  })

  const cancel = () => { void closeOut('停止当前工作') }
  options.signal.addEventListener('abort', cancel, { once: true })
  if (options.signal.aborted) cancel()

  if (!closing) {
    initialization = (async () => {
      await assembly.ready()
      if (closing) return
      off = assembly.shell.subscribe((event: KernelEvent) => {
        track(event)
        link.send({ t: 'ev', event })
        considerShrink()
      })
      await assembly.boot()
      if (closing) return
      link.send({ t: 'ready' } satisfies ExecutorToManager)
      considerShrink()
    })()
    try { await initialization }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      diagnosticLog?.write('error', 'executor.initialization.failed')
      link.send({ t: 'done', why: reason })
      await closeOut(reason)
    }
  }
  await disconnected
  options.signal.removeEventListener('abort', cancel)
  await closingTask
  return { kind: 'ok' }
}
