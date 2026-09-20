/**
 * 界面验收 · 控制通道（U40）——**助手那条入口**：逐行 JSON 请求 / 逐行 JSON 答复。
 *
 * ## 是什么、不是什么
 *
 * 是：一个**保持运行的命令行进程**，从标准输入（或它自己的那个 FIFO）读一行 JSON 命令，
 * 往标准输出（以及 `<控制目录>/out.ndjson`）写一行 JSON 答复。命令带 `id`，答复带着**同一个**
 * `id` 回来——助手同时开几个实例比对时，靠它认哪句答的是哪句。
 *
 * 不是：系统 daemon、socket 服务、跨设备控制。会话活在这个进程活着的时候；进程一走，
 * 现场（产物目录）还在，接着用新的进程看。
 *
 * ## 五条线画清楚
 *
 * 1. **应用自己的字节绝不混进控制协议**——它们进 PTY、进 VT、进现场目录；
 *    控制通道上只有我们的 JSON（诊断走 stderr）；
 * 2. **命令一条一条来**——正在等的那条没答复之前，后面的排队（答复次序即请求次序）；
 * 3. **`capture` 只观察**——不发送、不重启、不清屏，应用一直在跑；
 * 4. **单条失败不掀桌子**：等超时＝`{ok:false, error:{kind:'timeout', …}}` ＋ **现场留着**，
 *    助手检查完可以接着下一条命令（会话不退场）；
 * 5. **EOF / `close` / 进程退出都要清场**——自己起的应用与端点一个不留。
 *
 * ## 为什么 FIFO 也是「标准输入」
 *
 * 助手的工具调用之间**没有一根常开的 stdin**（每次调用都是一条新命令）。故常驻进程用
 * `<控制目录>/in.fifo` **当自己的 stdin**：它把 FIFO 以读写打开（写端全关也不 EOF），
 * 于是「另一个进程往里写一行」与「往 stdin 写一行」是一回事。`request` 子命令是那条
 * 薄客户端——写一行，等回音，打印，退出。
 */

import { appendFileSync, closeSync, constants, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession, UiWaitTimeout, UI_KEYS } from './driver.ts'
import type { CloseReport, UiKey, UiSession, UiSessionOptions, WaitCondition } from './driver.ts'
import type { FixtureTurn } from './fixture.ts'

/** 一条命令的形态——`cmd` 是闭集，其余字段随命令。 */
export type ControlRequest = {
  readonly id: number | string
  readonly cmd: string
  readonly session?: string
  readonly text?: string
  readonly key?: string
  readonly columns?: number
  readonly rows?: number
  readonly condition?: WaitCondition
  readonly timeoutMs?: number
  readonly label?: string
  /** `start` 用：模型剧本 / 尺寸 / 产物根 / 额外的 CLI 参数。 */
  readonly turns?: readonly FixtureTurn[]
  readonly cols?: number
  readonly artifacts?: string
  readonly argv?: readonly string[]
  readonly checkout?: string
}

/** 一条答复——`ok` 为假时 `error.kind` 说清是哪一类（助手据此决定下一步）。 */
export type ControlReply =
  | { readonly id: number | string; readonly ok: true; readonly [key: string]: unknown }
  | {
      readonly id: number | string
      readonly ok: false
      readonly error: {
        readonly kind: 'timeout' | 'bad-request' | 'no-session' | 'failed'
        readonly message: string
        readonly [key: string]: unknown
      }
    }

export type ControlOptions = {
  /** 产物根——`start` 没另给的话用它。 */
  readonly artifacts?: string
  readonly checkout?: string
  /** 诊断（不上控制通道，走 stderr）。 */
  readonly log?: (line: string) => void
  /** 记录一条**控制侧**的动静（起没起、关没关）——给外面写进 `serve.ndjson`。 */
  readonly onEvent?: (event: { readonly at: string; readonly event: string; readonly detail?: unknown }) => void
}

export type Control = {
  /** 处理一行 JSON，交回一行 JSON（**永不抛**——错误也走 `{ok:false}`）。 */
  handle(line: string): Promise<string>
  /** 还开着的会话（`s1` 这种号 → 它的底细）。 */
  sessions(): readonly { readonly session: string; readonly pid: number; readonly runDir: string }[]
  /** 全部收摊（EOF / 进程退出时调）。 */
  closeAll(): Promise<void>
}

