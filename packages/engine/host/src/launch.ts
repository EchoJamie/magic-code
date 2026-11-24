import type { MagicHome, ModelSwitchRequest, ProcessLedger } from '@magic/contracts'
import type { RecordsStore } from '@magic/data'
import type { WorkEnvironment } from '@magic/host'
import type { ExecutorToManager, Link, ManagerToExecutor, Wire } from '@magic/host'
import { localLinks } from './wire.ts'
import { runExecutor } from './executor.ts'
import { runtimeLaunch } from './runtime-launch.ts'

export type ExecutorLauncher = {
  spawn(request: ExecutorSpawn): ExecutorSpawned
  /**
   * **子进程连回来时报到**——按发车令牌配对；进程内 launcher 不经 socket，恒 `false`。
   * 配上了返回 `true`：报到消息到此为止，不再向放置层转发。
   */
  claim?(executionId: string, link: Link<Wire>): boolean
}

/** 发车单——「哪一代、哪条会话、在哪个工作区、用哪份配置」。通道由 launcher 交回。 */
export type ExecutorSpawn = {
  readonly network: WorkEnvironment
  readonly environment: Readonly<Record<string, string>>

  /** **代次**——管理者发的号。 */
  readonly gen: number
  /** 发车令牌——它连上来时按这个认。 */
  readonly executionId: string
  /** 开工那条会话（显式接续时就有）；`null` ＝ 让它自己开张（D5）。 */
  readonly session: string | null
  /** **启动目录**——工作区默认根（配置没写 `workspaceRoots` 时就是它）。 */
  readonly cwd: string
  /** **统一基础路径**——执行者按它读配置。 */
  readonly magic: MagicHome
  readonly records: RecordsStore
  readonly ledger: ProcessLedger

  readonly switch?: ModelSwitchRequest | undefined
}

/** 一次发车的交回——取消与完成，外加**管理者侧通道**（命令、bye、协作回执都走它）。 */
export type ExecutorSpawned = {
  readonly link: Link<ExecutorToManager>
  onExit(listener: (reason: string) => void): void
  /** 请求收场（进程模式＝SIGTERM；进程内＝取消在途）。 */
  cancel(): void
  /**
   * **最后一档**（可选）——宽限过后仍不肯走的执行者，单独强杀。
   *
   * 只有独立子进程给得出（SIGKILL 不伤及共享 Engine）；进程内执行者没有这档
   * （杀不得共享进程——那正是进程内方案的根本约束），缺省即「没有」。
   */
  kill?(): void
}

/** Agent 是 Engine 内的异步实例；取消与完成只作用于本次运行。 */
export function createAgentLauncher(): ExecutorLauncher {
  return {
    spawn(request: ExecutorSpawn): ExecutorSpawned {
      const controller = new AbortController()
      const [link, agentLink] = localLinks<ExecutorToManager, ManagerToExecutor>()
      const done = Promise.resolve().then(() => runExecutor({
        ...request,
        link: agentLink,
        signal: controller.signal,
      }))
        .then(outcome => outcome.kind === 'ok' ? '执行实例已释放' : outcome.reason,
          error => `执行实例失败：${error instanceof Error ? error.message : String(error)}`)
      return {
        link,
        onExit(listener) { void done.then(listener) },
        cancel() { controller.abort() },
      }
    },
  }
}

// ══ 进程隔离：执行者跑在独立子进程里 ════════════════════════════════════

/**
 * **待认领通道**——发车那一刻建，子进程连上来（`executor.hello` 配对）才绑定真连接。
 *
 * 绑定前的发送**先攒着**（「先攒后送」的既有纪律在连接层同样成立——子进程装配是
 * 秒级，窗口早就在等了）；攒的量有上界，超了当通道死了。绑定后全部直通：入站转发
 * 给放置层的处理器，出站直写 socket。
 */
