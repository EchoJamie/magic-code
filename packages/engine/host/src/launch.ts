import type { MagicHome, ModelSwitchRequest, ProcessLedger } from '@magic/contracts'
import type { RecordsStore } from '@magic/data'
import type { WorkEnvironment } from '@magic/host'
import type { ExecutorToManager, Link, Wire } from '@magic/host'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  /** 管理者实际监听的地址，不由执行者按自己的环境重新计算。 */
  readonly socket: string
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
/** 一次发车的交回——取消与完成，外加**管理者侧通道**（命令、bye、协作回执都走它）。 */
export type ExecutorSpawned = {
  readonly link: Link<ExecutorToManager>
  onExit(listener: (reason: string) => void): void
  /**
   * **请求收场的第一档**（进程模式发 SIGTERM）。
   *
   * ⚠️ executor 子进程**有意忽略裸信号**（防幽灵信号打断工作，见 executor-process.ts）——
   * 对它们这一档是空操作：优雅收场的权威在管理者的 `bye` 帧，最后一档是 `kill()`。
   */
  cancel(): void
  /**
   * **最后一档**（可选）——宽限过后仍不肯走的执行者，单独强杀。
   *
   * 只有独立子进程给得出（SIGKILL 不伤及共享 Engine）；进程内执行者没有这档
   * （杀不得共享进程——那正是进程内方案的根本约束），缺省即「没有」。
   */
  kill?(): void
}

// ══ 进程隔离：执行者跑在独立子进程里 ════════════════════════════════════
// （同进程形态已清退到测试域 `apps/cli/test/executor-test-channel.ts`——生产只有这一种发车方式。）

/**
 * **待认领通道**——发车那一刻建，子进程连上来（`executor.hello` 配对）才绑定真连接。
 *
 * T1.2 送达链重构：**绑定前不缓冲任何帧**——待办已落账（受理前移），帧只是加速信号，
 * 绑定前的发送一律拒绝（返回 `false`）；ready 后由 ready 处理与对账器补发消费信号。
 * （原先的 256 帧缓冲与溢出判死已删：缓冲让「账本为真源」变成两处真相。）
 */
export function createDeferredChannel(): {
  readonly link: Link<ExecutorToManager>
  readonly attached: boolean
  attach(real: Link<Wire>): void
} {
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
      if (real === undefined) return false
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
    },
  }
}

export type ProcessLauncherOptions = {
  /** 子进程命令行头两截——缺省由 `runtimeLaunch()` 推（源码 / 发行两种形态都对）。 */
  readonly command?: readonly string[]
  readonly log?: ((line: string) => void) | undefined
}

/** 执行者的独立子进程——真并行、故障隔离；优雅收场经 `bye` 帧，SIGKILL 最后一档兜底。 */
export function createProcessLauncher(options: ProcessLauncherOptions = {}): ExecutorLauncher {
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
        '--socket', request.socket,
        '--home', request.magic.home,
        '--base', request.magic.base,
        '--cwd', request.cwd,
        ...(request.session === null ? [] : ['--session', request.session]),
        ...(request.switch === undefined ? [] : ['--switch', JSON.stringify(request.switch)]),
      ]
      try {
        child = Bun.spawn(argv, {
          env: childEnv(request.environment),
          stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
        })
        // **stderr 转发必填**（T1.5 · §六）：executor 的每一句 stderr 都有处可查——
        // 独立文件落盘（`<base>/logs/executor-stderr-<pid>.log`，10MiB 轮转，同配额纪律）
        // **不依赖注入链**（serve 模式下 log 可能未接，缺省也落）；管理者另传 log 时双写转发。
        const stderrStream = child.stderr
        if (stderrStream !== undefined && typeof stderrStream !== 'number') {
          const stderrFile = join(request.magic.base, 'logs', `executor-stderr-${child.pid ?? 'na'}.log`)
          try { mkdirSync(dirname(stderrFile), { recursive: true }) } catch { /* 目录已存在 */ }
          void (async () => {
            try {
              for await (const chunk of stderrStream) {
                const line = Buffer.from(chunk).toString().trim()
                if (line === '') continue
                try {
                  if (existsSync(stderrFile) && statSync(stderrFile).size > 10 * 1024 * 1024) writeFileSync(stderrFile, '')
                  appendFileSync(stderrFile, `${new Date().toISOString()} ${line}\n`)
                } catch { /* 落盘失败不反噬管道 */ }
                options.log?.(`[executor-stderr] ${line}`)
              }
            } catch { /* 进程已退出 */ }
          })()
        }
      } catch (error) {
        options.log?.(`执行者子进程没起来：${String(error)}`)
        throw error
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
          // ⚠️ **SIGTERM 对 executor 子进程是空操作**——子进程有意忽略裸信号（防幽灵信号
          // 打断工作，见 executor-process.ts），优雅收场的权威在管理者的 `bye`，强杀走 kill()。
          // 这里只是停止编排的第一档，真正起作用的是后两档。
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
