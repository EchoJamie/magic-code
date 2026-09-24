/**
 * 进程级执行原语——`exec` 的实现体（技术方案 · 执行 · 首站实现）。
 *
 * **首站取薄隔离**（技术方案 · 执行 · 隔离姿态）——工作目录约束 ＋ 权限闸门（闸门在工具域，
 * 不在此）；本文件只管「把一条命令跑起来、看着它、把它收干净」。
 *
 * 与端口的分工：`sandbox.ts` 管**路径与工作区**（cwd 解析 / 越界归位），
 * 本文件只看**进程**（启动 · 流 · 超时 · 取消）——cwd 进来时已是绝对路径。
 *
 * 三条实测来的形态决定（U01 契约层审查 M1/M2 实测 ＋ 本轮探针复验）：
 * - **经 shell 跑**（`sh -c`）——「命令不存在」于是成为 **exit 127**（命令失败），
 *   而不是 `Bun.spawn` 对不存在可执行文件直接抛的 ENOENT（那是**启动失败**）。
 *   两者必须分属两界：前者 `ok:true` · exit≠0，后者 `ok:false` · `reason:'spawn'`。
 * - **自成进程组**（`detached`）——超时 / 取消按**组**收，连命令起的孙进程一起，
 *   不留给用户一窝逃逸的孤儿（实测：只杀直接子进程时 `sleep` 会活下来）。
 * - **`SIGKILL` 收命**——实测 `SIGTERM` 可被命令 `trap` 掉：忽略 TERM 的命令会照常跑完
 *   甚至 exit 0，于是「已超时 / 已取消」会被报成成功。SIGKILL 不可捕获，语义才闭合。
 */

import type { ExecResult, OutputDelta, ProcessLedger } from '@magic/contracts'

/** 超时缺省——毫秒（技术方案 · 执行 · 原语形态：缺省＝实现级常量）。 */
export const DEFAULT_TIMEOUT_MS = 120_000

/** 输出上限缺省——字节；**每道流各自计**（见 `sandbox.ts` 头注的取舍说明）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** 按信号终止的退出码（SIGKILL＝128+9）。 */
export const KILLED_EXIT = 137

/** 跑命令的宿主 shell——`-c` 取一条命令行。 */
const SHELL = 'sh'

/** 超时标记——私有哨兵：退出码是数字，令牌不是数字，两者在 `race` 里不会撞车。 */
const TIMED_OUT = Symbol('timeout')

/** 永不落定的 Promise——竞速位上的「本条件不参与裁决」（只让失败冒头，不让成功抢先）。 */
const NEVER = new Promise<never>(() => undefined)

/**
 * 按**进程组**收命。
 *
 * 子进程以 `detached` 自成一组（组长 pid ＝ 子进程 pid），故 `-pid` 即整组——
 * 命令起的后台孙进程一并收走。组不可达（已收干净 / 平台不给组）时退回直接收子进程。
 * `SIGKILL` 不可捕获——`trap` 挡不住，语义才闭合。
 */
function killTree(proc: Bun.Subprocess): void {
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    try {
      proc.kill('SIGKILL')
    } catch {
      // 已经死透了——无事可做
    }
  }
}

/** 一道流的读取产物。 */
type StreamDrain = {
  readonly text: string
  readonly truncated: boolean
}

/** 增量出口（契约 `ExecOptions.onOutput` 的形态）。 */
type OutputSink = (delta: OutputDelta) => void

/** 一次执行的进程侧入参——cwd 已是绝对路径（路径问题归 `sandbox.ts`）。 */
export type CommandOptions = {
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly onOutput?: (delta: OutputDelta) => void
  readonly signal?: AbortSignal
  /**
   * **归属账**（U50）——起来的这一组记它一笔。
   *
   * 为什么要记：执行者被 `SIGKILL` 时它自己来不及收尾，**谁起的这一组**就得有人知道
   * （设计：「执行者崩溃或被杀 ⇒ 管理者收回……**已登记**自有进程组」）。不记账的那条路
   * （用例 / 直连沙箱）照旧能跑——缺省不给就是不给。
   */
  readonly ledger?: ProcessLedger | undefined
}

/** 账上那句「什么起的」留多长——够认出来就行，不把整条命令搬进账里。 */
const LEDGER_WHAT_CHARS = 40

/**
 * 把一道流读干——**读到 EOF 才停**（即便已到上限也不能停手：停了管道写满，命令会卡死）。
 *
 * **解码按流式续接**（`{ stream: true }`）——块边界不保证落在字符边界上，
 * 逐块独立解码会把跨块的多字节字符劈成乱码；`text` 与增量**同源**，
 * 故「增量拼接 ＝ 终值」这条判据由构造保证，不靠事后拼装。
 */
