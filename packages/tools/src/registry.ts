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

import type {
  BackgroundRuns,
  ExternalToolRef,
  OutputDelta,
  PlanNote,
  Sandbox,
  ToolSpec,
  UsedSkill,
} from '@magic/contracts'

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
  /**
   * **后台运行登记**（U70）——`exec` 的后台那一形要的那一件（起 · 按 id 停）。
   *
   * 缺省不给 ＝ 这一形用不了（`exec` 的 `background` 会照实回一句「这次装配没接」，
   * 不静默退回前台——见 `messages.ts` 那一处）。旧装配与只验前台的用例因此一字不动。
   *
   * 它**不是沙箱的第二种走法**：沙箱管「在轮内跑一条」（同一条命令，等它结束），
   * 这一件管「交出去、按 id 停」——两件事各有各的六格（设计 · `exec` 的后台那一形）。
   *
   * **可选位**：既有执行体与用例大多手写这个现场（只给沙箱与信号），加一个必填位会把
   * 它们全部推去改一遍——而「没接后台」本就是这一位的合法取值（那一形当场回一句「没接」）。
   */
  readonly background?: BackgroundRuns | undefined
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
  /**
   * **这一次调用交付了一份计划更新**（U34）——只有更新笔记的那件工具会填
   * （见契约 `ToolResult.plan`：`null` ＝ 清空，与「没有这一位」分得开）。
   *
   * 与 `skill` 同一处境、同一条走法：**执行体只交回载荷，写记录与发通报都归对话域**
   * （`appendToolResultEntry` → `plan.changed`）。本域（分发）不认识计划，只是原样带上去。
   */
  readonly plan?: PlanNote | null
  /**
   * **这一轮停在这儿**（U72）——只有「取网页」那一件会填，且只在**没配提炼模型**时。
   *
   * 与 `skill` / `plan` 同一处境：执行体只交回这一位，**收束那一轮归对话域**
   * （`agentLoop` 的收口）——工具不碰循环。为什么这一种失败不能交给模型自己处置，
   * 见契约 `ToolResult.halt` 那一段（绕道 `exec curl` 会把整件事绕过去）。
   */
  readonly halt?: true
}

/** 一条工具定义——规格（送模型）＋ 执行体（经沙箱）。 */
export type ToolDefinition = {
  readonly spec: ToolSpec
  readonly run: (
    args: Readonly<Record<string, unknown>>,
    ctx: ToolRunContext,
  ) => ToolRunResult | Promise<ToolRunResult>
  /**
   * **外部工具的身份**（U38）——这一位在＝这条定义来自一个 MCP 服务器，不是内置的。
   *
   * 由**造这条定义的那一处**写死（`defineMcpTools`：从服务器名与工具名合成），分发据它
   * 在询问闸门**之前**附到调用上（`ToolCall.external`）——权限域因此取得到**注册表给的**
   * 来源，而不是模型参数里的自报。执行体那一侧看不见它（`run` 只收 `args`）。
   */
  readonly external?: ExternalToolRef
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
