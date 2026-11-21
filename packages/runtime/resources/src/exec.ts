import { spawnOwned } from './process.ts'
import { reapOwned } from './groups.ts'
/** 前台命令完成须同时取得业务退出码与双流 EOF；超时和取消覆盖整个等待。 */

import { accessSync, constants, readFileSync, rmSync } from 'node:fs'
import type { ExecResult, HandoverRun, OutputDelta, ProcessLedger } from '@magic/contracts'
import type { AdoptedRun } from './background.ts'

/**
 * 转后台那一条的两本账：
 * - `current`——移交之后，读到的原文往哪儿追加（先进来的那一段由 `prefix` 带过去）；
 * - `total`——**每个通道读到的原始字节数**（含移交前那一段）。回执里那份 `seen` 只含头部
 *   一半（尾巴要等流结束才吐），移交发生在流还在跑的时候，靠它判断「有没有丢一段」。
 */
type DrainTee = {
  current?: (chunk: Uint8Array) => void
  total?: (channel: OutputDelta['channel'], chunk: Uint8Array) => void
  /** 已经把**多少字节**变成正文吐给回执（含尾巴那一份；后半段的正文不是 byte 数能反推的）。 */
  emitted?: (channel: OutputDelta['channel'], bytes: number) => void
}

/** 输出上限缺省——字节；**每道流各自计**（见 `sandbox.ts` 头注的取舍说明）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** 跑命令的宿主 shell——`-c` 取一条命令行。缺省 `sh`；真实宿主要求用用户的 shell（`CommandOptions.shell`）。 */
const SHELL = 'sh'

/** 认得出「能用 POSIX 的 `VAR=…` / `trap … 0` 包装」的 shell 家族。 */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/**
 * 定这一条用哪只 shell、要不要加目录钩子。
 *
 * - 用户 shell 是 POSIX 家族（且可执行）⇒ 用它，加钩子；
 * - 别的 shell（csh / tcsh / fish）⇒ 照用它跑命令，但**不加钩子**——那层包装的语法它们不认，
 *   加了只会让命令报「Command not found」，反倒把真正的失败盖住；
 * - 指了一个跑不起来的 shell ⇒ 退回 `sh`（每条命令都报「找不到可执行文件」比回落更坏）。
 */
function resolveShell(requested: string | undefined): { readonly path: string; readonly hook: boolean } {
  const path = requested ?? SHELL
  // 跑不起来的 shell ⇒ 退回 `sh`（每条命令都报「找不到可执行文件」比回落更坏）
  try {
    accessSync(path, constants.X_OK)
  } catch {
    return { path: SHELL, hook: true }
  }
  const base = path.split('/').pop() ?? path
  return { path, hook: POSIX_SHELLS.has(base) }
}

/**
 * 命令外层的**会话目录钩子**（`trap … 0`）——shell 退出时把真实 `PWD` 写进那个文件。
 *
 * 为什么是 `trap … 0` 而不是在命令后追加一句 `pwd`：`exit N`、`set -e` 失败退出都会让
 * 追加句永远轮不到，而退出钩子照样跑。`exec` 把 shell 整个换掉时钩子不执行——那是已知边界，
 * 取不到就缺席（不编值）。
 *
 * 变量名带下划线与前缀，避免与命令自己用到的名字撞车；`2>/dev/null || :` 让取不到目录
 * （目录已被删一类）不往 stderr 里添噪声。
 */
function withCwdReport(cmd: string, file: string, oldCwd: string | undefined): string {
  const quoted = `'${file.replaceAll("'", `'\\''`)}'`
  // `OLDPWD` 要在**这个 shell 里**设置：`sh -c` 启动时会把外部注入的 OLDPWD 当没设
  // （实测 `cd: OLDPWD not set`），只有 shell 自己 `export` 的那份才让 `cd -` 生效。
  const old = oldCwd === undefined ? '' : `OLDPWD='${oldCwd.replaceAll("'", `'\\''`)}'; export OLDPWD\n`
  return `_MAGIC_CWD_FILE_=${quoted}\n${old}trap 'pwd -P > "$_MAGIC_CWD_FILE_" 2>/dev/null || :' 0\n${cmd}\n`
}

