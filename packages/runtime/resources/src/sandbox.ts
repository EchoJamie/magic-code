/**
 * 本机执行原语。工具入口先解析目标并完成唯一权限决断，再绑定本次目标执行。
 * bindTarget 保存目标事实与文件句柄；read/edit/write 使用已校验句柄，不重判根内外。
 * exec.ts 管进程，files.ts/match.ts 管实际 I/O；目标改变和 I/O 错误作为执行失败返回。
 * 目录枚举、文件创建和进程 cwd 的检查与 OS 调用尚非原子操作，不宣称 OS 沙箱保证。
 */

import { statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExecOptions,
  ExecResult,
  ListEntry,
  MatchHit,
  MatchOptions,
  ProcessLedger,
  ReadResult,
  ResolvedPath,
  Sandbox,
  WorkspaceService,
  WriteData,
} from '@magic/contracts'
import { DEFAULT_MAX_OUTPUT_BYTES, runCommand } from './exec.ts'
import { DEFAULT_MAX_READ_BYTES, listDir, openTarget, readOpened, readText, writeInto, writeOpened } from './files.ts'
import { matchIn } from './match.ts'
import { assertIdentity } from './workspace.ts'

/** 装配期构造入参（技术方案 · 领域划分 · 装配视图 2：执行域——工作区根注册）。 */
export type SandboxOptions = {
  readonly env?: Readonly<Record<string, string>>
  /** 执行命令的 shell——用户的 shell（`$SHELL`）；缺省 `sh`。前台与后台同一路。 */
  readonly shell?: string

  /** 工作区端口提供路径事实与默认根。 */
  readonly workspace: WorkspaceService
  /**
   * **归属账**（U50）——每一条命令起来的那一组记它一笔（见 `CommandOptions.ledger`）。
   *
   * 由装配造一本、**两处共用**（这里与 MCP 的 stdio 传输）：一个进程里「哪些进程是我们
   * 起的」只该有一本账；两处各造一本，收尾时就得两处都问，而漏问的那一处正是要防的事。
   */
  readonly ledger?: ProcessLedger | undefined
}

/**
 * 取正有限数，否则回落缺省——`NaN` / 0 / 负数都不该悄悄变成「全都截掉」；
 * 缺省永远是**实数上限**（不是「无上限」）。
 *
 * ⚠️ **只管输出上限**（U69）——超时**不走这里**：它的「没给」不是回落某个常量，而是
 * **无上界**（见下 `timeoutBoundOf`）。两者共用一个函数，正是「不设」表达不出来的缘由。
 */
function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 超时上界的归一 —— **`null` / 缺省 ＝ 无上界**（一直等）。
 *
 * 与 `positiveOr` 分开写，正是 U69 的要害：那个函数把 0 / 负数 / 非有限值一律当「没给」、
 * 回落到一个实数常量——于是**「无上界」根本写不出来**，而谁要是以为 `0` 是「不设」，
 * 拿到的是 120 秒的旧常量（读起来还像「立刻超时」，三头不搭）。
 *
 * 这一处的三档：
 * - `null` / `undefined` ⇒ 无上界（**显式写法与缺省同义**：`null` 是写给读的人看的）；
 * - 正有限数 ⇒ 就是它；
 * - 其余（0 · 负数 · `NaN` · `Infinity`）⇒ **也按无上界**——**宁可多等，不可误掐**：
 *   一个写错的数不该把一条正在下载依赖的命令收掉（D39 的由头就是被误掐）。
 *   ⚠️ 这道宽容只在**原语这一层**；模型给的值走的是工具域的参数校验，写错在更外面就报了。
 *
 * ## 为什么它露在**模块的面上**（U79 加的 `export`）
 *
 * 这一格是「不设 ＝ 一直等」这条规则的**唯一落点**，此前**只有这段注释兜着**：用例那一头
 * 够不到它——「缺省真的没上界」与「缺省回落某个常量」只在旧常量（120 秒）之后才分岔，
 * 量它就得真等两分钟（`exec.test.ts` 那条贵用例量的正是这个，且实测 flake 过一次）。
 *
 * U79 把那条贵用例改成**注入一个小上界**（同一条判据：给上界就掐、不给就活过它）之后，
 * 「**旧常量不许回来**」这一半就只剩下面这一跳咬得住——故让它露在面上，由用例直接钉住
 * 「缺省 / `null` / 写错的数 ⇒ `null`」。谁把旧常量当兜底加回来（`?? 120_000` 那一手），
 * 那条判据**当场红**，不必等那两分钟。
 */
export function timeoutBoundOf(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return Number.isFinite(value) && value > 0 ? value : null
}

