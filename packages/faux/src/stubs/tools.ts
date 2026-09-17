/**
 * 工具域桩 —— `ToolRuntime` 的内存实现（**测试替身**，不是工具域）。
 *
 * 用处：对话域循环测试要「工具用桩」——模型说调什么，就让桩回什么，不必牵扯真工具与沙箱
 * （工具域自己的测试照旧测真实现，U06）。
 *
 * 一处**刻意的语义**：未注册的工具返回 `ok: false` 而**不抛**。真实现里闸门在 `invoke`
 * 路径内（不可绕过），坏调用该以「拒绝 / 失败」回填给模型——炸掉循环不是工具域该干的事。
 */

import type { OutputDelta, RecordId, ToolCall, ToolResult, ToolRuntime, ToolSpec } from '@magic/contracts'

/**
 * 工具处理器的返回——`ok` ＋ `output`（**面向模型的文本**）两样。
 *
 * `content`（记录侧形态）与 `callRef`（链引用）**均由桩补**——真实现里它们也不归工具集：
 * `content` 是工具域把输出转成记录形态的产物（小则内联、大则落 blob），
 * `callRef` 是工具域从自己发的 `tool.call` 事件取的。桩一律内联（测试够用）。
 */
export type FauxToolHandlerResult = {
  readonly ok: boolean
  readonly output: string
}

/** 工具处理器——入参含透传的 `onOutput`（流式回吐）。 */
export type FauxToolHandler = (
  call: ToolCall,
  opts: { readonly signal?: AbortSignal | undefined; readonly onOutput?: ((d: OutputDelta) => void) | undefined },
) => FauxToolHandlerResult | Promise<FauxToolHandlerResult>

export type FauxToolRuntimeOptions = {
  /** 工具规格——`definitions()` 的返回（模型请求里要带上）。 */
  readonly definitions?: readonly ToolSpec[]
  /** 工具名 → 处理器；缺省的工具 → 失败结果。 */
  readonly handlers?: Readonly<Record<string, FauxToolHandler>>
  /**
   * 结果里的链引用——真实现由工具域从 `tool.call` 事件取；桩里**缺省 `1`**
   * （可预测：一轮里第一次调用）。
   */
  readonly callRef?: RecordId
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

      const callRef = options.callRef ?? 1

      const handler = options.handlers?.[call.name]
      if (handler === undefined) {
        const output = `Faux 工具桩：未注册的工具「${call.name}」`
        return { ok: false, output, content: { text: output }, callRef }
      }

      const result = await handler(call, { signal: opts.signal, onOutput: opts.onOutput })
      return { ok: result.ok, output: result.output, content: { text: result.output }, callRef }
    },
  }
}
