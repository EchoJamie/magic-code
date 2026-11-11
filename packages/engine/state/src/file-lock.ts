import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** 授权与配置的短文件写入共用同一锁机制。 */
export async function acquireFileLock(path: string): Promise<HeldLock> {
  return acquireLock(`${canonicalPath(path)}${LOCK_SUFFIX}`, path)
}

// ══ 独占锁 ════════════════════════════════════════════════════════════

/** 锁文件的后缀——与原子写的 `.tmp` 分开（两者可以同时存在：一个在写、一个在等）。 */
const LOCK_SUFFIX = '.lock'

/** 拿到锁的等待上界——**有界**（毫秒）。锁只在读写那几微秒里持有，故 1 秒已是它的千倍。 */
const LOCK_WAIT_MS = 1_000

/** 重试间隔——短，因为等的是「几微秒就放开」那种锁。 */
const LOCK_RETRY_MS = 2

/**
 * 多久没动过才算**可能**是残骸（毫秒）——还须**它的主儿已经不在了**（见 `isAbandoned`）。
 *
 * 只在「持有者中途死掉」这一条路上用到：正常释放是 `rmSync`，到不了这一步。阈值取得比
 * 持有时间长**六个数量级**；反过来，不认残骸的话，一次崩溃就让授权**再也写不进去**
 * ——那是更坏的失败方向。
 */
const LOCK_STALE_MS = 10_000

/** 一把到手的锁。 */
type HeldLock = { readonly release: () => void }

/**
 * **按规范化文件路径**算锁键（不是字符串路径）。
 *
 * 三层规范化，各自治一种「同一个文件、两个写法」：
 * ① 目录建出来（锁要落在目录里）→ ② 目录取 `realpath`（`/tmp` 与 `/private/tmp`、
 * 符号链接的目录、`..` 绕路都是同一处）→ ③ 文件若**已存在**再取它的 `realpath`
 * （文件本身是符号链接时，两个指向它的写法也锁在同一把锁上）。
 *
 * 文件还不存在（第一次点 `a`）时走不到 ③，但那时也没有「两个写法」的问题：
 * 这一份是刚被建出来的。
 */
function canonicalPath(path: string): string {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  let realDir: string
  try {
    realDir = realpathSync(dir)
  } catch {
    realDir = resolve(dir) // 目录都读不动＝后面那一步自己会响亮地失败，不在这里替它报
  }

  const target = join(realDir, basename(path))
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}

/**
 * 拿那把短独占锁——**有界等待**，到点给出**具体原因**。
 *
 * 原子性靠 `O_CREAT|O_EXCL`（`openSync` 的 `'wx'`）：同一时刻只有一个能建出来，
 * 于是「建出来的人持有」这件事不依赖先读后写。
 *
 * 三条不做的：**不静默失败**（拿不到就抛，理由里带上锁文件、持有者、等了多久）·
 * **不无限等**（`LOCK_WAIT_MS`）· **不独占一切**（锁键是这一个文件，别的文件各锁各的）。
 */
async function acquireLock(lockPath: string, path: string): Promise<HeldLock> {
  const started = Date.now()

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`)
      } finally {
        closeSync(fd)
      }
      return { release: () => rmSync(lockPath, { force: true }) }
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error

      // 让别人先写完（正常情形：对面几微秒就放开）；真是残骸才清掉它——判据见 `isAbandoned`
      if (isAbandoned(lockPath)) {
        rmSync(lockPath, { force: true })
        continue
      }
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new Error(
          `文件正被另一个进程写着，等了 ${LOCK_WAIT_MS} 毫秒仍拿不到独占锁` +
            `（${lockPath}；${holderOf(lockPath)}）——${path} 本次没有写。`,
        )
      }
      await Bun.sleep(LOCK_RETRY_MS)
    }
  }
}

/**
 * 这把锁是不是**残骸**（主儿已经不在了，可以清掉）——两个条件都要，缺一不可。
 *
 * ⚠️ **读不到就说「不是」**（＝别删、再试一次）。这一条是踩出来的：对面刚放开的那一瞬，
 * `stat` 会 `ENOENT`——若把它当成「残骸」顺手 `rmSync`，删掉的可能是**别人刚拿到的那把
 * 锁**（其间第三个进程正好进来），于是两个进程同时进了临界区，共享的临时文件被 rename
 * 走，另一个当场 `ENOENT`。**「读不到」与「很久没动」是两件事**。
 *
 * 剩下的两个条件：「很久没动」＋「持锁的进程不在了」。只看时间不够——机器卡一下、
 * 持锁者被挂起，都可能超时，而时间判错的代价是**两个人同时写**（本单元要治的正是这个）。
 * 主儿还在就继续等（等到 `LOCK_WAIT_MS` 到点，如实报错），不抢。
 */
function isAbandoned(lockPath: string): boolean {
  let mtime: number
  let said: unknown
  try {
    mtime = statSync(lockPath).mtimeMs
    said = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return false // 刚放开 / 读不懂形态——都不构成「我有权删它」
  }

  if (Date.now() - mtime <= LOCK_STALE_MS) return false

  const pid = (said as { pid?: unknown }).pid
  // 主人无从查起（残骸写坏了）＝只按时间算；查得到就**必须**确认它真的不在了
  return typeof pid !== 'number' || !isAlive(pid)
}

/** 那个进程还在不在——`kill(pid, 0)` 不发信号，只问道（`ESRCH` ＝查无此人）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code !== 'ESRCH'
  }
}

/** 锁的持有者（报错时说得具体些）——读不出来就如实说读不出来。 */
function holderOf(lockPath: string): string {
  try {
    const said = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; at?: number }
    const since = said.at === undefined ? '' : `，${new Date(said.at).toISOString()} 起`
    return `持锁的是进程 ${said.pid ?? '(未记)'}${since}`
  } catch {
    return '锁文件读不出持有者（形态不对）——确认没有别的 magic 在跑就把它删掉'
  }
}
