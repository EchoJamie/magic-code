/**
 * **按需起管理者**（U48）——第一个窗口把它拉起来，之后按本机连接接上。
 *
 * 设计明文：「本轮方案采用一个**按需启动**的本机执行管理者，终端经本机连接接入」。
 * 「按需」这一条在这里是两个动作的合称：
 *
 * 1. **先连**——已经有一个（别的窗口拉起来的）就接上，**不另起**；
 * 2. 连不上才**拉一个**，而且是**脱离终端**地拉（`detached`）：管理者要活过拉它
 *    起来那个窗口——「关闭窗口继续执行」那条已定策略的前提正是它。挂在窗口底下的话，
 *    窗口一走管理者跟着走，后台能力当场不成立。
 *
 * ## 为什么不是「在本进程里当管理者」
 *
 * 那样窗口一关管理者就没了。「管理者是独立进程」不是为了对称好看：**它的寿命比窗口长**
 * 是设计要求（「没有执行者、客户端及待处理的投递 / 唤起责任时才退出」）——同进程做不到。
 *
 * ## 起来的信号是**连得上**，不是「子进程退出了没有」
 *
 * 子进程刚起来那一段（读配置、开库、bind）里它是活的但还接不了客。故这里不发「我好了」
 * 的消息，而是**反复试着连**——连上就是好了，连不上就再等一歇（有界）。不另立一条
 * 「就绪」的握手：连接本身就是那个信号。
 */

import { existsSync } from 'node:fs'
import { connectManager } from './client.ts'
import type { ManagerClient } from './client.ts'
import type { ConnectOptions } from './client.ts'

/** 等管理者起来的上限（毫秒）——本机这一跳实测在百毫秒量级，八秒已是两个数量级的余量。 */
const READY_TIMEOUT_MS = 8_000
/** 两次试着连之间隔多久（毫秒）。 */
const RETRY_MS = 25

export type SpawnManagerOptions = {
  /** 入口脚本（`packages/app/src/cli.ts`）——缺省按本文件的位置推。 */
  readonly entry?: string | undefined
  /** 连上之后那几个入参（`cwd` / `session` / `switch`）。 */
  readonly connect?: ConnectOptions | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * **接上管理者**——在的就连，不在的就拉一个再连。
 *
 * 返回 `undefined` ＝ 起不来也连不上（**有界**：拉起来之后等了 `timeoutMs` 还没接上，
 * 就该如实退场，而不是无限等一个起不来的东西）。
 */
export async function connectOrStartManager(
  socketPath: string,
  options: SpawnManagerOptions = {},
): Promise<ManagerClient | undefined> {
  // ① **在的就接上**——「启动竞争的一方连接已有实例，不另起」
  //
  // ⚠️ 回绝（`--session` 打错一个字母）在这一跳**照抛**，不进②：那不是「还没起来」，
  // 是「起来了、有话要说」——接着拉第二个只会把同一句回绝再听一遍。
  const existing = await connectManager(socketPath, options.connect ?? {})
  if (existing !== undefined) return existing

  // ② **不在才拉一个**（脱离终端，见文件头注）
  startDetached(socketPath, options.entry)

  // ③ 等它接得上（**有界**）——起来的信号就是「连得上」，不另立一条握手的消息
  const deadline = Date.now() + (options.timeoutMs ?? READY_TIMEOUT_MS)
  while (Date.now() < deadline) {
    await Bun.sleep(RETRY_MS)
    const client = await connectManager(socketPath, options.connect ?? {})
    if (client !== undefined) return client
  }

  return undefined
}

/** 拉一个**脱离终端**的管理者——见文件头注。 */
function startDetached(socketPath: string, entry: string | undefined): void {
  const target = entry ?? new URL('../cli.ts', import.meta.url).pathname
  if (!existsSync(target)) throw new Error(`入口不在：${target}`)

  const child = Bun.spawn(
    [process.execPath, target, '--internal-manager', socketPath],
    {
      env: process.env,
      // **脱离终端**：三个流都不接窗口那一份——窗口关了它照跑（「关闭窗口继续执行」），
      // 而它要说什么也不该打进用户的屏（那是「无人负责的后台日志」，归诊断不归界面）
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    },
  )

  // 不 `await child.exited`、也不留句柄：父进程该退就退（管理者自己活着）
  child.unref()
}
