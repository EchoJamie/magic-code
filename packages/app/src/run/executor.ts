/**
 * **执行者**（U48）——一条会话的推进由它一个进程独扛。
 *
 * 设计（会话与运行管理 · 本机执行结构）：
 *
 * > **执行者**：同一 Agent 的活跃会话推进**只持有一个工作进程**，复用现有内核、应用动作、
 * > 工作区和记录端口。拆进程用于**失败隔离与明确的资源归属**，不是「一条消息起一个进程」。
 *
 * ## 它凭什么这么薄
 *
 * 因为**内核一行都没改**：`assemble()` 照旧装配五步、照旧经同进程传输把「外壳侧一端」
 * 交出来。执行者拿的正是那一端（`assembly.shell`），只做**一座桥**——那边连着管理者，
 * 这边连着内核：
 *
 * ```
 *   管理者 ──cmd──▶ 执行者 ──shell.send──▶ [同进程通道] ──▶ 内核各域
 *   管理者 ◀──ev─── 执行者 ◀─subscribe──── [同进程通道] ◀── 内核各域
 * ```
 *
 * 于是「拆分」这件事的全部代价就落在这一个文件上：**多一跳进程边界，别处零改动**。
 * 这不是省事——「复用现有内核、应用动作、工作区和记录端口」是设计的明文。
 *
 * ## 生命周期里那三跳
 *
 * 1. **装配**（读配置 · 造各域）——同步，与今天的进程内启动同一条路；
 * 2. **发现 ＋ 恢复**（`ready()` ＋ `boot()`）——异步且有界；这一跳跑完才发 `ready`，
 *    在那之前管理者攒下的命令**一条都不发**（发了就是「用户敲了没反应」）；
 * 3. **桥梁架起来之后**才是「放开输入」。
 *
 * ## 收摊
 *
 * 三条路都汇到同一处：管理者说 `bye`、**连接断了**（管理者没了 / 被杀了）、收到信号。
 * 收尾照既有的两跳（先等外部服务器释放、再关库——`cli.ts` 那条 finally 的顺序）。
 *
 * ⚠️ **断了就自己停**是设计里的一条硬要求：「管理者异常退出 ⇒ 执行者通过**专用生命
 * 连接**收到断开后自行停止并释放资源，不变成无人负责的后台」。这条连接就是那条生命
 * 连接——管理者一死，OS 把它那一头的 socket 收掉，这里当场读到断开。
 */

import type { KernelEvent, MagicHome } from '@magic/contracts'
import { assemble } from '../assembly.ts'
import type { Assembly } from '../assembly.ts'
import { loadConfig } from '../config.ts'
import { linkOf, socketHandlers } from './wire.ts'
import type { ExecutorToManager, Link, ManagerToExecutor } from './wire.ts'

/**
 * 收缩前那一段余量（毫秒）——见 `considerShrink` 的注。
 *
 * 半秒：够一次「窗口走了、另一个窗口立刻接上」的往返（本机 socket，实际是毫秒级），
 * 又不至于让一个真没人要的进程白占着机器。
 */
const SHRINK_SETTLE_MS = 400

export type ExecutorOptions = {
  /** 管理者监听的那条 socket。 */
  readonly socket: string
  /** 管理者发车时给的令牌——认它是「我叫起来的那一个」。 */
  readonly token: string
  /** **显式接续**那条会话（`--session` 同义物）；`null` ＝ 还没开张（D5）。 */
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
  /** 诊断——缺省不打印（这条线上不写业务日志）。 */
  readonly log?: ((line: string) => void) | undefined
}

/** 收场——`runExecutor` 的几种结局，交回给入口去定退出码。 */
export type ExecutorOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'no-manager' }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * 跑一个执行者——**连上管理者、装配、报 ready、架桥，然后一直服务到收摊**。
 *
 * 返回时**保证**收尾两跳已经走过（外部服务器释放 ＋ 关库）：调用方随即可以退进程。
 */
