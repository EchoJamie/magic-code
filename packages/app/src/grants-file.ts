/**
 * 授权文件（`~/.magic/grants.json`）的**读写** —— 装配视图第 1 步的边上（U22）。
 *
 * 技术方案 · 权限「授权的落点」：
 *
 * > 存处＝内核自持的授权文件 `~/.magic/grants.json`（按工作区绝对路径分节 · 内核读写）；
 * > **内核不写用户手写的 `config.json`**——写回的麻烦（原子写 · 保留用户编辑 · 并发）
 * > 只落在一个**它全权持有**的文件上。……**原子写 ＋ 失败方向安全**
 * > （最坏丢一次授权，不是多给一次）。
 *
 * 本文件就是那三件麻烦的落点，逐条对应：
 *
 * - **原子写**——先写同目录的临时文件、`rename` 覆盖（`rename` 在同一文件系统上是原子的）。
 *   直接 `writeFile` 到目标上的话，写到一半掉电就是半份 JSON ⇒ 下次启动整份读不懂
 *   （而解析从严意味着**一条授权都不生效**——用户点过的 `a` 全没了）。
 * - **保留用户编辑**——**不必**：这个文件归内核全权持有（这正是设计选它的理由），
 *   用户手写它不在契约里；故不做读改写合并。
 * - **并发**（U47 改）——见下。
 *
 * ## 并发：读取当前内容 → 应用一项增删 → 原子保存，**串行**（U47）
 *
 * 原先这一格写的是「同一台机器上同时开两个 magic 时，最后落盘的那个赢（**已知限度**）」。
 * 那在单进程形态下不显形，但设计已把「多执行者」排在下一步（设计 · 会话与运行管理
 * 「多执行者共享数据的前置条件」第二项），而**整份覆写**在多执行者下不是「丢一次授权」
 * 那么轻：A、B 各持启动时读来的旧账本，A 撤销之后 B 一写就把那条**复活**了——撤销失灵，
 * 而撤销是安全动作。
 *
 * 故改动一律走 `commitGrants`，四步一条龙：
 *
 * 1. **拿短独占锁**——锁键＝**规范化文件路径**（不是字符串路径）：同一份文件的不同写法
 *    （符号链接、`/tmp` 与 `/private/tmp`、`..` 绕路）锁在同一把锁上。不同 `dataDir`
 *    共用一个 `grants.json` 时就是靠这一条协调的。
 * 2. **读当前内容**——重新读盘（不是拿启动时那份），故别人刚改的看得到。
 * 3. **应用一项增删**——`applyGrantEdit`，一项就是一项（不整份覆写）。
 * 4. **原子保存**——同上的临时文件 ＋ `rename`。
 *
 * 锁只在第 2–4 步之间持有（**微秒级**）；拿不到就**有界等待**，到点**给出具体原因**
 * （哪个文件、谁握着、等了多久），不静默失败、不无限等。
 *
 * **解析从严归权限域**（`parseGrants`）：本文件只管**字节**——读不出来（文件不在 / JSON 坏）
 * 就报「没有」并**带上缘由**，由装配决定怎么说给用户听；**不在这里替它猜**。
 */

import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { GrantEdit, GrantProblem, GrantsFile } from '@magic/permission'
import { applyGrantEdit, emptyGrants, parseGrants } from '@magic/permission'

/** 读的结果——盘上没有 / 读不懂都**不抛**（授权缺失不是启动期事故：默认问那条路照走）。 */
export type LoadedGrants = {
  /** 实际读的文件（已展开的绝对路径）。 */
  readonly path: string
  /** 解析后的那一份（读不到时是空文件）。 */
  readonly file: GrantsFile
  /** 读不懂的条目（连同缘由）——交回装配，够格就报一行给用户。 */
  readonly rejected: readonly GrantProblem[]
  /**
   * 出了什么事的一句话（`undefined` ＝ 一切正常）——**文件不在不是事**（第一次用谁都没有），
   * 故「不在」不报；**JSON 坏**要报（那是用户的文件被写坏了，得让他知道那一条路没走成）。
   */
  readonly note?: string
}