/**
 * 起一个控制面——会话按 `s1` / `s2` 编号，`session` 不写就用**当前那一个**。
 *
 * 「当前那一个」＝最后 `start` 的、还没 `close` 的那个：助手开两个实例比对时**显式写号**，
 * 平常只开一个时省掉这行字。
 */
export function createControl(options: ControlOptions = {}): Control {
  const log = options.log ?? (() => {})
  const sessions = new Map<string, UiSession>()
  let counter = 0
  let current: string | undefined

  const resolve = (request: ControlRequest): UiSession | undefined => {
    const name = request.session ?? current

    return name === undefined ? undefined : sessions.get(name)
  }

  const fail = (
    id: ControlRequest['id'],
    kind: 'bad-request' | 'no-session' | 'failed' | 'timeout',
    message: string,
    extra = {},
  ): string =>
    JSON.stringify({ id, ok: false, error: { kind, message, ...extra } })

  const done = (id: ControlRequest['id'], payload: Record<string, unknown>): string =>
    JSON.stringify({ id, ok: true, ...payload })

  /**
   * 每条与会话有关的答复都带上的那几格——**`pid` 与尺寸**。
   *
   * 为什么每条都带：助手是**跨多次调用**在操作同一现场，它每次都得能一眼确认
   * 「还是那一个进程、窗口现在是多大」——不然还得额外发一条 `sessions` 去问。
   */
  const stateOf = async (
    session: UiSession,
  ): Promise<{ pid: number; columns: number; rows: number; screen: readonly string[]; cursor: unknown; scrollback: number }> => {
    const shot = await session.screen()

    return {
      pid: session.pid,
      columns: shot.columns,
      rows: shot.rows,
      screen: shot.lines.map((line) => line.text),
      cursor: shot.cursor,
      scrollback: shot.scrollback,
    }
  }

  return {
    async handle(line) {
      const trimmed = line.trim()
      if (trimmed === '') return JSON.stringify({ id: 0, ok: false, error: { kind: 'bad-request', message: '空行' } })

      let request: ControlRequest
      try {
        request = JSON.parse(trimmed) as ControlRequest
      } catch (error) {
        return JSON.stringify({
          id: 0,
          ok: false,
          error: { kind: 'bad-request', message: `不是合法 JSON：${String(error)}` },
        })
      }

      const id = request.id ?? 0
      if (typeof request.cmd !== 'string') return fail(id, 'bad-request', '缺 cmd')

      try {
        switch (request.cmd) {
          case 'start': {
            counter += 1
            const sessionId = `s${counter}`
            const startOptions: UiSessionOptions = {
              label: request.label ?? `控制-${sessionId}`,
              ...(request.cols === undefined ? {} : { columns: request.cols }),
              ...(request.rows === undefined ? {} : { rows: request.rows }),
              ...(request.turns === undefined ? {} : { turns: request.turns }),
              ...(request.argv === undefined ? {} : { argv: request.argv }),
              ...(request.artifacts === undefined && options.artifacts === undefined
                ? {}
                : { artifacts: request.artifacts ?? options.artifacts }),
              ...(request.checkout === undefined && options.checkout === undefined
                ? {}
                : { checkout: request.checkout ?? options.checkout }),
            }
            const session = await createUiSession(startOptions)
            sessions.set(sessionId, session)
            current = sessionId
            options.onEvent?.({ at: new Date().toISOString(), event: 'start', detail: { session: sessionId, pid: session.pid } })
            log(`起会话 ${sessionId}（pid ${session.pid}）· ${session.runDir}`)

            return done(id, { session: sessionId, ...session.facts(), ...(await stateOf(session)) })
          }

          case 'send': {
            const session = resolve(request)
            if (session === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            if (typeof request.text !== 'string') return fail(id, 'bad-request', 'send 要给 text')
            await session.send(request.text)

            return done(id, { session: current, sent: request.text, ...(await stateOf(session)) })
          }

          case 'key': {
            const session = resolve(request)
            if (session === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            if (typeof request.key !== 'string') return fail(id, 'bad-request', 'key 要给键名')
            if (!(UI_KEYS as readonly string[]).includes(request.key)) {
              // 未支持的键**明确报错**，不悄悄换成另一种按键（工单的话）
              return fail(id, 'bad-request', `不认得的键「${request.key}」——有的是：${UI_KEYS.join(' / ')}`)
            }
            await session.key(request.key as UiKey)

            return done(id, { session: current, key: request.key, ...(await stateOf(session)) })
          }

          case 'resize': {
            const session = resolve(request)
            if (session === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            if (typeof request.columns !== 'number' || typeof request.rows !== 'number') {
              return fail(id, 'bad-request', 'resize 要给 columns 与 rows（数字）')
            }
            await session.resize(request.columns, request.rows)

            return done(id, { session: current, ...(await stateOf(session)) })
          }

          case 'wait': {
            const session = resolve(request)
            if (session === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            if (request.condition === undefined) return fail(id, 'bad-request', 'wait 要给 condition')

            try {
              const result = await session.wait(request.condition, {
                ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
              })

              return done(id, {
                session: current,
                matched: result.matched,
                elapsedMs: Math.round(result.elapsedMs),
                ...(await stateOf(session)),
              })
            } catch (error) {
              if (error instanceof UiWaitTimeout) {
                // **结构化失败**：会话不退场，现场留着——助手检查完接着下一条
                const awaited = JSON.stringify(error.condition)
                return fail(id, 'timeout', `等「${awaited}」超时`, {
                  condition: error.condition,
                  elapsedMs: Math.round(error.elapsedMs),
                  timeoutMs: error.timeoutMs,
                  screen: error.screen,
                  runDir: error.runDir,
                  frameStep: error.frameStep,
                })
              }
              throw error
            }
          }

          case 'capture': {
            const session = resolve(request)
            if (session === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            const shot = await session.capture({ ...(request.label === undefined ? {} : { label: request.label }) })
            const facts = session.facts()

            return done(id, {
              session: current,
              pid: facts.pid,
              frame: {
                n: shot.n,
                step: shot.step,
                label: shot.label,
                columns: shot.columns,
                rows: shot.rows,
                cursor: shot.cursor,
                scrollback: shot.scrollback,
                lines: shot.lines,
                files: shot.files,
              },
              runDir: facts.runDir,
            })
          }

          case 'close': {
            const name = request.session ?? current
            const session = name === undefined ? undefined : sessions.get(name)
            if (session === undefined) return fail(id, 'no-session', '没有可关的实例')
            const report = await session.close()
            sessions.delete(name as string)
            if (current === name) current = [...sessions.keys()].at(-1)
            options.onEvent?.({ at: new Date().toISOString(), event: 'close', detail: { session: name, by: report.exit.by } })
            log(`关会话 ${name as string}（退出缘由 ${report.exit.by}）· 现场 ${report.runDir}`)

            return done(id, { session: name, ...summarize(report) })
          }

          case 'sessions': {
            return done(id, {
              sessions: [...sessions.entries()].map(([name, session]) => ({
                session: name,
                current: name === current,
                ...session.facts(),
              })),
            })
          }

          default:
            return fail(id, 'bad-request', `不认得的 cmd「${request.cmd}」——有的是：start / send / key / resize / wait / capture / close / sessions`)
        }
      } catch (error) {
        // 兜底：**绝不把控制进程带下去**（一条命令炸了不该掀掉整张桌子）
        log(`内部错：${String(error)}`)
        return fail(id, 'failed', error instanceof Error ? error.message : String(error))
      }
    },

    sessions: () =>
      [...sessions.entries()].map(([name, session]) => {
        const facts = session.facts()

        return { session: name, pid: facts.pid, runDir: facts.runDir }
      }),

    closeAll: async () => {
      for (const [name, session] of [...sessions.entries()].reverse()) {
        try {
          await session.close()
          options.onEvent?.({ at: new Date().toISOString(), event: 'close', detail: { session: name, by: 'eof' } })
          log(`收摊 ${name}（控制通道收尾）`)
        } catch (error) {
          log(`收摊 ${name} 出错：${String(error)}`)
        }
      }
      sessions.clear()
      current = undefined
    },
  }
}

/** `close` 的答复——把 `CloseReport` 摊平成 JSON 友好的形状。 */
function summarize(report: CloseReport): Record<string, unknown> {
  return {
    runDir: report.runDir,
    viewer: report.viewer,
    exit: report.exit,
    rawBytes: report.rawBytes,
    truncated: report.truncated,
    frames: report.frames,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 控制目录：FIFO ＋ 答复文件（助手那条路）
// ═══════════════════════════════════════════════════════════════════════

export type ControlDir = {
  readonly dir: string
  readonly fifo: string
  readonly out: string
  readonly seq: string
}

/**
 * 备好一个控制目录——`in.fifo` 就是常驻进程的 stdin（见文件头注）。
 *
 * `mkfifo` 用系统那份（`Bun.spawnSync`）：Bun 没有现成的建 FIFO API，
 * 而这是一条 POSIX 早就定死的东西，不值得为它引依赖。
 */
export function prepareControlDir(dir: string): ControlDir {
  mkdirSync(dir, { recursive: true })
  const fifo = join(dir, 'in.fifo')
  const out = join(dir, 'out.ndjson')
  const seq = join(dir, 'seq')

  if (!existsSync(fifo)) {
    const made = Bun.spawnSync(['mkfifo', fifo])
    if (made.exitCode !== 0) throw new Error(`建 FIFO 失败：${made.stderr.toString()}`)
  }
  writeFileSync(out, '', { flag: 'a' })
  if (!existsSync(seq)) writeFileSync(seq, '0', 'utf8')

  return { dir, fifo, out, seq }
}

/**
 * 以**读写**打开 FIFO 当命令流——写端全关也不 EOF（这是整条路成立的那一笔）。
 *
 * ⚠️ **必须是读写**：只读打开的话，每次 `request` 写完一关，那头就收到一次 EOF，
 * 于是「一条命令一收摊」。读写打开则断开与 EOF 无关，读的是**同一根水道**。
 * 字节按行切（一次 `request` 写一行，但读侧不假定它一次到齐）。
 */
export function openFifoStream(
  controlDir: ControlDir,
  onLine: (line: string) => void,
): { readonly fd: number; dispose: () => void } {
  const fd = openSync(controlDir.fifo, constants.O_RDWR)
  const stream = createReadStream('', { fd, encoding: 'utf8' })
  let buffered = ''

  stream.on('data', (chunk: string) => {
    buffered += chunk
    let at = buffered.indexOf('\n')
    while (at !== -1) {
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      if (line.trim() !== '') onLine(line)
      at = buffered.indexOf('\n')
    }
  })
  stream.on('error', () => {
    // FIFO 那头没了（控制目录被删）——静默退场，收摊归调用方
  })

  return {
    fd,
    dispose: () => {
      stream.destroy()
      closeSync(fd)
    },
  }
}

/** 追加一条答复到 `out.ndjson`（助手那条路靠它认领自己的答复）。 */
export function appendReply(controlDir: ControlDir, reply: string): void {
  appendFileSync(controlDir.out, `${reply}\n`, 'utf8')
}

/** 发一条命令（薄客户端 `request` 用）——分配 id、写进 FIFO、等答复。 */
export async function sendRequest(
  controlDir: ControlDir,
  command: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ readonly reply: ControlReply; readonly id: number }> {
  const id = nextId(controlDir)
  const line = `${JSON.stringify({ id, ...command })}\n`
  writeLine(controlDir.fifo, line)

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const reply = findReply(controlDir.out, id)
    if (reply !== undefined) return { reply, id }
    if (Date.now() > deadline) throw new Error(`等答复超时（${timeoutMs}ms）——id ${id} 没有回音：${controlDir.out}`)
    await Bun.sleep(20)
  }
}

/**
 * 往 FIFO 写一行。
 *
 * `O_NONBLOCK` ＋ `O_WRONLY`：**那头没人读时当场报错**（ENXIO），而不是**阻塞到天荒地老**
 * ——助手最怕的失败形态是「卡住」，不是「报错」。行很短，写不会撞上管道缓冲上限。
 */
function writeLine(fifo: string, line: string): void {
  let fd: number
  try {
    fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
  } catch (error) {
    throw new Error(`控制通道那头没人读（${fifo}）——先起 \`ui.ts serve --control <目录>\`：${String(error)}`)
  }

  try {
    writeSync(fd, line)
  } finally {
    closeSync(fd)
  }
}

/** 在下一条序号上取号（`seq` 文件——一条一条来，撞不了）。 */
function nextId(controlDir: ControlDir): number {
  const raw = Number.parseInt(readFileSync(controlDir.seq, 'utf8').trim(), 10)
  const next = Number.isNaN(raw) ? 1 : raw + 1
  writeFileSync(controlDir.seq, String(next), 'utf8')

  return next
}

/** 在答复文件里认领 `id` 那条（没有＝还没回来）。 */
function findReply(outPath: string, id: number): ControlReply | undefined {
  if (!existsSync(outPath)) return undefined

  for (const line of readFileSync(outPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as ControlReply
      if (parsed.id === id) return parsed
    } catch {
      // 半行（正在写）——下一轮再看
    }
  }

  return undefined
}

/** 控制目录里都有什么（`request`/排错时看一眼）。 */
export function listControlDir(dir: string): readonly string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : []
}
