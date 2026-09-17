/**
 * 执行域桩 —— `Sandbox` 的内存实现（**测试替身**，不是沙箱）。
 *
 * 用处：工具域 / 对话域的测试要一条能跑的命令、一个能读的文件，但不该真的开进程
 * 或碰工作区（U05 的沙箱自己的测试照旧测真实现）。
 *
 * 两条底线：
 * - **记账**——每次 `exec` / `read` / `write` / `list` / `match` 留痕（`execs` / `reads`…），
 *   测试据此断言「工具真的按这个命令调了沙箱」；
 * - **不发明行为**——读不到就是空串、没编过的命令就是「成功空输出」。
 *   唯一一处「会生效」的是 `write` 后能读回来（沙箱本该如此）。
 *
 * ⚠️ `write` 的 **blob 支**只记账不落地——把 blob 转成内容是调用方的事（转存经记录域，
 * 见契约 · `WriteData`）。
 */

import type {
  ExecOptions,
  ExecResult,
  ListEntry,
  MatchHit,
  MatchOptions,
  ReadResult,
  Sandbox,
  WriteData,
} from '@magic/contracts'

/** `exec` 的编程形态——按命令查表，或按调用算（函数）。 */
export type FauxExecScript =
  | Readonly<Record<string, ExecResult>>
  | ((cmd: string, opts: ExecOptions) => ExecResult | Promise<ExecResult>)

export type FauxSandboxOptions = {
  /** 命令 → 结果；查不到即缺省（成功 / 空输出）。 */
  readonly exec?: FauxExecScript
  /** 预置文件——`read` 的来源（`write` 也写这里）。 */
  readonly files?: Readonly<Record<string, string>>
  /** 预置目录——`list` 的来源；查不到即空。 */
  readonly dirs?: Readonly<Record<string, readonly ListEntry[]>>
  /** `match` 的命中——固定一份（桩不做真匹配）。 */
  readonly hits?: readonly MatchHit[]
}

/** 沙箱桩的观察面——调用留痕。 */
export type FauxSandbox = Sandbox & {
  readonly execs: readonly { readonly cmd: string; readonly opts: ExecOptions }[]
  readonly reads: readonly string[]
  readonly writes: readonly { readonly path: string; readonly data: WriteData }[]
  readonly lists: readonly string[]
  readonly matches: readonly { readonly pattern: string; readonly opts: MatchOptions }[]
}

const OK_EMPTY: ExecResult = { ok: true, exit: 0, stdout: '', stderr: '' }

/** 造一个沙箱桩。 */
export function makeFauxSandbox(options: FauxSandboxOptions = {}): FauxSandbox {
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const execs: { cmd: string; opts: ExecOptions }[] = []
  const reads: string[] = []
  const writes: { path: string; data: WriteData }[] = []
  const lists: string[] = []
  const matches: { pattern: string; opts: MatchOptions }[] = []

  return {
    get execs(): readonly { readonly cmd: string; readonly opts: ExecOptions }[] {
      return execs
    },
    get reads(): readonly string[] {
      return reads
    },
    get writes(): readonly { readonly path: string; readonly data: WriteData }[] {
      return writes
    },
    get lists(): readonly string[] {
      return lists
    },
    get matches(): readonly { readonly pattern: string; readonly opts: MatchOptions }[] {
      return matches
    },

    async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
      execs.push({ cmd, opts })

      const script = options.exec
      if (script === undefined) return OK_EMPTY
      if (typeof script === 'function') return script(cmd, opts)
      return script[cmd] ?? OK_EMPTY
    },

    async read(path: string): Promise<ReadResult> {
      reads.push(path)
      return { content: files.get(path) ?? '' }
    },

    async write(path: string, data: WriteData): Promise<void> {
      writes.push({ path, data })
      // blob 支：桩里没有 blob 存储，只记账（见文件头注）
      if ('text' in data) files.set(path, data.text)
    },

    async list(path: string): Promise<readonly ListEntry[]> {
      lists.push(path)
      return options.dirs?.[path] ?? []
    },

    async match(pattern: string, opts: MatchOptions): Promise<readonly MatchHit[]> {
      matches.push({ pattern, opts })
      return options.hits ?? []
    },
  }
}