/**
 * 读授权文件。
 *
 * **加载时只读不清理**（`B11`）——本函数**一个字节都不写**，陈旧节也不动：删用户数据不归内核。
 *
 * @param path 已展开的绝对路径（`GRANTS_FILE` 经 `expandHome`）。
 */
export function loadGrants(path: string): LoadedGrants {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // 文件不在＝常态（第一次跑、或从没点过 `a`）——不是错，也不值得在屏上说一句
    return { path, file: emptyGrants(), rejected: [] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      path,
      file: emptyGrants(),
      rejected: [],
      note: `授权文件不是合法 JSON（${reason}）——本轮一条授权都没加载`,
    }
  }

  const parsed = parseGrants(raw)
  return {
    path,
    file: parsed.file,
    rejected: parsed.rejected,
    // 读不懂的条目**没进账本**，故 `/grants` 里也撤不到它们（名录只列在册的）——
    // 出口是把文件改对或删掉那几条，这一句得说清是哪一个出口
    ...(parsed.rejected.length === 0
      ? {}
      : {
          note: `授权文件里有 ${parsed.rejected.length} 条读不懂（未生效）——改文件或把那几条删掉`,
        }),
  }
}

/**
 * 提交一次改动（U47）——**读取当前内容 → 应用一项增删 → 原子保存**，全程握着短独占锁。
 *
 * 这是本文件对外**唯一**的写入口（`saveGrants` 已收回作内部件）：整份覆写这条路在多执行者
 * 下会抹掉别人刚落的改动、复活已经撤销的授权，故不再对外提供。
 *
 * @param path 已展开的绝对路径（同 `loadGrants`）。
 * @param edits 这一次要落的改动，**按序**应用（攒下的命中记账可以好几笔合成一次锁）。
 *   ⚠️ 空数组＝什么都不做（不发锁、不写盘）——「没有改动」不该产生一次写入。
 */
export function commitGrants(path: string, edits: readonly GrantEdit[]): void {
  if (edits.length === 0) return

  // 规范化**只用于锁键**：读写仍走调用方给的那个路径（那是「用户指的文件」，
  // 文件本身是符号链接时也该照原样写它，而不是悄悄改去写它指向的那个）。
  const lockPath = `${canonicalPath(path)}${LOCK_SUFFIX}`
  const lock = acquireLock(lockPath, path)

  try {
    let file = loadGrants(path).file // ② 读**当前**内容（不是启动时那一份）
    for (const edit of edits) file = applyGrantEdit(file, edit) // ③ 一项一项地改
    saveGrants(path, file) // ④ 原子保存
  } finally {
    lock.release()
  }
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
  mkdirSync(dir, { recursive: true })

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
function acquireLock(lockPath: string, path: string): HeldLock {
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
          `授权文件正被另一个进程写着，等了 ${LOCK_WAIT_MS} 毫秒仍拿不到独占锁` +
            `（${lockPath}；${holderOf(lockPath)}）——${path} 本次没有写。`,
        )
      }
      Bun.sleepSync(LOCK_RETRY_MS)
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

// ══ 原子写 ════════════════════════════════════════════════════════════

/**
 * 写授权文件（**原子**）——`commitGrants` 的内部件，调用方须已持锁。
 *
 * 临时文件与目标**同目录**：`rename` 只在同一文件系统内是原子的，跨设备会退化成复制。
 * 临时文件名带 `.tmp` 后缀且**固定**（不加随机数）：同一时刻只有一个内核在写这个文件
 * ——持锁那一条保证了它，故不必为并发再加随机数，而随机数只会在崩溃后留下一堆
 * 没人认领的残骸。
 */
function saveGrants(path: string, file: GrantsFile): void {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}