export function createDeferredChannel(): {
  readonly link: Link<ExecutorToManager>
  readonly attached: boolean
  attach(real: Link<Wire>): void
} {
  const buffered: Wire[] = []
  let real: Link<Wire> | undefined
  let closed = false
  let listeners: ((message: ExecutorToManager) => void)[] = []
  let closeListeners: ((error?: Error) => void)[] = []

  const settle = (error?: Error): void => {
    if (closed) return
    closed = true
    for (const listener of [...closeListeners]) listener(error)
    closeListeners = []
    listeners = []
  }

  const forward = (message: Wire): void => {
    for (const listener of [...listeners]) listener(message as ExecutorToManager)
  }

  const link: Link<ExecutorToManager> = {
    send(message) {
      if (closed) return false
      if (real === undefined) {
        if (buffered.length >= 256) { settle(new Error('执行者迟迟未连回，通道溢出')); return false }
        buffered.push(message)
        return true
      }
      return real.send(message)
    },
    onMessage(listener) {
      if (closed) return
      listeners.push(listener)
      if (real !== undefined && listeners.length === 1) real.onMessage(forward)
    },
    onClose(listener) {
      if (closed) { listener(); return }
      closeListeners.push(listener)
    },
    close() {
      try { real?.close() } catch { /* 已经断了——收尾这一跳不抛 */ }
      settle()
    },
    get closed() { return closed },
  }

  return {
    link,
    get attached() { return real !== undefined },
    attach(one) {
      if (real !== undefined || closed) return
      real = one
      one.onMessage(forward)
      one.onClose(error => settle(error))
      for (const message of buffered.splice(0)) one.send(message)
    },
  }
}

export type ProcessLauncherOptions = {
  /** 子进程命令行头两截——缺省由 `runtimeLaunch()` 推（源码 / 发行两种形态都对）。 */
  readonly command?: readonly string[]
  /** 管理者监听的 socket——**直接下发**，子进程不自推导（沙盒的 TMPDIR 与管理者不同时，
   * `runPathsOf` 的回退目录就对不上）。 */
  readonly socket: string
  readonly log?: ((line: string) => void) | undefined
}

/** 执行者的独立子进程——真并行、故障隔离；SIGTERM 兜底回收。 */
export function createProcessLauncher(options: ProcessLauncherOptions): ExecutorLauncher {
  const pending = new Map<string, { channel: ReturnType<typeof createDeferredChannel>; cancel: () => void; kill: () => void }>()

  return {
    claim(executionId, link) {
      const waiting = pending.get(executionId)
      if (waiting === undefined) return false
      pending.delete(executionId)
      waiting.channel.attach(link)
      return true
    },

    spawn(request: ExecutorSpawn): ExecutorSpawned {
      const channel = createDeferredChannel()
      const exitListeners: ((reason: string) => void)[] = []
      let child: ReturnType<typeof Bun.spawn> | undefined

      const argv = [
        ...(options.command ?? runtimeLaunch()),
        'executor',
        '--execution-id', request.executionId,
        '--socket', options.socket,
        '--home', request.magic.home,
        '--base', request.magic.base,
        '--cwd', request.cwd,
        ...(request.session === null ? [] : ['--session', request.session]),
        ...(request.switch === undefined ? [] : ['--switch', JSON.stringify(request.switch)]),
      ]
      try {
        child = Bun.spawn(argv, {
          env: childEnv(request.environment),
          stdin: 'ignore', stdout: 'ignore', stderr: 'inherit',
        })
      } catch (error) {
        options.log?.(`执行者子进程没起来：${String(error)}`)
        throw error
      }
      if (child.stderr !== undefined && typeof child.stderr !== 'number' && options.log !== undefined) {
        const log = options.log
        const stream = child.stderr
        void (async () => {
          try {
            const reader = (stream as unknown as ReadableStream<Uint8Array>).getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              log(new TextDecoder().decode(value).trimEnd())
            }
          } catch { /* 子进程已退——读流自然结束 */ }
        })()
      }
      void child.exited.then(code => {
        pending.delete(request.executionId)
        for (const listener of [...exitListeners]) listener(`子进程退出（${code}）`)
      })
      pending.set(request.executionId, {
        channel,
        cancel: () => child?.kill(),
        kill: () => child?.kill('SIGKILL'),
      })
      return {
        link: channel.link,
        onExit(listener) { exitListeners.push(listener) },
        cancel() {
          pending.delete(request.executionId)
          pending.delete(request.executionId)
          try { child?.kill() } catch { /* 已退——不追 */ }
        },
        kill() { try { child?.kill('SIGKILL') } catch { /* 已退——不追 */ } },
      }
    },
  }
}

/** 子进程的环境——`network.env` 为底，缺的进程必需项从当前进程补。 */
function childEnv(network: Readonly<Record<string, string>>): Record<string, string> {
  const keep = (name: string): string | undefined => {
    const value = process.env[name]
    return value === undefined || value === '' ? undefined : value
  }
  return {
    ...(network['PATH'] === undefined ? { PATH: keep('PATH') ?? '/usr/bin:/bin' } : {}),
    ...(network['HOME'] === undefined ? { HOME: keep('HOME') ?? '' } : {}),
    ...(network['TMPDIR'] === undefined ? { TMPDIR: keep('TMPDIR') ?? '/tmp' } : {}),
    ...network,
  }
}
