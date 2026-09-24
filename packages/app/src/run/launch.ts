/**
 * **真起一个执行者进程**（U48）——`ExecutorLauncher` 的生产实现。
 *
 * 三件都在这一处：**怎么起**（`bun <入口> --internal-executor …`）、**拿什么认它**
 * （令牌走参数）、**怎么叫它退**（先礼后兵的「兵」）。
 *
 * ## 为什么命令行参数里带基础路径
 *
 * 执行者按 `magic` 读配置（配置 / 授权 / 技能都从它派生，U42）。**不靠环境变量**：
 * `MAGIC_HOME` 只说得清「Magic 落在哪」，而 `home`（`~/…` 展开到哪）与 `base` 是**两件**
 * ——测试沙地把它们指到临时目录时，子进程若照环境自己解析一遍，读到的是**开发者真那份**。
 * 故由管理者把**已解析的那一份**原样递过去：一处解析、两处同一个值。
 *
 * ## 为什么不用 `--session`（那是个产品选项）当通道
 *
 * 执行者那条路**不是产品命令**（用户敲不出来，`--help` 里也没有）：它是管理者与执行者
 * 之间的私约。故入口那一支写成 `--internal-executor`，与「研发设施不是产品命令」的
 * `ui.ts` 同一条口径（见 `cli.ts` 里解析那一处的注）。
 */

import { existsSync } from 'node:fs'
import type { ExecutorLauncher, ExecutorRequest, SpawnedExecutor } from './manager.ts'

/** 开局选中走参数（JSON 一份）——它是**窗口的属性**，随发车那一跳递进去。 */
const SWITCH_FLAG = '--switch'

export type SpawnOptions = {
  /** 入口脚本（`packages/app/src/cli.ts`）——缺省按本文件的位置推。 */
  readonly entry?: string | undefined
  /** 诊断——子进程的 stderr 往哪儿走；缺省 `inherit`（用户**看得见**它说了什么）。 */
  readonly stderr?: 'inherit' | 'pipe' | 'ignore' | undefined
}

/** 本包入口——`src/run/launch.ts` 往上两级就是 `src/cli.ts`。 */
function defaultEntry(): string {
  return new URL('../cli.ts', import.meta.url).pathname
}

/**
 * 造一个真起进程的启动器。
 *
 * ⚠️ **起不来要抛**：调用方（管理者）据「抛没抛」决定要不要对窗口说「起不了执行者」——
 * 静默返回一个死句柄会让窗口对着一个永远不来的答复发呆。
 */
export function createProcessLauncher(options: SpawnOptions = {}): ExecutorLauncher {
  const entry = options.entry ?? defaultEntry()
  const stderr = options.stderr ?? 'inherit'

  return {
    spawn(request: ExecutorRequest): SpawnedExecutor {
      if (!existsSync(entry)) {
        throw new Error(`执行者入口不在：${entry}`)
      }

      const child = Bun.spawn(
        [
          process.execPath,
          entry,
          '--internal-executor',
          request.socket,
          '--token',
          request.token,
          '--session',
          request.session ?? '-',
          '--cwd',
          request.cwd,
          '--magic-home',
          request.magic.home,
          '--magic-base',
          request.magic.base,
          ...(request.switch === undefined ? [] : [SWITCH_FLAG, JSON.stringify(request.switch)]),
        ],
        {
          // 子进程的**环境照传**（它要读用户的 `PATH` / 供应商的环境变量 key）。
          // 基础路径不走环境而是走参数——见文件头注。
          env: process.env,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr,
        },
      )

      let exited: (reason: string) => void = () => {}
      const done = new Promise<string>((resolve) => {
        exited = resolve
      })

      void child.exited.then((code) => {
        const reason = code === 0 ? '进程正常退出' : `进程退出（码 ${code ?? '?'}）`
        exited(reason)
      })

      return {
        pid: child.pid,
        onExit(listener) {
          void done.then(listener)
        },
        kill() {
          try {
            child.kill('SIGTERM')
          } catch {
            // 已经退了：收尾这一跳不该抛
          }
        },
      }
    },
  }
}
