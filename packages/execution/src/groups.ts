/**
 * **自有进程组的归属与收尾**（U50）——「这一组到底是不是我们起的、它还站着吗、怎么把它
 * 收干净」这三问的实现处。
 *
 * 设计（会话与运行管理 · 离开、停止与异常退出）：
 *
 * > 工具拒绝正常结束 ｜ **有界等待 → TERM → KILL → 等待退出**；仅操作**已证明归属**的
 * > 进程/组，**PID 重用不能误杀**。
 *
 * ## 为什么「证明归属」要两位
 *
 * 号（`pgid`）会被系统**回收再分配**：我们记下 4711 那一刻它是一条 `bun test`，三分钟
 * 之后再 `kill(-4711)` 杀掉的可能是一家无关的编辑器。故一笔账记两位——
 * **组长的启动时刻**（`ps -o lstart=`，秒分辨率）与号本身；收尾之前两位都要对得上。
 *
 * 三种对不上的情形各有各的处置（`reapOwned` 的返回值把这三种分开说）：
 *
 * | 现场 | 判 | 做 |
 * | --- | --- | --- |
 * | 组长还在、时刻对得上 | 是我们的 | TERM → 有界等 → KILL → 有界等 |
 * | 组长还在、时刻对不上 | **号被别人用了** | **一个信号都不发**（`stranger`） |
 * | 组长没了、组里还有人 | 证实不了 | **不动**，如实说（`unprovable`） |
 *
 * 第三行是刻意的保守：组长一没，「这一组还是当初那一组吗」就再没有判据了——**拿不准的
 * 不杀**（设计：「不承诺任意逃逸/自脱离进程都被薄执行边界可靠控制」，漏收要如实报，
 * 误杀是另一回事）。
 *
 * ## 与 `@magic/mcp` 那一份的关系
 *
 * 传输层（`stdio-transport.ts`）里有一段形状几乎一样的按组收尾：那是**工具连接自己**的
 * 收尾（关 stdin → 等 → 组 TERM → 等 → 组 KILL），在它自己那一头跑，判据是「这个组是
 * 我刚才 spawn 的」——**不需要核对身份**，因为那一刻它就是这个组的作者，中间没有隔时间。
 *
 * 这一份是**别人替你收**（执行者崩了，管理者照着登记来收）：中间隔着未知的时间，故必须
 * 有身份核对。两份的定位不同，不是同一件事写了两遍。
 */

import type { OwnedProcess, ProcessLedger } from '@magic/contracts'

/** 收尾的三段时限（毫秒）——每一段都**有界**，收尾这一跳不能被一个不听话的组挂住。 */
export type ReapTimes = {
  /** 先给一段「自己走」的余量（它多半正在退，等一等就不必发信号）。 */
  readonly settleMs?: number
  readonly termMs?: number
  readonly killMs?: number
}

const DEFAULT_SETTLE_MS = 500
const DEFAULT_TERM_MS = 1_500
const DEFAULT_KILL_MS = 1_500
/** 复读步长。 */
const POLL_MS = 20

/**
 * 收尾的四种结局——**分开说**，因为它们在处置上不一样（前两种是我们动了手的）。
 */
export type ReapOutcome =
  /** 组没了（我们收的，或它自己走的）。 */
  | { readonly kind: 'reaped' }
  /** 还站着——KILL 之后仍在（权限不够 / 僵尸 / 新成员）。**如实报，不冒充收到了**。 */
  | { readonly kind: 'left'; readonly note: string }
  /** **那个号已经是别人的了**（组长在，但启动时刻对不上）——没碰它。 */
  | { readonly kind: 'stranger'; readonly note: string }
  /** 组长不在、组里却还有人：**证实不了归属**——没碰它。 */
  | { readonly kind: 'unprovable'; readonly note: string }
  /** 组里一个人都没有了（在动手之前就已经没了）。 */
  | { readonly kind: 'gone' }

/**
 * 读一个进程的启动时刻（毫秒）——**只能问操作系统**。
 *
 * `ps -o lstart= -p <pid>`：只问这一个号（**不是扫全机**），秒分辨率。取不到（没有这个
 * 号 / `ps` 不可用 / 输出读不懂）一律 `undefined`——**读不到就是读不到**，调用方据此
 * 走保守那一支。
 *
 * `LC_ALL=C`：`lstart` 的月/星期名随 locale 变，钉住它这一句才稳定可解。
 */
export function startTimeOf(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined

  let out: Uint8Array
  try {
    const done = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    })
    if (done.exitCode !== 0) return undefined
    out = done.stdout
  } catch {
    // `ps` 都没有（极简容器一类）——判不了身份，如实按「读不到」办
    return undefined
  }

  const text = new TextDecoder().decode(out).trim()
  if (text === '') return undefined
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : undefined
}

/**
 * 启动时刻相差多少以内算「同一个」——`lstart` 是**秒**，故给一秒的容差。
 *
 * 导出是给**管理者那一侧**用的（重启核对与生命探测判「还是不是那一代」）：两边各写一个
 * 容差，迟早有一处松一档，而那一处的症状是**误杀**（把复用了同一个号的别人当成自己的）。
 */
