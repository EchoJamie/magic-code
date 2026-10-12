import { spawnOwned } from './process.ts'
import { reapOwned } from './groups.ts'
/** 前台命令完成须同时取得业务退出码与双流 EOF；超时和取消覆盖整个等待。 */

import type { ExecResult, OutputDelta, ProcessLedger } from '@magic/contracts'

/** 输出上限缺省——字节；**每道流各自计**（见 `sandbox.ts` 头注的取舍说明）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** 跑命令的宿主 shell——`-c` 取一条命令行。 */
const SHELL = 'sh'

const NEVER = new Promise<never>(() => undefined)

/** 一道流的读取产物。 */
type StreamDrain = {
  readonly text: string
  readonly truncated: boolean
  readonly incomplete: boolean
}

/** 增量出口（契约 `ExecOptions.onOutput` 的形态）。 */
type OutputSink = (delta: OutputDelta) => void

/** 一次执行的进程侧入参——cwd 已是绝对路径（路径问题归 `sandbox.ts`）。 */
export type CommandOptions = {
  readonly env?: Readonly<Record<string, string>>

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
  signal: AbortSignal,
  failed: (error: unknown) => void,
): Promise<StreamDrain> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let seen = 0
  let incomplete = false
  let output = sink
  const canceled = Promise.withResolvers<{ done: true; value: undefined } | { done: false; value: Uint8Array }>()
  const cancel = () => { incomplete = true; canceled.resolve({ done: true, value: undefined }); void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()

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
    try { output?.({ channel, text: chunk }) } catch (error) { output = undefined; failed(error) }
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

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), canceled.promise])
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

  } catch (error) { incomplete = true; failed(error) } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }

  // 缓冲里那一段的**绝对起点**（它在整条流里的字节位置）——据它认出头之后还该补多少。
  const bufferedFrom = seen - tailLen
  const afterHead = tailBuf.subarray(Math.max(0, headCap - bufferedFrom), tailLen)

  if (seen <= cap) {
    // 没越过上限：整条流一个字节都不少——头之后的续文接着喂同一个解码器，
    // 末尾照常冲（跨块字符的最后一片就在这儿接上）。
    if (afterHead.length > 0) emit(decoder.decode(afterHead, { stream: true }))
    emit(decoder.decode())

    return { text, truncated: false, incomplete }
  }

  emit(`${text.endsWith('\n') ? '' : '\n'}${truncationNote(seen - cap, seen, headCap, tailCap)}\n`)
  emit(decodeFromCharStart(afterHead))

  return { text, truncated: true, incomplete }
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
  const began = Date.now()
  if (options.signal?.aborted) return { ok: false, reason: 'spawn', message: '命令已取消，未执行' }
  let started: Awaited<ReturnType<typeof spawnOwned<'pipe', 'pipe'>>>
  try {
    started = await spawnOwned([SHELL, '-c', cmd], {
      cwd: options.cwd, env: options.env, signal: options.signal, ledger: options.ledger,
      stdout: 'pipe', stderr: 'pipe', kind: 'exec',
      what: `exec:${cmd.split('\n', 1)[0]?.trim().slice(0, LEDGER_WHAT_CHARS) ?? ''}`,
    })
  } catch (error) {
    return { ok: false, reason: 'spawn', message: `启动失败（cwd: ${options.cwd}）：${error instanceof Error ? error.message : String(error)}` }
  }
  const proc = started.process
  const canceled = Promise.withResolvers<{ kind: 'canceled' }>()
  const onAbort = () => canceled.resolve({ kind: 'canceled' })
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  const readFailure = Promise.withResolvers<{ kind: 'cleanup'; error: unknown }>()
  const readers = new AbortController()
  const failed = (error: unknown) => readFailure.resolve({ kind: 'cleanup', error })
  const drained = Promise.all([
    drain(proc.stdout, 'stdout', options.onOutput, options.maxOutputBytes, readers.signal, failed),
    drain(proc.stderr, 'stderr', options.onOutput, options.maxOutputBytes, readers.signal, failed),
  ])
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = options.timeoutMs
  const deadline = bound === null ? NEVER : new Promise<{ kind: 'timeout' }>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, bound - (Date.now() - began)))
  })
  const completed = started.commandExited.then(async exit => exit === null
    ? { kind: 'cleanup' as const, error: new Error('命令退出码控制通道提前关闭') }
    : { kind: 'finished' as const, exit, output: await drained })
  try {
    const outcome = await Promise.race([completed, deadline, canceled.promise, readFailure.promise])
    if (outcome.kind === 'finished' && outcome.exit !== null) {
      const [stdout, stderr] = outcome.output
      return { ok: true, exit: outcome.exit, stdout: stdout.text, stderr: stderr.text,
        ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}) }
    }
    const reaped = await reapOwned({ pgid: proc.pid, startedAt: started.startedAt, what: 'exec' })
    const confirmed = reaped.kind === 'reaped' || reaped.kind === 'gone'
    const cleanup = { confirmed, ...('note' in reaped ? { note: reaped.note } : {}) }
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([drained, new Promise<void>(resolve => {
      drainTimer = setTimeout(() => { readers.abort(); resolve() }, 500)
    })])
    clearTimeout(drainTimer)
    const [stdout, stderr] = await drained
    const output = { stdout: stdout.text, stderr: stderr.text, cleanup,
      ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
      ...(stdout.incomplete || stderr.incomplete ? { outputIncomplete: true } : {}) }
    const ending = confirmed ? '自有进程组已退出' : `资源未核销：${cleanup.note}`
    if (outcome.kind === 'timeout') return { ok: false, reason: 'timeout', timeoutMs: bound!, message: `命令超时（${bound}ms）；${ending}`, ...output }
    if (outcome.kind === 'canceled') return { ok: false, reason: 'canceled', message: `命令已取消；${ending}`, ...output }
    return { ok: false, reason: 'cleanup', message: `命令输出或控制通道异常${outcome.kind === 'cleanup' ? `：${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}` : ''}；${ending}`, ...output }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
