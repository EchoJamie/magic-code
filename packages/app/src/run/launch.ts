import type { MagicHome, ModelSwitchRequest, ProcessLedger } from '@magic/contracts'
import type { RecordsStore } from '@magic/records'
import type { WorkEnvironment } from '../work-environment.ts'
import type { Link, ManagerToExecutor } from './wire.ts'
import { runExecutor } from './executor.ts'

export type ExecutorLauncher = {
  spawn(request: ExecutorRequest): SpawnedExecutor
}

/** 开一个执行者时给它的那几件——「哪一代、哪条会话、在哪个工作区、用哪份配置」。 */
export type ExecutorRequest = {
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
  /** 统一基础路径——执行者按它读配置。 */
  readonly magic: MagicHome
  /** 管理者监听的那条 socket——执行者要连它。 */
  readonly link: Link<ManagerToExecutor>
  readonly records: RecordsStore
  readonly ledger: ProcessLedger

  readonly switch?: ModelSwitchRequest | undefined
  /**
   * **全放行**（U73）——同上：**只有为这个窗口新起的那一代**收它，且要赶在
   * **执行者造闸门之前**（那是装配期的事，没有事后改的口）。
   */
  readonly allowAll?: boolean | undefined
}

/** 一个 Agent 实例的取消与完成。资源收尾完成之后才发完成通知。 */
export type SpawnedExecutor = {
  onExit(listener: (reason: string) => void): void
  cancel(): void
}

/** Agent 是 Engine 内的异步实例；取消与完成只作用于本次运行。 */
export function createAgentLauncher(): ExecutorLauncher {
  return {
    spawn(request: ExecutorRequest): SpawnedExecutor {
      const controller = new AbortController()
      const done = Promise.resolve().then(() => runExecutor({ ...request, signal: controller.signal }))
        .then(outcome => outcome.kind === 'ok' ? '执行实例已释放' : outcome.reason,
          error => `执行实例失败：${error instanceof Error ? error.message : String(error)}`)
      return {
        onExit(listener) { void done.then(listener) },
        cancel() { controller.abort() },
      }
    },
  }
}
