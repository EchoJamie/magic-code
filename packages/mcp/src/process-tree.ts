/**
 * 自有进程树 —— **关一条服务器时，把它带起来的那些也收干净**（U38 返工 A）。
 *
 * 由头（独立验收的问题 3）：SDK 的 `close()` 只管它**直接**拉起的那个 `ChildProcess`
 * （关 stdin → 等 → 2s → SIGTERM → 2s → SIGKILL）。而真服务器常常再拉一层
 * （`npx` → `node`，或用户脚本自己起的后台件）——父一退，那一层被系统过继给 1 号，
 * 从此谁都不再认它。独立验收的固定反例就是它：假服务器 `spawn('/bin/sleep', ['120'])`，
 * 服务器收 stdin EOF 正常退出，`sleep` 活着。
 *
 * 四条边界写死在这儿（**不造全局进程管理**——这里只认一条连接的自有子树）：
 *
 * 1. **只碰自有子树**——从我们拉起的那个 pid 往下走，别的进程一概不认（不扫不杀全机）；
 * 2. **趁父还在时快照**——父一退，PPID 链就断了（孤儿认不回来），故快照必须在
 *    `transport.close()` **之前**做；
 * 3. **认不出就如实认不出**——`ps` 拿不到（非 POSIX / 命令缺）时返回空表，
 *    不假装收过（收没收得到由调用方按实况报）；
 * 4. **只杀给出的那些 pid**——`reap` 不自己去找目标，目标由调用方在快照那一刻定死。
 */

/** 一次快照：父 pid → 它的直接子进程们。 */
type Tree = ReadonlyMap<number, readonly number[]>

/**
 * 读一次全机进程表（`ps -ax -o pid=,ppid=`）。
 *
 * 取不到即返回空树——`ps` 是 POSIX 的常备件（macOS / Linux 都有），不在了也不该让
 * 关闭这条路径炸掉（那才真会把子进程留下）。
 */
function readTree(): Tree {
  try {
    const proc = Bun.spawnSync(['ps', '-ax', '-o', 'pid=,ppid='], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    if (proc.exitCode !== 0) return new Map()

    const children = new Map<number, number[]>()
    for (const line of proc.stdout.toString().split('\n')) {
      const [pidText, ppidText] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      const ppid = Number(ppidText)
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue

      const siblings = children.get(ppid)
      if (siblings === undefined) children.set(ppid, [pid])
      else siblings.push(pid)
    }
    return children
  } catch {
    return new Map()
  }
}

/**
 * `root` 的**全部后代**（不含 `root` 自己，深度优先展开，按发现序）。
 *
 * ⚠️ **只在 `root` 还活着时叫它**（见文件头注 2）：父一退，孙子就被过继走了。
 * `tree` 参数只为用例能把一张假进程表喂进来（真路径不必给）。
 */
export function descendantsOf(root: number, tree: Tree = readTree()): readonly number[] {
  const found: number[] = []
  const seen = new Set<number>([root])
  const queue: number[] = [root]

  while (queue.length > 0) {
    const parent = queue.shift() as number
    for (const child of tree.get(parent) ?? []) {
      if (seen.has(child)) continue // 防环（进程表理论上不会成环，不拿它赌）
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }

  return found
}

/** 进程还在不在（`kill 0` 只探活，不发信号）。 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 一次「等它们没」的上限与步长（毫秒）——收尾这一步**有界**，不能挂住退出。 */
const GRACE_STEP_MS = 50
const TERM_GRACE_MS = 1_000
const KILL_GRACE_MS = 1_000

/**
 * 收掉这些 pid —— **TERM → 等 → KILL**（与传输规范给直接子进程的次序同一把尺子）。
 *
 * 只发给**调用方点名的那几个**（见文件头注 4）；已经没了的不发（那是常态：多数后代
 * 会跟着父一起退，这里收的是**漏下的**）。返回仍然活着的 pid（空表＝收干净了）。
 */
export async function reap(pids: readonly number[]): Promise<readonly number[]> {
  const targets = pids.filter((pid) => isAlive(pid))
  if (targets.length === 0) return []

  for (const pid of targets) signal(pid, 'SIGTERM')
  await untilGone(targets, TERM_GRACE_MS)

  const stubborn = targets.filter((pid) => isAlive(pid))
  for (const pid of stubborn) signal(pid, 'SIGKILL')
  await untilGone(stubborn, KILL_GRACE_MS)

  return stubborn.filter((pid) => isAlive(pid))
}

/** 发一个信号——进程刚好在这一刻没了也算成功（ESRCH 是收尾路上的常态）。 */
function signal(pid: number, name: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, name)
  } catch {
    // 已经没了 / 不是我们的——两种都不该让收尾中断
  }
}

/** 等到这些 pid 全都没了（有界：到点即返回，让调用方按实况报）。 */
async function untilGone(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && pids.some((pid) => isAlive(pid))) {
    await Bun.sleep(GRACE_STEP_MS)
  }
}
