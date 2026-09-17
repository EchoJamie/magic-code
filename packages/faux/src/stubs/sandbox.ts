/**
 * 执行域桩 —— `Sandbox` 的内存实现（**测试替身**，不是沙箱）。
 *
 * 用处：工具域 / 对话域的测试要一条能跑的命令、一个能读的文件，但不该真的开进程
 * 或碰工作区（U05 的沙箱自己的测试照旧测真实现）。
 *
 * 两条底线：
 * - **记账**——每次 `exec` / `read` / `write` / `list` / `match` 留痕（`execs` / `reads`…，
 *   入参一并记下），测试据此断言「工具真的按这个参数调了沙箱」；
 * - **不发明行为**——读不到就是空串、没编过的命令就是「成功空输出」。
 *   唯一一处「会生效」的是 `write` 后能读回来（沙箱本该如此）。
 *
 * ⚠️ **桩不模拟 `read` 的 `maxBytes`**——它只把选项**记下来**（`reads` 里看得见），
 * 截断 / 超限即拒是**真实现**的行为（U05）。测试要验「`edit` 有没有放大上限」看记账即可，
 * 别拿桩当上限的判据。
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

/** `read` 的入参——路径 ＋ 选项（`opts` 可省，故**原样记**，不改写成缺省值）。 */
export type FauxReadCall = {
  readonly path: string
  readonly opts: { readonly maxBytes?: number } | undefined
}

/** 沙箱桩的观察面——调用留痕。 */
export type FauxSandbox = Sandbox & {
  readonly execs: readonly { readonly cmd: string; readonly opts: ExecOptions }[]
  readonly reads: readonly FauxReadCall[]
  readonly writes: readonly { readonly path: string; readonly data: WriteData }[]
  readonly lists: readonly string[]
  readonly matches: readonly { readonly pattern: string; readonly opts: MatchOptions }[]
}

const OK_EMPTY: ExecResult = { ok: true, exit: 0, stdout: '', stderr: '' }

/** 造一个沙箱桩。 */
export function makeFauxSandbox(options: FauxSandboxOptions = {}): FauxSandbox {
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const execs: { cmd: string; opts: ExecOptions }[] = []
  const reads: FauxReadCall[] = []
  const writes: { path: string; data: WriteData }[] = []
  const lists: string[] = []
  const matches: { pattern: string; opts: MatchOptions }[] = []

  return {
    get execs(): readonly { readonly cmd: string; readonly opts: ExecOptions }[] {
      return execs
    },
    get reads(): readonly FauxReadCall[] {
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

    async read(path: string, opts?: { maxBytes?: number }): Promise<ReadResult> {
      reads.push({ path, opts })
      return { content: files.get(path) ?? '' }
    },

    async write(path: string, data: WriteData): Promise<void> {
      writes.push({ path, data })
      // 两选一都落地——「write 后能读回来」对字节支同样成立（文本按 UTF-8 解出来）
      files.set(path, 'text' in data ? data.text : new TextDecoder().decode(data.bytes))
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
