/**
 * 工具定义与注册 —— 机制的第一件。
 *
 * **工具定义**（技术方案 · 工具 · 机制）＝名称 · 描述 · 参数模式 · 危险归类 · 执行体。
 * 前四件就是契约的 `ToolSpec`（`spec`），第五件是本域的 `run`——**机制在内、工具集在外**：
 * 定义怎么被登记与分发是机制，具体有哪些工具是可插拔的集（阶段 1：只有 `exec`）。
 *
 * **注册即校验**（两条硬规矩，都不静默）：
 * - **重名即拒**——不覆盖。静默覆盖是「最难查的一类假绿」：调用打到另一份执行体上，
 *   表现却像正常，测试还绿；
 * - **无名即拒**——定义面不许出现无名工具（送模型时无名字的工具等于不可调用）。
 *
 * 执行体拿到的是 `ToolRunContext`——**沙箱 ＋ 本次调用的流式 / 取消面**。它**不碰**
 * 闸门与事件面：审议与留痕是分发的活，执行体只管「怎么把这件事做出来」。
 */

import type { OutputDelta, Sandbox, ToolSpec, UsedSkill } from '@magic/contracts'

/** 执行体拿到的现场——沙箱（场所）＋ 本次调用的流式 / 取消面。 */
export type ToolRunContext = {
  readonly sandbox: Sandbox
  /** 取消——中止在途（本域已把它交给沙箱）。 */
  readonly signal: AbortSignal | undefined
  /**
   * 执行输出的增量回调——**本域已接好**（转 `tool.output.delta` 事件 ＋ 转交调用方的
   * `onOutput`）。执行体只需把它原样交给沙箱的 `opts.onOutput`。
   */
  readonly onOutput: ((delta: OutputDelta) => void) | undefined
}

/** 执行体的产出——终值（`ok` 与**面向模型的文本**）。记录侧形态由分发按大块转存定。 */
export type ToolRunResult = {
  readonly ok: boolean
  readonly output: string
  /**
   * **这一次调用交付了一份技能主文**（U33）——只有读技能的那件工具会填（见契约 `ToolResult.skill`）。
   *
   * 「机制在内、工具集在外」的落点：分发**不认识技能**，它只是把执行体给的这一位原样带上去
   * ——说话的是工具（它读的），回执由对话域发（只有它知道材料什么时候真进了模型请求）。
   */
  readonly skill?: UsedSkill
}

/** 一条工具定义——规格（送模型）＋ 执行体（经沙箱）。 */
export type ToolDefinition = {
  readonly spec: ToolSpec
  readonly run: (
    args: Readonly<Record<string, unknown>>,
    ctx: ToolRunContext,
  ) => ToolRunResult | Promise<ToolRunResult>
}

/** 注册表——定义随每次调用送模型的来处（`definitions()`）。 */
export type ToolRegistry = {
  readonly definitions: readonly ToolSpec[]
  get(name: string): ToolDefinition | undefined
}

/**
 * 造一张注册表。**顺序即 `definitions()` 的顺序**（送模型的次序稳定，好对照）。
 * 重名 / 无名当场抛——注册是构造期的事，坏表不该活到调用期。
 */
export function createRegistry(definitions: readonly ToolDefinition[]): ToolRegistry {
  const table = new Map<string, ToolDefinition>()

  for (const definition of definitions) {
    const { name } = definition.spec

    if (name.trim() === '') {
      throw new Error('工具定义缺少名称——name 须为非空字符串')
    }
    if (table.has(name)) {
      throw new Error(`工具重名：「${name}」——注册不覆盖，重名即拒`)
    }

    table.set(name, definition)
  }

  return {
    definitions: [...table.values()].map((definition) => definition.spec),
    get: (name) => table.get(name),
  }
}
