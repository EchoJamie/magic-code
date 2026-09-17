/**
 * 工具域桩 —— `ToolRuntime` 的内存实现（**测试替身**，不是工具域）。
 *
 * 用处：对话域循环测试要「工具用桩」——模型说调什么，就让桩回什么，不必牵扯真工具与沙箱
 * （工具域自己的测试照旧测真实现，U06）。
 *
 * 一处**刻意的语义**：未注册的工具返回 `ok: false` 而**不抛**。真实现里闸门在 `invoke`
 * 路径内（不可绕过），坏调用该以「拒绝 / 失败」回填给模型——炸掉循环不是工具域该干的事。
 */

import type { OutputDelta, ToolCall, ToolResult, ToolRuntime, ToolSpec } from '@magic/contracts'

/** 工具处理器——入参含透传的 `onOutput`（流式回吐）。 */
export type FauxToolHandler = (
  call: ToolCall,
  opts: { readonly signal?: AbortSignal | undefined; readonly onOutput?: ((d: OutputDelta) => void) | undefined },
) => ToolResult | Promise<ToolResult>

export type FauxToolRuntimeOptions = {
  /** 工具规格——`definitions()` 的返回（模型请求里要带上）。 */
  readonly definitions?: readonly ToolSpec[]
  /** 工具名 → 处理器；缺省的工具 → 失败结果。 */
  readonly handlers?: Readonly<Record<string, FauxToolHandler>>
}

/** 工具域桩的观察面——调用留痕。 */
export type FauxToolRuntime = ToolRuntime & {
  readonly calls: readonly ToolCall[]
}

/** 造一个工具域桩。 */
export function makeFauxToolRuntime(options: FauxToolRuntimeOptions = {}): FauxToolRuntime {
  const calls: ToolCall[] = []

  return {
    get calls(): readonly ToolCall[] {
      return calls
    },

    definitions: (): readonly ToolSpec[] => options.definitions ?? [],

    async invoke(
      call: ToolCall,
      opts: { signal?: AbortSignal; onOutput?: (d: OutputDelta) => void },
    ): Promise<ToolResult> {
      calls.push(call)

      const handler = options.handlers?.[call.name]
      if (handler === undefined) {
        return { ok: false, output: `Faux 工具桩：未注册的工具「${call.name}」` }
      }

      return handler(call, { signal: opts.signal, onOutput: opts.onOutput })
    },
  }
}
