/**
 * 启动基准 · **外面那一档**（U21 · 测量装置）——「进程起 → 看得见东西」。
 *
 * ## 为什么要从外面量
 *
 * `bench-boot.ts` 量的是**进程内**的三段（模块加载 / 装配 / 首帧）。而用户按下回车
 * 之后等的那一下，还多着**操作系统的进程启动**与 **Bun 自己的起手**——那两段只有在
 * 进程外面才量得到。两档合起来才是「启动到首帧」的全貌。
 *
 * ## 怎么拿到一个真 pty
 *
 * 外壳只在**终端**里起（`runTui` 见 `stdin.isTTY !== true` 就报错退场），故必须给个子终端。
 * 用 macOS 自带的 `script -q /dev/null <cmd>` 分一个 pty（不引依赖）。
 *
 * ⚠️ **`script` 自己也有起手**（约几毫秒，算在这一档里）——**如实记**，别当它不存在。
 *
 * ## 两读数
 *
 * - **首字节**——外壳在 stdout 上吐出的头一个字节（`\u001b[>1u`，kitty 键盘协议那一下）；
 * - **首帧**——**剥掉 ANSI 之后头一次出现可见字符**（那才是「屏上有东西了」）。
 *
 * ⚠️ **这条探针只认外壳**：判据是「这一块带不带 ESC」——`script` 自己的杂音一个 ESC 都没有，
 * 那正是要滤掉的。别的命令（如量 Bun 自启用 `time bun -e ''`）拿它量不到东西，会当场报一句。
 *
 * ⚠️ 取到首帧**当场杀掉**：外壳起完就在等你敲键盘，不会自己退（第一版没杀，
 * 挂在「等 stdout 关闭」上，五分钟超时）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/bench-pty.ts --rounds 7 -- <cmd> [args…]
 *
 * # 例子（家目录换成一个写着 config.json 的临时家）
 * bun packages/app/test/bench-pty.ts --rounds 7 -- bun packages/app/src/cli.ts
 * ```
 */

/**
 * 剥 ANSI（**照 `@magic/tui` 的 `screen.ts` 的写法**：CSI 与 OSC 两族都用 `\u001b` 转义写，
 * 不往源码里塞裸的 ESC 字节——那样读不出、diff 不了，编辑器还会当成乱码）。
 */
function plain(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // ⚠️ **参数位要含 `>` `=` `!` `:`**——头一版写成 `[0-9;?]*`，于是 `\u001b[>1u`
    // （kitty 键盘协议那一下，**外壳的第一个字节就是它**）没被剥掉，`[>1u` 那截
    // 四个字符被当成了「可见字符」⇒「首帧」当场退化成「首字节」（实测两行数相等，
    // 就是这么来的）。CSI 的参数位是 `0-9:;<=>?`，末字节落在 `@-~`。
    .replace(/\u001b\[[0-9:;<=>?]*[@-~]/g, '')
}

/**
 * 这一块是不是**外壳自己**吐的（不是 `script` 的杂音）。
 *
 * ⚠️ **踩过两回**：macOS 的 `script` 分完 pty 之后先吐四个字节（`^D` ＋ 两个退格），
 * 而它 **5ms** 就到了——照单全收会把「首字节」量成 5.0ms，比模块加载（200ms 量级）
 * 还快，一眼假。头一版筛子是「去掉控制字符后还剩不剩东西」，**没咬住**：
 * 那四字节里的 `^D` 是**两个普通字符**（不是 `\u0004`），退格也只有两个。
 *
 * 判据换成：**这一块里有没有 ESC**。外壳的第一次输出一定带它（`\u001b[>1u`——
 * `runTui` 推 kitty 键盘协议那一下），而 `script` 自己的杂音一个 ESC 都没有。
 */
function isAppOutput(chunk: string): boolean {
  return chunk.includes('\u001b')
}

export type PtyMeasure = {
  /** 进程（连同 `script`）起手 → stdout 上头一个字节。 */
  readonly firstByteMs: number
  /** → 剥掉 ANSI 后头一次出现可见字符。 */
  readonly firstFrameMs: number
}

/** 跑一轮：起子终端、量到首帧、杀掉。 */
export async function ptyOnce(command: readonly string[]): Promise<PtyMeasure> {
  const started = Bun.nanoseconds()
  const child = Bun.spawn(['script', '-q', '/dev/null', ...command], {
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    // 不是终端就起不来（`runTui` 的前置）——故必须挂一个子终端
  })

  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()

  let firstByteMs = Number.NaN
  let firstFrameMs = Number.NaN
  let seen = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.length === 0) continue

      const chunk = decoder.decode(value, { stream: true })
      if (!isAppOutput(chunk)) continue // `script` 的杂音不算（见 `isAppOutput`）

      if (Number.isNaN(firstByteMs)) firstByteMs = (Bun.nanoseconds() - started) / 1e6
      seen += chunk
      if (Number.isNaN(firstFrameMs) && plain(seen).trim() !== '') {
        firstFrameMs = (Bun.nanoseconds() - started) / 1e6
        break // **首帧到手即走**——外壳不会自己退（见文件头注）
      }
    }
  } finally {
    await reap(child)
  }

  return { firstByteMs, firstFrameMs }
}