/** 取回钩子写下的目录；文件不存在或为空都给 `undefined`（不编值）。 */
function readReportedCwd(file: string | undefined): string | undefined {
  if (file === undefined) return undefined
  try {
    const text = readFileSync(file, 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

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
  /**
   * **执行命令的 shell**——用户是谁的 shell，就用谁的（路径）。缺省 `sh`。
   *
   * 换 shell 不是换「隔离级别」，是换**语法与启动文件**：`zsh -c` 会读 `~/.zshenv`，
   * `bash -c` 读 `~/.bashrc`（非交互时行为不同）——这是用户环境的一部分。
   */
  readonly shell?: string

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
   * 到点还没结束怎么办——`kill`（缺省，按进程组收掉）或 `background`（交出去接着跑）。
   * `background` 需要 `adopt` 在场；不在时按 `kill` 处置（不静默改变语义，见下面的分支）。
   */
  readonly onTimeout?: 'kill' | 'background'
  /** 把一条已经跑起来的命令交出去（工具把上下文里的后台端口接在这一格上）。 */
  readonly adopt?: (run: HandoverRun) => Promise<AdoptedRun>
  /**
   * 会话目录的报回口——见 `cwdFile`。给了只在 **POSIX 家族 shell** 下加分目录钩子。
   */
  readonly cwdFile?: string
  /**
   * **上一条命令开始时所在目录**（`OLDPWD`）——`cd -` 才有意义。
   *
   * 本文件不自己算这个：它是沙箱的会话状态（见 `sandbox.ts` 的 `previousCwd`）。
   */
  readonly oldCwd?: string
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
  tee?: DrainTee,
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

  const emit = (chunk: string, bytes = 0): void => {
    if (chunk.length === 0) return
    text += chunk
    if (bytes > 0) tee?.emitted?.(channel, bytes)
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
      // 原文照抄给「接出去的那一头」（转后台之后续写文件）；读到的每一块都算
      tee?.current?.(value)
      tee?.total?.(channel, value)

      // 上限**按字节**记（`maxOutputBytes` 是字节）——超出部分不留，但**照读不辍**：
      // 停手会让管道写满，命令卡在写不动上，那就不是「截断」而是「挂死」了。
      seen += value.length

      let rest = value
      if (headDone < headCap) {
        const room = headCap - headDone
        const part = value.length <= room ? value : value.subarray(0, room)
        headDone += part.length
        if (part.length > 0) emit(decoder.decode(part, { stream: true }), part.length)
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
    if (afterHead.length > 0) emit(decoder.decode(afterHead, { stream: true }), afterHead.length)
    emit(decoder.decode())

    return { text, truncated: false, incomplete }
  }

  emit(`${text.endsWith('\n') ? '' : '\n'}${truncationNote(seen - cap, seen, headCap, tailCap)}\n`)
  emit(decodeFromCharStart(afterHead), afterHead.length)

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
  const shell = resolveShell(options.shell)
  try {
    const script = options.cwdFile === undefined || !shell.hook ? cmd : withCwdReport(cmd, options.cwdFile, options.oldCwd)
    started = await spawnOwned([shell.path, '-c', script], {
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
  // 转后台时要用「交出之前已经读到的正文」——从同一个出口另攒一份
  const seen = { stdout: '', stderr: '' }
  // **吐给回执的字节数**（不是字符数）——移交时据它判断「回执里那段是不是只带了一截」
  const emitted = { stdout: 0, stderr: 0 }
  const sink = (delta: OutputDelta): void => {
    seen[delta.channel] += delta.text
    options.onOutput?.(delta)
  }
  // 移交时写进后台文件的**原始字节**（不是回执里那份掐过头的正文）：drain 先吐头部那一半，
  // 尾巴要等流结束才补，而移交恰好发生在流还在跑的时候——光拿 `seen` 会把「头之后」整段丢掉
  // （评审实测：100 KB 输出只剩 32 KB，中间 67 KB 无声蒸发）。上限有界，防一条话多的命令吃内存。
  //
  // 只在这条命令**可能走到移交**时才挂这一层：前台 exec 全程白攒一份没人读的副本很亏。
  const handover: Handover = { chunks: [], size: 0, dropped: 0, totals: { stdout: 0, stderr: 0 } }
  const handedOver = { value: false }
  const tee: DrainTee | undefined = options.onTimeout === 'background' && options.adopt !== undefined
    ? {
        emitted: (channel, bytes) => { emitted[channel] += bytes },
        total: (channel, chunk) => {
          handover.totals[channel] += chunk.length
          // 移交之后没人再读这份缓冲（文件由 `current` 接着写）：别白拷
          if (handedOver.value) return
          // 超了上限就**从头砍**（留最近的一段：卡住之前那几行正是要看的那几行），
          // 砍掉多少记在 `dropped` 上，prefix 里如实说一句
          while (handover.size + chunk.length > HANDOVER_BUFFER_BYTES && handover.chunks.length > 0) {
            const oldest = handover.chunks.shift()
            if (oldest === undefined) break
            handover.size -= oldest.length
            handover.dropped += oldest.length
          }
          if (chunk.length > HANDOVER_BUFFER_BYTES) { handover.dropped += chunk.length; return }
          handover.chunks.push(chunk.slice()) // 读缓冲会被复用，必须留自己的一份
          handover.size += chunk.length
        },
      }
    : undefined
  const drained = Promise.all([
    drain(proc.stdout, 'stdout', sink, options.maxOutputBytes, readers.signal, failed, tee),
    drain(proc.stderr, 'stderr', sink, options.maxOutputBytes, readers.signal, failed, tee),
  ])
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = options.timeoutMs
  const deadline = bound === null ? NEVER : new Promise<{ kind: 'timeout' }>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, bound - (Date.now() - began)))
  })
  const completed = started.commandExited.then(async exit => exit === null
    ? { kind: 'cleanup' as const, error: new Error('命令退出码控制通道提前关闭') }
    : { kind: 'finished' as const, exit, output: await drained })
  // 移交没成（抛了 / 拒了）时的原委——落回「按进程组收掉」那一路要把它说出来：
  // 「本来要转后台、没交出去，为什么」不能丢，否则读的人以为这条命令压根没这待遇。
  let handoverFailure: string | undefined
  try {
    const outcome = await Promise.race([completed, deadline, canceled.promise, readFailure.promise])
    if (outcome.kind === 'finished' && outcome.exit !== null) {
      const [stdout, stderr] = outcome.output
      const reported = readReportedCwd(options.cwdFile)
      return { ok: true, exit: outcome.exit, stdout: stdout.text, stderr: stderr.text,
        ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
        ...(reported === undefined ? {} : { cwd: reported }) }
    }

    // **到点没跑完 ≠ 该被删掉**：交出去接着跑，这一轮只把「它还在跑」说清楚。
    // 交不出去（没接后台 / 开不了文件）就退回老路——按进程组收掉，绝不静默改语义。
    if (outcome.kind === 'timeout' && options.onTimeout === 'background' && options.adopt !== undefined) {
      // 交出去这一下自己也可能失败（开不出文件一类）。抛出来也算「交不出去」：
      // 落回下面按进程组收掉，绝不把一条没人认领的进程留在机器上（它还跑着，却没有 id、
      // 不在 running()、stop 够不着）。
      let adopted: AdoptedRun | { ok: false }
      try {
        adopted = await options.adopt({
          command: cmd,
          cwd: options.cwd,
          proc,
          startedAt: started.startedAt ?? began,
          prefix: handoverPrefix(handover),
          outputSettled: drained.then(() => {}),
        })
      } catch (error) {
        // 抛出来（同步抛也算）＝交不出去：落回下面按进程组收掉，绝不留一条没人认领的进程
        adopted = { ok: false }
        handoverFailure = error instanceof Error ? error.message : String(error)
      }
      if (!adopted.ok && handoverFailure === undefined) handoverFailure = 'reason' in adopted ? adopted.reason : '接管方拒绝了'
      if (adopted.ok) {
        // 从这里起，两条流读到的原文一路写进那个输出文件（同时照旧吐增量给屏）
        handedOver.value = true
        if (tee !== undefined) tee.current = adopted.write
        // 回执里那份只有头部：明说后面不在这一份里，别让它读成「就这么点输出」。
        // ⚠️ 比的是**字节对字节**（`totals` 是原始字节、`emitted` 是吐出去的字节）：
        // 拿字节去比 `seen.stdout.length`（UTF-16 码元数）会把中文输出一律判成「缺了一段」。
        const cutOut = handover.totals.stdout > emitted.stdout
        const cutErr = handover.totals.stderr > emitted.stderr
        return {
          ok: false,
          reason: 'timeout',
          timeoutMs: bound!,
          message: `命令超过 ${bound}ms 未结束，已转后台（${adopted.id}）`,
          stdout: appendCut(seen.stdout, cutOut),
          stderr: appendCut(seen.stderr, cutErr),
          ...(cutOut || cutErr ? { truncated: true as const } : {}),
          background: { id: adopted.id, outputPath: adopted.outputPath },
        }
      }
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
    const handoverNote = handoverFailure === undefined ? '' : `（本可转后台，但没交出去：${handoverFailure}）`
    if (outcome.kind === 'timeout') return { ok: false, reason: 'timeout', timeoutMs: bound!, message: `命令超时（${bound}ms）；${ending}${handoverNote}`, ...output }
    if (outcome.kind === 'canceled') return { ok: false, reason: 'canceled', message: `命令已取消；${ending}`, ...output }
    return { ok: false, reason: 'cleanup', message: `命令输出或控制通道异常${outcome.kind === 'cleanup' ? `：${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}` : ''}；${ending}`, ...output }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    // 钩子写下的那个文件读没读都清掉（移交后台时它可能还会被钩子重建一次，无妨）
    if (options.cwdFile !== undefined) {
      try { rmSync(options.cwdFile, { force: true }) } catch { /* 清不掉不影响这一条的结果 */ }
    }
  }
}

/** 移交前那份原文的缓冲上限——有界，防一条话多的命令把内存吃掉。 */
const HANDOVER_BUFFER_BYTES = 512 * 1024

type Handover = {
  chunks: Uint8Array[]
  size: number
  /** 从头砍掉、没进缓冲的字节数（超上限时越砍越多）——prefix 里如实交代。 */
  dropped: number
  totals: { stdout: number; stderr: number }
}

/**
 * 交给后台的那一段正文。
 *
 * 用**原始字节**而不是回执里那份 `seen`：`seen` 只含头部一半（尾巴要等流结束才吐），
 * 而移交发生在流还在跑的时候，拿它会把「头之后」整段丢掉。超出缓冲上限时如实写一句
 * 「中间省略了多少」，不留一段没有交代的空白。
 */
function handoverPrefix(handover: Handover): string {
  const joined = new Uint8Array(handover.size)
  let at = 0
  for (const chunk of handover.chunks) { joined.set(chunk, at); at += chunk.length }
  // 从头砍时第一块很可能停在半个多字节字符上：跳过续字节，别在文件开头留个替换符
  let from = 0
  while (from < joined.length && (joined[from]! & 0xC0) === 0x80) from += 1
  const text = new TextDecoder().decode(joined.subarray(from))
  if (handover.dropped === 0) return text
  return `…（交到后台之前已产出 ${handover.totals.stdout + handover.totals.stderr} 字节，开头 ${handover.dropped} 字节已省略，这里接着 ${handover.size} 字节之后）\n${text}`
}

/** 回执里那一段只有头部时，明说一句：后面不在这一份里。 */
function appendCut(text: string, cut: boolean): string {
  if (!cut) return text
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}…（交出去之前的输出只带回这一段，此后的写进后台的输出文件）\n`
}