async function drain(
  stream: ReadableStream<Uint8Array>,
  channel: OutputDelta['channel'],
  sink: OutputSink | undefined,
  cap: number,
): Promise<StreamDrain> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let seen = 0
  let truncated = false

  const emit = (chunk: string): void => {
    if (chunk.length === 0) return
    text += chunk
    sink?.({ channel, text: chunk })
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    // 上限**按字节**记（`maxOutputBytes` 是字节）——超出部分丢弃，但**照读不辍**：
    // 停手会让管道写满，命令卡在写不动上，那就不是「截断」而是「挂死」了。
    const room = cap - seen
    seen += value.length
    if (value.length > room) truncated = true

    const accepted = value.length <= room ? value : value.subarray(0, Math.max(room, 0))
    if (accepted.length > 0) emit(decoder.decode(accepted, { stream: true }))
  }

  // 收尾——冲掉末尾未完的多字节序列（跨块字符的最后一片）。**截断时不冲**：
  // 那半片是被我们砍断的，冲出来只会是一个替换符（U+FFFD）——丢掉比编造诚实，
  // 也保住「终值字节数 ≤ 上限」这条不变量。
  if (!truncated) emit(decoder.decode())

  return { text, truncated }
}

/**
 * 跑一条命令。
 *
 * **错误＝返回值**（技术方案 · 执行 · 原语形态）——本函数不抛：命令跑了给 `ok:true`
 * （含 exit 非 0），沙箱级失败给 `ok:false` ＋ `reason`。
 */
export async function runCommand(cmd: string, options: CommandOptions): Promise<ExecResult> {
  // 已中止的信号——**不启动进程**：取消＝「别跑」，不是「跑起来再杀」。
  // 返回值与「跑到一半被取消」同形（见 `ExecResult` 那一处的取舍说明）：
  // 究竟跑没跑过，由调用方自持的 `signal.aborted` 与既有输出共同表述。
  if (options.signal?.aborted === true) {
    return { ok: true, exit: KILLED_EXIT, stdout: '', stderr: '' }
  }

  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>

  try {
    proc = Bun.spawn([SHELL, '-c', cmd], {
      cwd: options.cwd,
      stdin: 'ignore', // 不给命令喂宿主 stdin——交互式命令即得 EOF，不悬着等输入
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true, // 自成进程组：收命时按组收（见文件头注）
    })
  } catch (error) {
    // 报文里点出 cwd——`Bun.spawn` 的 ENOENT 指向可执行名（`posix_spawn 'sh'`），
    // 而真凶多半是 cwd 不存在 / 不可达；不点出来，排障得反推
    return {
      ok: false,
      reason: 'spawn',
      message: `启动失败（cwd: ${options.cwd}）：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // **记账**（U50）：起来的这一组归谁——组长就是刚起来的那个（`detached` 保证）。
  // 记在这一跳（spawn 成功之后、干活之前）：账上多一条不碍事，少一条就没人在收尾时
  // 找得到它。什么时候摘由账自己判（组没了就摘，见 `groups.ts`）。
  options.ledger?.add({
    pgid: proc.pid,
    what: `exec:${cmd.split('\n', 1)[0]?.trim().slice(0, LEDGER_WHAT_CHARS) ?? ''}`,
  })

  // 取消——信号一响就按组收命。**不另立分支**：收命后 `proc.exited` 自然落定 137，
  // 走的是「命令跑了 · exit≠0」那条正道（取消不是沙箱级失败，见上）。
  const onAbort = (): void => killTree(proc)
  options.signal?.addEventListener('abort', onAbort, { once: true })

  // 读流与「等进程退出」并行——不先排空管道，写得多一点的命令会卡在写满的管道上
  const stdoutTask = drain(proc.stdout, 'stdout', options.onOutput, options.maxOutputBytes)
  const stderrTask = drain(proc.stderr, 'stderr', options.onOutput, options.maxOutputBytes)

  // 超时＝自持计时器 ＋ 哨兵，**不从退出码反推**：命令自己死成 137（`kill -9 $$`）
  // 与「被我们超时收掉」同码不同界，靠退出码猜必然混为一类。
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof TIMED_OUT>((markTimeout) => {
    timer = setTimeout(() => markTimeout(TIMED_OUT), options.timeoutMs)
  })

  // 读流若**自己坏掉**（消费方回调抛错一类），必须当场浮上来——否则要等命令跑完
  // 才发作：既白等一场，又漏掉收命（`NEVER` 让「正常读完」不参与裁决，只让失败冒头）。
  const drained = Promise.all([stdoutTask, stderrTask])

  try {
    let outcome: number | typeof TIMED_OUT
    try {
      outcome = await Promise.race([proc.exited, deadline, drained.then(() => NEVER)])
    } finally {
      clearTimeout(timer) // 进程已落定——别让计时器吊着事件循环
      options.signal?.removeEventListener('abort', onAbort) // 摘监听——信号常比单次执行长寿
    }

    if (outcome === TIMED_OUT) {
      killTree(proc)
      await Promise.all([proc.exited, stdoutTask, stderrTask]) // 收尸 ＋ 排空，不留悬着的读
      return {
        ok: false,
        reason: 'timeout',
        message: `命令超时（${options.timeoutMs}ms）未完成——已终止`,
      }
    }

    const [stdout, stderr] = await drained

    return {
      ok: true,
      exit: outcome,
      stdout: stdout.text,
      stderr: stderr.text,
      // 字段缺席＝没截（缺省态不占位，事件信封序列化后也干净）
      ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
    }
  } catch (error) {
    // 走到这里＝**沙箱自身出了岔子**（不是命令失败，也不是三例沙箱级失败）：
    // 多半是消费方回调抛错。两条纪律——**不吞**（消费者自己的 bug 该响）、
    // **不留孤儿**（抛出去之前把命令连孙进程收干净）。
    killTree(proc)
    await proc.exited.catch(() => undefined)
    throw error
  }
}