/** 会话目录还能不能进——被删 / 不是目录 ⇒ 不能（`exec` 会回默认根）。 */
function usableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 执行原语：权限已由工具入口裁决；这里只执行并保护本次目标身份。 */
export function createSandbox(options: SandboxOptions): Sandbox {
  const { workspace } = options
  /**
   * **会话当前目录**——沙箱这一层的状态，不是调用方的参数。
   *
   * 命令不传 `cwd` 时用它；命令结束时跑出来的真实目录再写回（`ExecResult.cwd`）。
   * 放在 `build()` 外面是因为它是**整个沙箱**的状态：`bindTarget` 每次换的是目标绑定，
   * 换不掉「我在哪」。
   */
  let sessionCwd = workspace.defaultRoot()
  /** 上一条命令开始时所在目录——`cd -` 的依据（`OLDPWD`）。 */
  let previousCwd = workspace.defaultRoot()

  const build = (bound?: ResolvedPath, tool?: string): { sandbox: Sandbox; release(): Promise<void> } => {
    let opened: ReturnType<typeof openTarget> | undefined
    const targetOf = (path: string): ResolvedPath => {
      if (bound === undefined) return workspace.resolve(path)
      if (resolvePath(workspace.defaultRoot(), path) !== bound.absolute) throw new Error(`操作目标与裁决不一致：${path}`)
      return bound
    }
    const fileOf = (target: ResolvedPath): ReturnType<typeof openTarget> => {
      opened ??= openTarget(target, tool === 'edit' ? 'edit' : tool === 'write' ? 'write' : 'read')
      return opened
    }
    return {
      async release() {
        if (opened !== undefined) {
          const handle = await opened.catch(() => undefined)
          await handle?.close()
        }
      },
      sandbox: {
        bindTarget: (target, name) => build(target, name),
        sessionCwd: () => sessionCwd,
        async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
          let cwd: string
          try {
            // **会话目录失效**（被删 / 进不去）⇒ 回默认根并重置：不能把会话永久钉在一个进不去的目录上
            if (!usableDirectory(sessionCwd)) sessionCwd = workspace.defaultRoot()
            const base = opts.cwd ?? sessionCwd
            // **相对基准＝会话目录**（与命令里的 `cd` 同一个基准，不是默认根）
            const target = targetOf(isAbsolute(base) ? base : join(sessionCwd, base))
            assertIdentity(target)
            cwd = target.absolute
          } catch (error) {
            return { ok: false, reason: 'spawn', message: error instanceof Error ? error.message : String(error) }
          }
          const oldCwd = previousCwd
          const result = await runCommand(cmd, {
            env: options.env,
            shell: options.shell,
            cwd,
            oldCwd,
            cwdFile: join(tmpdir(), `magic-cwd-${randomUUID()}`),
            timeoutMs: timeoutBoundOf(opts.timeoutMs),
            maxOutputBytes: positiveOr(opts.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
            onOutput: opts.onOutput,
            signal: opts.signal,
            onTimeout: opts.onTimeout,
            ...(opts.adopt === undefined ? {} : { adopt: opts.adopt }),
            ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
          })
          // 命令跑出来的真实目录写回会话——下一条不传 cwd 就从这里起。
          // 显式给了 cwd 的那一条是一次性覆盖：它跑完往哪儿去，都不改会话目录。
          previousCwd = cwd
          if (opts.cwd === undefined && result.ok && result.cwd !== undefined) sessionCwd = result.cwd
          return result
        },
        async read(path: string, opts?: { maxBytes?: number; from?: number; lines?: number }): Promise<ReadResult> {
          const target = targetOf(path)
          const cap = positiveOr(opts?.maxBytes, DEFAULT_MAX_READ_BYTES)
          // 行窗口对**任何**文件一视同仁（`from` 1 起、`lines` 最多多少行）——
          // 早先这两格只给工作笔记，普通文件要靠 `exec` 的 `sed` / `head` 自己截
          if (opts?.from !== undefined && (!Number.isSafeInteger(opts.from) || opts.from < 1)) throw new Error('读取位置无效：from 须为从 1 起的整数')
          if (opts?.lines !== undefined && (!Number.isSafeInteger(opts.lines) || opts.lines < 1)) throw new Error('读取行数无效：lines 须为正整数')
          const window = opts?.from === undefined && opts?.lines === undefined
            ? undefined
            : { ...(opts?.from === undefined ? {} : { from: opts.from }), ...(opts?.lines === undefined ? {} : { lines: opts.lines }) }
          return bound === undefined ? readText(target, cap, window) : readOpened(await fileOf(target), target.absolute, cap, window)
        },
        async write(path: string, data: WriteData, opts?: { expectedContent?: string }): Promise<void> {
          const target = targetOf(path)
          if (bound === undefined) return writeInto(target, data, opts?.expectedContent)
          return writeOpened(await fileOf(target), target, data, opts?.expectedContent)
        },
        async list(path: string): Promise<readonly ListEntry[]> {
          const target = targetOf(path)
          assertIdentity(target)
          const result = await listDir(target.absolute)
          assertIdentity(target)
          return result
        },
        async match(pattern: string, opts: MatchOptions): Promise<readonly MatchHit[]> {
          const target = targetOf(opts.path ?? '.')
          assertIdentity(target)
          const result = await matchIn(target.absolute, pattern, opts)
          assertIdentity(target)
          return result
        },
      },
    }
  }
  return build().sandbox
}