/**
 * 收场：**连 `script` 下面那个被测进程一起**（D26 · 工单第 4 条）。
 *
 * 由头：`child.kill()` 杀的是 `script` 这一个进程——**被测的 CLI 是它的孩子**，
 * 只杀外壳就把它留在了机器上（旧那批残留里正有这种形状：父进程没了、自己 `PPID=1`、
 * 抱着一个 PTY slave 空转）。这里按「先记名下、再有界升级」办：
 *
 * 1. 杀之前先记下 `script` 名下的**整棵树**（`pgrep -P` 逐层）——这一轮起的命令就在里头；
 * 2. 杀 `script`（pty master 随之关闭 ⇒ 被测进程收到断流 ⇒ 产品那条路让它自己走）；
 * 3. 到点还没走的，**只对记下来的 PID** TERM → 等 → KILL → 等，**不扫全机**。
 */
async function reap(child: Bun.Subprocess): Promise<void> {
  // 先记名下——**读不到就抛**（见 `childrenOf` 的注：那种情况下「没有孩子」不成立）；
  // 但外壳无论如何都要杀，不然连它都没了结，所以错误先收着，杀完再抛
  let under: readonly number[] = []
  let readError: unknown
  try {
    under = await descendantsOf(child.pid)
  } catch (error) {
    readError = error
  }

  child.kill()
  await child.exited.catch(() => {})

  for (const pid of under) {
    if (await gone(pid, 1_000)) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      continue // 这一跳里走了
    }
    if (await gone(pid, 1_000)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      continue
    }
    await gone(pid, 1_000)
  }

  if (readError !== undefined) throw readError
}

/**
 * 这个进程名下的**整棵树**（自己 → 孩子 → 孙……）——`script` 分完 pty 之后，
 * 被测命令就在这棵树里（中间隔一层 shell 也跑不掉）。
 *
 * ⚠️ **别用 `ps -P`**：本机（macOS 26.6.2）的 `ps` 不认 `-P`
 * （`ps: illegal option -- P`，退出码 1）。本文件第一版正是那么写的，
 * 又把退出码扔了——名册恒为空，收场退化成「只杀 script 就算完」，
 * 正是 D26 要修的那种假回收。`pgrep -P` 在本机可用（实测）。
 */
async function descendantsOf(parent: number): Promise<readonly number[]> {
  const found: number[] = []
  const frontier: number[] = [parent]

  while (frontier.length > 0) {
    const current = frontier.pop() as number
    for (const pid of await childrenOf(current)) {
      found.push(pid)
      frontier.push(pid)
    }
  }

  return found
}

/**
 * 一个进程当下的孩子（`pgrep -P`）。
 *
 * `pgrep` 的退出码分三档：**0 ＝ 有匹配 · 1 ＝ 没有匹配（正常）· 其余 ＝ 真出错**。
 * 出错**必须抛**——读不出进程表时，「没有孩子」这个结论不成立，
 * 静默返回空数组就等于把「没回收」记成「已回收」。
 */
async function childrenOf(parent: number): Promise<readonly number[]> {
  const pgrep = Bun.spawn(['pgrep', '-P', String(parent)], { stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(pgrep.stdout).text()
  const complaint = await new Response(pgrep.stderr).text()
  const code = await pgrep.exited

  if (code === 1) return [] // 一个孩子都没有——正常
  if (code !== 0) {
    throw new Error(`读不出进程的孩子（pgrep -P ${parent} 退出 ${code}）：${complaint.trim()}`)
  }

  return text
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/** 还在不在——`kill(pid, 0)` 只做存在性检查，不发信号。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等它走（有界）——返回「走了没有」。 */
async function gone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20)

  return !alive(pid)
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

if (import.meta.main) {
  const at = process.argv.indexOf('--rounds')
  const rounds = at === -1 ? 7 : Number(process.argv[at + 1] ?? 7)
  const rest = process.argv.slice(2)
  const dash = rest.indexOf('--')
  const command = rest.slice(dash + 1)

  if (command.length === 0) {
    await Bun.write(Bun.stdout, '用法：bun bench-pty.ts --rounds 7 -- <cmd> [args…]\n')
    process.exit(1)
  }

  // 头一轮丢掉——冷启动的文件缓存全落在它头上
  await ptyOnce(command)

  const runs: PtyMeasure[] = []
  for (let index = 0; index < rounds; index += 1) runs.push(await ptyOnce(command))

  const ok = runs.filter((run) => !Number.isNaN(run.firstFrameMs))
  if (ok.length === 0) {
    await Bun.write(Bun.stdout, '一轮都没量到首帧——目标不是外壳（这条探针认 ESC，见 isAppOutput）\n')
    process.exit(1)
  }
  await Bun.write(
    Bun.stdout,
    [
      '',
      `进程起 → 首帧（${ok.length}/${runs.length} 轮取中位 · 经 \`script\` 分 pty）`,
      `  ${command.join(' ')}`,
      `  首字节    ${median(ok.map((run) => run.firstByteMs)).toFixed(1)}ms`,
      `  首帧      ${median(ok.map((run) => run.firstFrameMs)).toFixed(1)}ms`,
      '',
    ].join('\n'),
  )

  process.exit(0)
}
