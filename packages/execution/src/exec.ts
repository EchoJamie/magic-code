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
 *
 * ⚠️ **超时没有缺省常量了**（U69）——原先这里有一个 `DEFAULT_TIMEOUT_MS = 120_000`，
 * 谁不显式给就套上它。撤掉的理由是它**替所有命令回答了一个没有全局答案的问题**：
 * 「这条命令该等多久」只有发起那件事的人知道（`ls` 与一次构建不是一回事）。
 * 留一个常量当兜底，就是留着 D39 那个坑——120 秒一刀切掐掉正当的长活
 * （2026-09-25 实测：`swift package resolve` 跑到 123.5 秒被掐，而它真在下载依赖）。
 * 现在**缺省 ＝ 不设上界**（一直等）；上界由调用方按手上的事给（设计 · 工具执行与权限）。
 * 一道来的还有**输出**：超时那一支不再是「没跑成」，它**把两道流带回**——命令跑过了
 * （见下面 `TimeoutToken` 与那一支的注）。
 */

import type { ExecResult, OutputDelta, ProcessLedger } from '@magic/contracts'

/** 输出上限缺省——字节；**每道流各自计**（见 `sandbox.ts` 头注的取舍说明）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** 按信号终止的退出码（SIGKILL＝128+9）。 */
export const KILLED_EXIT = 137

/** 跑命令的宿主 shell——`-c` 取一条命令行。 */
const SHELL = 'sh'

/**
 * 超时令牌——私有哨兵，**载着真报了的那条上界**（毫秒）。
 *
 * 两件事合成一个值：**退出码是数字，令牌是对象**，两者在 `race` 里不会撞车（哨兵不变的那条）；
 * 令牌**带着那一条上界**，于是报文与 `timeoutMs` 都从**报了的那个数**取，
 * 不必拿调用方自己记的那份来对——两处各记一份，迟早有对不上的那天。
 */
type TimeoutToken = { readonly boundMs: number }

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
  /**
   * 超时上界——**`null` ＝ 不设上界**（一直等，本文件不立计时器）。缺省常量已撤（见上）。
   * 归一化（合法／非法值各归哪一档）归 `sandbox.ts`，本文件只收两种：一个正数，或 `null`。
   */
  readonly timeoutMs: number | null
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
 *
 * ## ⚠️ 越过上限时**头尾都留**（U93 · `D40` 的「乙」那一半）
 *
 * 原写法是 `value.subarray(0, room)`——**只留开头，超出部分只丢不换**。而结论常在
 * **尾部**：构建日志的报错、测试报告的失败清单、编译器最后那几行。只留头 ＝ 把结论换成
 * 开场白（`D40` 现场：108930 字节的输出，模型手里只有开头那 65557）。
 *
 * 故上限**内**分两段：**头一半 ＋ 尾一半**（上限那个数一个字没动——改的是「留哪一头」，
 * 不是「留多少」）。取整与 U82 在上下文那一侧落的那一手同形：**奇数时多出的那一字节归头**。
 *
 * 两条随之而来的形态：
 *
 * - **头那一半照旧实时吐出去**（`sink`——屏幕上看的、记录里攒的都是它）。头之后的字节
 *   先攒在一个**只留最后 `tailCap` 字节**的缓冲里；到头来若**没越过上限**，那一段原样
 *   补吐出去（于是「增量拼接 ＝ 终值」这条判据**一个字没破**），越过了才是「尾巴那一份」。
 * - **中段省掉**，并在省略处**写明省了多少、怎么看全**（`truncationNote`——照 U82 那段
 *   省略说明的形状：那一段是模型唯一能据以判断「这份是不是完整」的东西）。
 *
 * ## 头尾相接处的两片半截字符
 *
 * 头那一半停在半片多字节字符上时**不冲**（冲出来只会是个替换符——丢掉比编造诚实，
 * 这条是既有的）；尾巴那一份另起一个解码器，且**从半片字符之后接上**——两处都不编造
 * 替换符。尾巴的末尾是**这条流真正的结尾**，故照常冲（与非截断那一支同一条规矩）。
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

  // 上限里面的两段。`cap` 理应恒为正（`sandbox.ts` 的 `positiveOr` 兜着），
  // 但本函数是导出面的下一层、谁直连都可能——故两段都夹在 0 以上，别让负数变成抛。
  const headCap = Math.max(0, Math.ceil(cap / 2))
  const tailCap = Math.max(0, cap - headCap)
  const tailBuf = new Uint8Array(tailCap)
  let tailLen = 0 // 尾巴缓冲里现有几个字节（≤ tailCap）
  let headDone = 0 // 头部已经吐出去几个字节

  const emit = (chunk: string): void => {
    if (chunk.length === 0) return
    text += chunk
    sink?.({ channel, text: chunk })
  }

  /** 往尾巴缓冲里续一段——**只留最后 `tailCap` 字节**（更早的丢掉：它们是中段）。 */
  const keepTail = (piece: Uint8Array): void => {
    if (tailCap === 0 || piece.length === 0) return

    if (piece.length >= tailCap) {
      tailBuf.set(piece.subarray(piece.length - tailCap))
      tailLen = tailCap
      return
    }

    const drop = Math.max(0, tailLen + piece.length - tailCap)
    if (drop > 0) {
      tailBuf.copyWithin(0, drop, tailLen)
      tailLen -= drop
    }
    tailBuf.set(piece, tailLen)
    tailLen += piece.length
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    // 上限**按字节**记（`maxOutputBytes` 是字节）——超出部分不留，但**照读不辍**：
    // 停手会让管道写满，命令卡在写不动上，那就不是「截断」而是「挂死」了。
    seen += value.length

    let rest = value
    if (headDone < headCap) {
      const room = headCap - headDone
      const part = value.length <= room ? value : value.subarray(0, room)
      headDone += part.length
      if (part.length > 0) emit(decoder.decode(part, { stream: true }))
      rest = value.subarray(part.length)
    }
    keepTail(rest)
  }

  // 缓冲里那一段的**绝对起点**（它在整条流里的字节位置）——据它认出头之后还该补多少。
  const bufferedFrom = seen - tailLen
  const afterHead = tailBuf.subarray(Math.max(0, headCap - bufferedFrom), tailLen)

  if (seen <= cap) {
    // 没越过上限：整条流一个字节都不少——头之后的续文接着喂同一个解码器，
    // 末尾照常冲（跨块字符的最后一片就在这儿接上）。
    if (afterHead.length > 0) emit(decoder.decode(afterHead, { stream: true }))
    emit(decoder.decode())

    return { text, truncated: false }
  }

  emit(`${text.endsWith('\n') ? '' : '\n'}${truncationNote(seen - cap, seen, headCap, tailCap)}\n`)
  emit(decodeFromCharStart(afterHead))

  return { text, truncated: true }
}