export const PROCESS_START_TOLERANCE_MS = 1_100

/**
 * **那个号上站着的是不是当初那一个**。
 *
 * 判据两位：号在（调用方已经确认过）+ 组长启动时刻对得上。**读不到时刻**（任一方缺席）
 * 一律算「对不上」——保守那一支由调用方处置（不杀）。
 */
export function sameProcess(
  recorded: { readonly startedAt: number | undefined },
  now: number | undefined,
): boolean {
  if (recorded.startedAt === undefined || now === undefined) return false
  return Math.abs(recorded.startedAt - now) <= PROCESS_START_TOLERANCE_MS
}

/** 组还在不在——`kill(-pgid, 0)` 只探活：组里**还有成员**就成（组长没了也一样）。 */
export function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // 发不进去（不是我们的）同样说明**它还在**——如实算「在」
    return (error as { readonly code?: string }).code === 'EPERM'
  }
}

/** 给整组发一个信号——组里恰好一个成员都没有也算成功（ESRCH 是收尾路上的常态）。 */
export function signalGroup(pgid: number, name: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-pgid, name)
  } catch {
    // 已经收干净 / 发不进去——两种都不该让收尾中断（后者由 `groupAlive` 如实报出来）
  }
}

/** 等这一组没了（有界：到点即返回，让调用方按实况报）。 */
async function untilGroupGone(pgid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && groupAlive(pgid)) await Bun.sleep(POLL_MS)
}

/**
 * **按组收命——只碰证明得了归属的那一组**（判据见文件头那张表）。
 *
 * 次序是设计那一句：**有界等待 → TERM → 等 → KILL → 等**。第一段「等」不给信号：
 * 收尾这一跳多半赶在对方正退的中途，等一等就不必动粗（MCP 那条路同此，见
 * `stdio-transport.ts` 的 `closeOnce`）。
 *
 * ⚠️ **收没收到如实说**：`left` 那一支要带一句人话（回执与诊断都读它），不许拿一句
 * 空话冒充「已经收干净」。
 */
export async function reapOwned(handle: OwnedProcess, times: ReapTimes = {}): Promise<ReapOutcome> {
  const settleMs = times.settleMs ?? DEFAULT_SETTLE_MS
  const termMs = times.termMs ?? DEFAULT_TERM_MS
  const killMs = times.killMs ?? DEFAULT_KILL_MS
  const { pgid, what } = handle

  // ① **先核对身份**——这一步之前一个信号都不许发
  const now = startTimeOf(pgid)
  if (now === undefined) {
    // 组长不在了：组里还有没有剩的，**证实不了**
    return groupAlive(pgid)
      ? {
          kind: 'unprovable',
          note: `进程组 ${pgid}（${what}）的领头那个已经不在了——组里还有没有剩的证实不了，没有动它`,
        }
      : { kind: 'gone' }
  }
  if (!sameProcess(handle, now)) {
    return {
      kind: 'stranger',
      note: `进程号 ${pgid} 已经是别人的了（${what} 那一组早退了）——没有动它`,
    }
  }
  if (!groupAlive(pgid)) return { kind: 'gone' }

  // ② 有界等待 → TERM → 等 → KILL → 等
  await untilGroupGone(pgid, settleMs)
  if (!groupAlive(pgid)) return { kind: 'reaped' }

  signalGroup(pgid, 'SIGTERM')
  await untilGroupGone(pgid, termMs)
  if (!groupAlive(pgid)) return { kind: 'reaped' }

  signalGroup(pgid, 'SIGKILL')
  await untilGroupGone(pgid, killMs)
  return groupAlive(pgid)
    ? { kind: 'left', note: `进程组 ${pgid}（${what}）TERM、KILL 之后还站着——没有收干净` }
    : { kind: 'reaped' }
}

/**
 * 造一本归属账。
 *
 * 两处实现细节都有由头：
 * - **`add` 当场读一次身份**（同步）：那一刻组长就在眼前，是唯一读得准的时候；等到收尾
 *   再读，读到的可能是别人（也正是 `stranger` 那一档要防的）。
 * - **`list` 顺手摘掉没了的**：见契约 `ProcessLedger` 的注（账随生死走）。
 */
export function createProcessLedger(): ProcessLedger {
  const open = new Map<number, OwnedProcess>()
  const listeners: (() => void)[] = []

  /** 喊一声「账变了」——**不让一个听者把记这笔账的路带偏**（同 `Link.send` 那条口径）。 */
  const announce = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 上报那一侧自己的岔子（连接已断一类）——记账这一跳不该因此中断
      }
    }
  }

  return {
    add(input) {
      const startedAt = startTimeOf(input.pgid)
      open.set(input.pgid, {
        pgid: input.pgid,
        startedAt,
        what: input.what,
      })
      announce()
    },
    onChange(listener) {
      listeners.push(listener)
    },
    list() {
      // ⚠️ 摘的条件是「组没了」，不是「组长没了」——组长先走、组员还活着的组照旧在账上
      for (const pgid of [...open.keys()]) {
        if (!groupAlive(pgid)) open.delete(pgid)
      }
      return [...open.values()]
    },
  }
}
