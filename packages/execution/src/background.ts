/**
 * **后台运行登记**（U70）——`exec` 的「后台」那一形的实现体。
 *
 * 出处：设计 · 工具执行与权限「**`exec` 有「后台」那一形**」——命令**交出去就不占着这一轮**，
 * 进程接着跑（dev server · watch · 长时间构建）。六格里本文件管**第一格（发起）**
 * 与**第五格（停）**，另加第六格那句「不搞无限期」的另一半（没有事件订阅，只有一次回执）：
 *
 * | 那一格 | 落在哪儿 |
 * | --- | --- |
 * | 发起 | `start` —— 起进程组、开输出文件、回 id ＋ 路径，**当场返回** |
 * | 交接 | `onFinish` —— 它**真退出了**才响一次（dev server 一直挂着就一直不响） |
 * | 取输出 | **不在本文件**：模型用既有的 `read` 读那个文件（沙箱认这处只读落点） |
 * | 停 | `stop(id)` —— 按**进程组**收，走 U50 那套收尾 |
 *
 * ## 三件与在轮内的 `exec` **同源**（不是另写一套）
 *
 * - **经 shell 跑**（`sh -c`）——「命令不存在」于是成为 exit 127，不是启动失败；
 * - **自成进程组**（`detached`）——收命时按**组**收，连孙进程一起（设计：「不许留一窝
 *   逃逸的孤儿」）；故「按 id 停」落到实处就是「按组停」；
 * - **记账**（`ProcessLedger`，U50）——起的这一组记一笔：执行者被 `SIGKILL` 时它自己来
 *   不及收尾，**管理者照着登记来收**。后台进程尤其要记：它比发起它的那一轮活得久。
 *
 * ## 两处**刻意不同**
 *
 * - **无超时**：超时是「在轮内等多久」的刻度（设计：它是 `exec` 的一个参数、由模型按
 *   手上的事给）。后台这一形本来就是「不占着这一轮」，再给它一个上界就是自相矛盾——
 *   到点了收回来的东西，恰恰是用户要它一直跑的那一类。**结束只有两条路**：它自己跑完，
 *   或按 id 停。
 * - **输出不截断**：在轮内的那个 64 KiB 上限，管的是「回填进上下文的那一段有多大」；
 *   后台的输出**不进上下文**（它落在文件里，模型按需 `read`，读多大由 `read` 那一处管）。
 *   故这里不设上限——截掉的话，dev server 挂久了后面那段日志就没了。
 *
 * ## ⚠️ 「输出安静了」不等于「它结束了」
 *
 * 本文件**不**据「多久没输出」判结束——那是设计点名不许的（dev server 跑着就没结束）。
 * `onFinish` 只由 `proc.exited` 触发，而那件事只发生在进程**真退出**时。
 */

import { closeSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import type {
  BackgroundFinish,
  BackgroundRuns,
  BackgroundStart,
  BackgroundStop,
  ProcessLedger,
  WorkspaceService,
} from '@magic/contracts'
import { reapOwned, startTimeOf } from './groups.ts'

/** 跑命令的宿主 shell——与 `exec.ts` 同一句（`-c` 取一条命令行）。 */
const SHELL = 'sh'

/**
 * 运行目录的权限——`0700`（同 U48 的运行目录那一手：**本机 socket 限该用户访问**靠的是
 * 目录 mode）。后台输出照着办：它可能带着命令吐出来的任何东西（含密钥一类），
 * 不该比运行目录本身更宽。
 */
const DIR_MODE = 0o700

/** 输出文件自己的权限——`0600`（同上，目录那道门之外再补一手）。 */
const FILE_MODE = 0o600

/** 一句 `what`（记进归属账的那串）留多长——够认出来就行，与 `exec.ts` 同一个数。 */
const LEDGER_WHAT_CHARS = 40

/**
 * **结束之后那条记录还留多久**（留几条）。
 *
 * 为什么留：`stop(id)` 要能把「**它本来就结束了**」与「**认不出这个 id**」分开说
 * ——两句话对用户不是同一件事（前者不用查，后者得回头看自己是不是记错了）。
 * 为什么有界：一场会话里跑几百条后台命令是常事，账不该越记越长（同 `ProcessLedger` 那条）。
 */
const KEPT_FINISHED = 32

/** 装配期构造入参（技术方案 · 领域划分 · 装配视图 2：执行域——工作区根注册）。 */
export type BackgroundOptions = {
  /**
   * **输出落在哪儿**——**工作区之外**（`MAGIC_HOME` 的运行目录下，由装配算好递进来）。
   *
   * 为什么不由本域自己算：算运行目录要读 `MAGIC_HOME` 与 `dataDir`，而「环境怎么读」
   * 是外壳 / 装配那一层的事（执行域不读 `process.env`——同 `runPathsOf` 那条分工）。
   * 目录不存在时本域建（`0700`）。
   */
  readonly dir: string
  /** 工作区端口——cwd 的解析规则**与沙箱同源**（相对按默认根 · 绝对须落根内）。 */
  readonly workspace: WorkspaceService
  /** 归属账（U50）——与沙箱、MCP 传输共用同一本（「哪些进程是我们起的」只该有一本账）。 */
  readonly ledger?: ProcessLedger | undefined
}

/** 一条后台运行在账上的样子。 */
type Run = {
  readonly id: string
  readonly command: string
  readonly outputPath: string
  readonly pgid: number
  readonly startedAt: number | undefined
  readonly proc: Bun.Subprocess<'ignore', number, number>
  /** 它已经落定了没有（落定之后这一条转进 `finished`，停它只会得到「本来就结束了」）。 */
  done: boolean
  /** **正在被停**（`stop` 动的手）——那个退出不是它自己跑完的，回执上要说得出来。 */
  stopping: boolean
  readonly onFinish: ((finish: BackgroundFinish) => void) | undefined
}

/** 造一个后台运行登记。 */
export function createBackgroundRuns(options: BackgroundOptions): BackgroundRuns {
  const { workspace } = options
  const dir = resolvePath(options.dir)

  /** 还站着的那些——按 id 取。 */
  const live = new Map<string, Run>()
  /** 已经结束的那些——**有界**保留（见 `KEPT_FINISHED`），只为把「本来就结束了」说得出口。 */
  const finished = new Map<string, true>()
  let seq = 0

  /** 把目录立起来——`0700`，一层不多一层不少（已存在时也收一次 mode，见 U48 的同一条理由）。 */
  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    try {
      realpathSync(dir)
    } catch {
      // 目录刚建、`realpath` 偶发读不到——不影响使用，`start` 那一跳仍会当场报真错
    }
  }

  /**
   * 一次运行结束了——摘账、留痕、说一声。
   *
   * ⚠️ **回调抛错不外溢**：它是通报，不该带倒收尾那一跳（收了命却因为一句通报把异常
   * 甩给调用方，那才是真的把「谁负责」弄丢了）。如实吞下并让它只影响这一次通报。
   */
  const settle = (run: Run, exit: number | null): void => {
    run.done = true
    live.delete(run.id)
    finished.set(run.id, true)
    while (finished.size > KEPT_FINISHED) {
      const oldest = finished.keys().next()
      if (oldest.done === true) break
      finished.delete(oldest.value)
    }

    if (run.onFinish === undefined) return
    try {
      run.onFinish({
        id: run.id,
        command: run.command,
        outputPath: run.outputPath,
        ok: exit === 0,
        exit,
        ...(run.stopping ? { stopped: true as const } : {}),
      })
    } catch {
      // 通报那一侧的岔子（会话已经不在 / 屏已经关了一类）——收尾这一跳照旧走完
    }
  }

  return {
    async start(cmd, opts): Promise<BackgroundStart> {
      // **cwd 与沙箱同源**（相对按默认根 · 绝对须落根内）——越界即拒，进程不启动
      let cwd: string
      try {
        cwd = opts?.cwd === undefined ? workspace.defaultRoot() : workspace.resolve(opts.cwd).absolute
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }

      ensureDir()

      const id = `bg-${(seq += 1)}`
      const outputPath = join(dir, `${id}.log`)

      // 输出文件**开在这里**（截断重来）：只有 `stdout` 与 `stderr` 两路的顺序问题，
      // 交给**同一个 fd** 就自然消解了（分成两个文件反而要在读的人那一头拼）
      let fd: number
      try {
        fd = openSync(outputPath, 'w', FILE_MODE)
      } catch (error) {
        return { ok: false, reason: `开不了输出文件（${outputPath}）：${reasonOf(error)}` }
      }

      let proc: Bun.Subprocess<'ignore', number, number>
      try {
        proc = Bun.spawn([SHELL, '-c', cmd], {
          cwd,
          stdin: 'ignore', // 交互式命令即得 EOF，不悬着等一个永远不来的输入
          stdout: fd,
          stderr: fd,
          detached: true, // 自成进程组：停的时候按组停（见文件头注）
        })
      } catch (error) {
        closeQuietly(fd)
        // 报文里点出 cwd——同 `exec.ts` 那一处（ENOENT 指向 `sh`，而真凶多半是 cwd）
        return { ok: false, reason: `启动失败（cwd: ${cwd}）：${reasonOf(error)}` }
      }

      // 子进程已经拿到自己的那一份——父进程这一份当场关掉（留着只是占一个 fd）
      closeQuietly(fd)

      const pgid = proc.pid
      const run: Run = {
        id,
        command: cmd,
        outputPath,
        pgid,
        // **记账那一刻**读一次组长身份——等收尾再读，读到的可能是别人（PID 重用）
        startedAt: startTimeOf(pgid),
        proc,
        done: false,
        stopping: false,
        onFinish: opts?.onFinish,
      }
      live.set(id, run)

      // 记账（U50）——**后台进程尤其要记**：它比发起它的那一轮活得久，
      // 执行者被杀时正是「没人认领的后台」最容易出现的那一形
      options.ledger?.add({
        pgid,
        what: `exec(bg):${cmd.split('\n', 1)[0]?.trim().slice(0, LEDGER_WHAT_CHARS) ?? ''}`,
      })

      // **它真退出的那一刻**——唯一的结束信号（见文件头注：不据「输出安静了」判）
      void proc.exited.then(
        (exit) => settle(run, exit),
        // `exited` 本身抛（极罕见：平台不给退出码）——按**读不到**处置，不编一个 0 出来
        () => settle(run, null),
      )

      return { ok: true, id, outputPath }
    },

    async stop(id): Promise<BackgroundStop> {
      const run = live.get(id)
      if (run === undefined) {
        return finished.has(id)
          ? { ok: true, already: true, note: `${id} 本来就结束了——这一下没有动它` }
          : { ok: false, reason: `没有 ${id} 这条后台命令（id 记错了？还是已经过了这台机器的这一代）` }
      }

      // 标一声：接下来那个退出**不是它自己跑完的**——回执要据实分说（见 `settle`）
      run.stopping = true

      // **按组收**，走 U50 那套（有界等待 → TERM → 等 → KILL → 等），且**先核对身份**
      // ——号会被系统回收再分配，核对不上就一个信号都不发
      const outcome = await reapOwned({ pgid: run.pgid, startedAt: run.startedAt, what: `exec(bg):${id}` })

      // 落定之后再回话：收命是**发出去了**，而「它退出没有」由 `exited` 说了算
      // （不等这一下的话，回执会在进程还喘着气的时候说「已停掉」）
      if (!run.done) {
        const exited = await Promise.race([
          run.proc.exited.then(() => true),
          Bun.sleep(2_000).then(() => false),
        ])
        if (!exited) {
          return { ok: false, reason: `${id} 收到信号之后还没退——没能收干净（${describe(outcome)}）` }
        }
      }

      if (outcome.kind === 'left') return { ok: false, reason: `${id} 没停掉：${outcome.note}` }
      if (outcome.kind === 'stranger' || outcome.kind === 'unprovable') {
        return { ok: false, reason: `${id} 没能确认是它：${outcome.note}` }
      }
      if (outcome.kind === 'gone') {
        // 组本来就没了＝它自己跑完的：把那个标记撤回——**那一声回执不该说成「停的」**
        // （收尾这一跳与 `settle` 谁先谁后不定，撤了才不会有那一线的误报）
        run.stopping = false
        return { ok: true, already: true, note: `${id} 本来就结束了——这一下没有动它` }
      }

      return { ok: true, note: `已停掉 ${id}（连它起的孙进程一并收了）` }
    },
  }
}

/** 收尾那四种结局的一句话（回执里带上它——「停不掉」得说得出是卡在哪一档）。 */
function describe(outcome: { readonly kind: string; readonly note?: string }): string {
  return outcome.kind === 'left' || outcome.kind === 'unprovable' || outcome.kind === 'stranger'
    ? String(outcome.note)
    : outcome.kind
}

/** 关一个 fd——关不掉（已经关了 / 平台不给）不该让发起那一跳失败。 */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // 见上
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