/**
 * 中段省掉那一句——**省了多少 ＋ 原文多大 ＋ 两头各留多少 ＋ 怎么看全**（U93）。
 *
 * 照 U82 在上下文那一侧落的那一段省略说明的形状（`conversation/src/context.ts` 的
 * `deliveredTextOf`）：四件都得出——**光截不指路**＝把「这里还有」变成一句没法行动的话
 * （`plan-tools.ts` 那条注释骂的就是这个）。
 *
 * ⚠️ **单位是字节**（这里的尺子就是字节：`maxOutputBytes` 按字节算），与 U82 那一段的
 * 字符不同——那是它的尺子。两处**规则同一条**（头尾都留 · 省略处报数指路），单位各随各的账。
 *
 * 「怎么看全」这一句不同于 U82 那一处：那边正文还在会话记录里（`history_read` 读得回），
 * 这里的**中段是真丢了**（流读过去就没了、记录里也没有）——故指的是一条**重跑**的路：
 * 把输出落成文件再分次取。⚠️ 不指一条跑不了的入口（`AGENTS.md`）。
 */
function truncationNote(omitted: number, total: number, head: number, tail: number): string {
  return (
    `…（截断：中间省略 ${omitted} 字节，原文共 ${total} 字节；` +
    `以上是开头 ${head} 字节、以下是结尾 ${tail} 字节。` +
    '要看全就重跑一次、把输出落成文件再分次取——' +
    '如 `cmd > out.txt 2>&1`，之后用 `read`，或 `tail` / `grep` / `sed` 取其中一段）'
  )
}

/**
 * 从**半片多字节字符之后**开始解码（尾巴那一份的开头就在这半片上）。
 *
 * 丢掉领头那几个续接字节（`10xxxxxx`），从下一个字符的开头接——不这样，尾巴的头一个字
 * 就是个替换符（那正是本文件一贯不肯编造的东西）。末尾照常冲：那是这条流真正的结尾。
 */
function decodeFromCharStart(bytes: Uint8Array): string {
  let at = 0
  while (at < bytes.length && ((bytes[at] as number) & 0xc0) === 0x80) at += 1

  return new TextDecoder().decode(bytes.subarray(at))
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
  //
  // **有上界才立计时器**：`null` ＝ 不设上界，此时竞速位上放「永不落定」——
  // 一则不白养一个定时器，二则语义就写在脸上：这一路**没有**会到点的那个东西。
  const bound = options.timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline: Promise<TimeoutToken> =
    bound === null
      ? NEVER
      : new Promise((markTimeout) => {
          timer = setTimeout(() => markTimeout({ boundMs: bound }), bound)
        })

  // 读流若**自己坏掉**（消费方回调抛错一类），必须当场浮上来——否则要等命令跑完
  // 才发作：既白等一场，又漏掉收命（`NEVER` 让「正常读完」不参与裁决，只让失败冒头）。
  const drained = Promise.all([stdoutTask, stderrTask])

  try {
    // 竞速位的三种落定：退出码（数字）、超时令牌（对象，见 `TimeoutToken`）、以及永不落定。
    let outcome: number | TimeoutToken
    try {
      outcome = await Promise.race([proc.exited, deadline, drained.then(() => NEVER)])
    } finally {
      clearTimeout(timer) // 进程已落定——别让计时器吊着事件循环
      options.signal?.removeEventListener('abort', onAbort) // 摘监听——信号常比单次执行长寿
    }

    if (typeof outcome === 'object') {
      // **超时不是「没执行」**（设计：命令跑过的结果与调用不成立分开）——命令跑了 123.5 秒、
      // 真在做，副作用可能已经发生。故这一支**照正常那一支把两道流带回**：收尸时
      // `stdoutTask` / `stderrTask` 本来就排空到 EOF（`await proc.exited` 之后 `drained`
      // 已是可取的终值），原先只是**没把值带出来**——D39 丢的就是这一份。
      killTree(proc)
      await proc.exited // 收尸
      const [stdout, stderr] = await drained // 排空，不留悬着的读
      return {
        ok: false,
        reason: 'timeout',
        message: `命令超时（${outcome.boundMs}ms）未完成——已终止`,
        timeoutMs: outcome.boundMs,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
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