export async function runExecutor(options: ExecutorOptions): Promise<ExecutorOutcome> {
  const connected = await connect(options.socket)
  if (connected === undefined) {
    // 连不上＝管理者已经不在了（起车与连上之间那一小段里被杀了）。
    // **不自己另起一个**：执行者从不自立门户，这是「不变成无人负责的后台」的起点。
    return { kind: 'no-manager' }
  }

  // 显式收成非空的那个类型——下面几处闭包（收缩、收摊）都要用它，而收窄进不去闭包
  const link: Link<ManagerToExecutor> = connected

  let assembly: Assembly
  try {
    const magic = options.magic
    const config = loadConfig({ magic })
    assembly = assemble({
      cwd: options.cwd,
      config,
      magic,
      // **显式接续**：给了 id 就是那条会话；不给＝一个会话都不开（D5）
      ...(options.session === null ? {} : { session: options.session }),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    link.send({ t: 'done', why: `装配没成：${reason}` })
    link.close()
    return { kind: 'failed', reason }
  }

  // **登记**（`hello`）在装配之后发：工作区整组根是装配才算得出来的
  // （配置里的 `workspaceRoots` 或启动目录，判断归执行域）——登记里要它。
  link.send({
    t: 'hello',
    role: 'executor',
    token: options.token,
    session: options.session,
    workspace: assembly.workspaceRoots,
  })

  /**
   * **收缩的两个判据**——「有没有人看」由管理者说（连接在它手上），「在不在干活」归这儿
   * （内核的状态这儿看得见）。两半合起来才是设计那一句：
   *
   * > 运行已结束、**没有在途调用或待答项**、**也没有连接者** ⇒ 持久化状态后**释放该执行者**；
   * > 历史与最后状态保留。笔记里还有待办**不阻止**释放。
   *
   * 两个数：
   * - `watching`——还有几个窗口在看（管理者的 `watchers`）；
   * - `busy`——手里有没有活。**从事件里认**，不另立一份状态：`agent.state` 说「在跑还是
   *   在等你」，裁决的请求／答复配对说「有没有待答项」。
   *
   * ⚠️ **等待中的事不算「运行已结束」**：「等待用户或协作结果的有效工作**可保留**事件
   * 阻塞的执行者，**CPU 不得忙轮询**」（设计 · 收缩）。故 `agent.state === 'waiting'`
   * 之外，**待答的裁决也算在途**——那正是「等你」的一种。而「等」是**事件阻塞**的：
   * 这个进程一个定时器都不转，只等着连接上送进来的那一条答复。
   */
  let watching = 0
  /** 听过管理者说「有几个人看你」没有——没听过之前**不许**按「没人看」收缩。 */
  let heardWatchers = false
  let busy = false
  /** 待答的裁决——按**那次工具调用**记（请求与答复两头都带 `call`，配对键就是它）。 */
  const pendingDecisions = new Set<number>()

  function track(event: KernelEvent): void {
    switch (event.kind) {
      case 'agent.state':
        busy = event.data.state !== 'waiting'
        return
      case 'tool.decision.request':
        pendingDecisions.add(event.data.call)
        return
      case 'tool.decision':
        pendingDecisions.delete(event.data.call)
        return
      default:
        return
    }
  }

  /** 收缩的等待器——只留一个（重新判一次就够，不必每个事件都排一个）。 */
  let shrinkTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 判一次「该收了吗」——**先等一歇再收**。
   *
   * 那一段余量是给「换看客」那一瞬的：窗口 A 走了、B 下一秒就来（`/resume` 那条路上
   * 中间就隔着一次往返），当场收的话会白起一个进程。半秒是「人还没松开按键」的量级。
   */
  function considerShrink(): void {
    if (closing || !heardWatchers) return
    if (watching > 0 || busy || pendingDecisions.size > 0) {
      if (shrinkTimer !== undefined) {
        clearTimeout(shrinkTimer)
        shrinkTimer = undefined
      }
      return
    }
    if (shrinkTimer !== undefined) return

    shrinkTimer = setTimeout(() => {
      shrinkTimer = undefined
      if (closing || watching > 0 || busy || pendingDecisions.size > 0) return

      // **持久化状态后释放**（设计 · 收缩）：收尾那两跳里就有「把没落完的落完」
      // ——故它是释放，不是丢下。
      link.send({ t: 'done', why: '没有连接者、也没有在途调用或待答项' })
      void closeOut('没人看了，手上也没有在跑的事').then(() => process.exit(0))
    }, SHRINK_SETTLE_MS)
  }

  /** 收摊只走一遍——断开来一次、`bye` 来一次，两条路汇到这儿。 */
  let closing = false
  const closeOut = async (why: string): Promise<void> => {
    if (closing) return
    closing = true
    options.log?.(`执行者收摊（${why}）`)

    // 两跳的顺序照 `cli.ts` 那条先例：**先等外部服务器释放，再关库**——
    // 反过来的话，还活着的工具调用会写进一个已经关掉的事务。
    try {
      await assembly.shutdown()
    } finally {
      assembly.close()
    }
    link.close()
  }

  link.onMessage((message: ManagerToExecutor) => {
    switch (message.t) {
      case 'cmd':
        assembly.shell.send(message.cmd)
        return
      case 'ping':
        link.send({ t: 'pong', seq: message.seq })
        return
      case 'watchers':
        watching = message.count
        heardWatchers = true
        considerShrink()
        return
      case 'bye':
        void closeOut(message.why)
        return
      default:
        return
    }
  })

  link.onClose(() => {
    // **管理者那一头断了**——专用生命连接那一条（见文件头注）。
    // 注意这里是**同步**回调：收尾是异步的，故起一条 promise 走，不阻塞断开这一跳。
    void closeOut('管理者不在了')
  })

  // 信号：管理者先礼（`bye`）后兵（SIGTERM）里的「兵」那一下。挂了处理器之后信号
  // 不再杀进程，故必须真走到 `closeOut` —— 否则就成了「按下去不动」。
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void closeOut(`收到 ${signal}`).then(() => process.exit(0))
    })
  }

  // **发现那一跳**（配置里的外部服务器）＋ **启动流转**（恢复：给了 `--session` 才跑）。
  // 两者都在「放开输入」之前——设计明文：「首轮模型请求前完成发现」；
  // 恢复要发事件，而订阅在下面才架上，故 `boot` 排在订阅之后。
  try {
    await assembly.ready()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await closeOut(`发现那一跳没成：${reason}`)
    return { kind: 'failed', reason }
  }

  // **订阅架在恢复之前**：恢复要发事件（技术方案 · 控制域：无订阅方时事件丢）
  const off = assembly.shell.subscribe((event: KernelEvent) => {
    track(event)
    link.send({ t: 'ev', event })
    considerShrink()
  })

  try {
    await assembly.boot()
  } catch (error) {
    off()
    const reason = error instanceof Error ? error.message : String(error)
    await closeOut(`恢复没跑完：${reason}`)
    return { kind: 'failed', reason }
  }

  // **放开输入**——到这一跳为止攒在管理者手里的命令，从这儿开始一条一条进来
  link.send({ t: 'ready' } satisfies ExecutorToManager)

  await new Promise<void>((resolve) => {
    const done = (): void => resolve()
    link.onClose(done)
    process.once('beforeExit', done)
  })

  await closeOut('收到收摊指示')
  return { kind: 'ok' }
}

/** 连管理者——连不上返回 `undefined`（**不重试**：执行者是管理者叫起来的，它不该赖着找）。 */
async function connect(socketPath: string) {
  try {
    const socket = await Bun.connect({ unix: socketPath, socket: socketHandlers() })
    return linkOf<ManagerToExecutor>(socket as never)
  } catch {
    return undefined
  }
}
