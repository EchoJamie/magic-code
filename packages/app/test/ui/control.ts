/**
 * 界面验收 · 控制通道（U40）——**助手那条入口**：逐行 JSON 请求 / 逐行 JSON 答复。
 *
 * ## 是什么、不是什么
 *
 * 是：一个**保持运行的命令行进程**（`scripts/ui.ts serve`），从**它自己的标准输入**读一行
 * JSON 命令，往标准输出写一行 JSON 答复。命令带 `id`，答复带着**同一个** `id` 回来——
 * 助手同时开几个实例比对时，靠它认哪句答的是哪句。
 *
 * 不是：系统 daemon、socket 服务、跨设备控制，**也不是别的水道**。首轮验收退回之后实测：
 * 助手那条 `exec_command`（`tty:true`）起一个会话、往里 `write_stdin` 逐行写 JSON，
 * 跨多次调用保持同一个 PID——**stdin 本身就是那根常开的水道**，FIFO、序号文件、答复轮询
 * 那一套全是多余的机制，已删。
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
 * ## stdin 的条件（**实测**，别想当然）
 *
 * - **`tty:false` 起的进程，stdin 当场就是关的**（接到 `/dev/null`）——「EOF 即收摊」立刻
 *    成立，这个入口当不了持续入口。要么 `tty:true` 直接用 TTY 行输入（实测可用：终端按
 *    行交给进程，它自己那份回显也在输出里——解析时只认 JSON 行），要么拿 `cat |` 包一层：
 *
 *    `cat | bun packages/app/scripts/ui.ts serve --out <产物根>`
 *
 *    `cat` 活着，管道那头就不 EOF，写进去的每一行照常到达。
 * - 会话活在这个进程活着的时候；进程一走，现场（产物目录）还在，接着用新的进程看。
 */

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
 * 平常只开一个时省掉这行字。⚠️ 写了号，答复里回的就是**那一个号**（连同它的 pid）——
 * 「这回的是谁」只能有一个答案，首轮验收实测它曾经回成当前那个。
 */
export function createControl(options: ControlOptions = {}): Control {
  const log = options.log ?? (() => {})
  const sessions = new Map<string, UiSession>()
  let counter = 0
  let current: string | undefined

  /** 这条请求冲谁去——**解析出来的那一个**（号与实例一起交回，免得两处各解析一次）。 */
  const resolve = (request: ControlRequest): { name: string; session: UiSession } | undefined => {
    const name = request.session ?? current
    if (name === undefined) return undefined
    const session = sessions.get(name)

    return session === undefined ? undefined : { name, session }
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
            // 起不来就**在这一跳里收拾干净**（`createUiSession` 自己清）——不登记一个半成品
            const session = await createUiSession(startOptions)
            sessions.set(sessionId, session)
            current = sessionId
            log(`起会话 ${sessionId}（pid ${session.pid}）· ${session.runDir}`)

            return done(id, { session: sessionId, ...session.facts(), ...(await stateOf(session)) })
          }

          case 'send': {
            const target = resolve(request)
            if (target === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            if (typeof request.text !== 'string') return fail(id, 'bad-request', 'send 要给 text')
            await target.session.send(request.text)

            return done(id, { session: target.name, sent: request.text, ...(await stateOf(target.session)) })
          }

          case 'key': {
            const target = resolve(request)
            if (target === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            if (typeof request.key !== 'string') return fail(id, 'bad-request', 'key 要给键名')
            if (!(UI_KEYS as readonly string[]).includes(request.key)) {
              // 未支持的键**明确报错**，不悄悄换成另一种按键（工单的话）
              return fail(id, 'bad-request', `不认得的键「${request.key}」——有的是：${UI_KEYS.join(' / ')}`)
            }
            await target.session.key(request.key as UiKey)

            return done(id, { session: target.name, key: request.key, ...(await stateOf(target.session)) })
          }

          case 'resize': {
            const target = resolve(request)
            if (target === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            if (typeof request.columns !== 'number' || typeof request.rows !== 'number') {
              return fail(id, 'bad-request', 'resize 要给 columns 与 rows（数字）')
            }
            await target.session.resize(request.columns, request.rows)

            return done(id, { session: target.name, ...(await stateOf(target.session)) })
          }

          case 'wait': {
            const target = resolve(request)
            if (target === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            if (request.condition === undefined) return fail(id, 'bad-request', 'wait 要给 condition')

            try {
              const result = await target.session.wait(request.condition, {
                ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
              })

              return done(id, {
                session: target.name,
                matched: result.matched,
                elapsedMs: Math.round(result.elapsedMs),
                ...(await stateOf(target.session)),
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
            const target = resolve(request)
            if (target === undefined) return fail(id, 'no-session', '还没起实例——先发一条 {"cmd":"start"}')
            const shot = await target.session.capture({
              ...(request.label === undefined ? {} : { label: request.label }),
            })
            const facts = target.session.facts()

            return done(id, {
              session: target.name,
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
            const target = resolve(request)
            if (target === undefined) return fail(id, 'no-session', '没有可关的实例')
            const report = await target.session.close()
            sessions.delete(target.name)
            if (current === target.name) current = [...sessions.keys()].at(-1)
            log(`关会话 ${target.name}（退出缘由 ${report.exit.by}）· 现场 ${report.runDir}`)

            return done(id, { session: target.name, ...summarize(report) })
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
