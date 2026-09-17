/**
 * 工具域公开形态 —— 契约端口的**结构超集**。
 *
 * 先例：`@magic/model` 的 `ModelGateway extends ModelGatewayPort`（域包对外报的是
 * 「端口 ＋ 本域多知道的那点东西」）。这里多带的两件都不是重复：
 *
 * - `callRef` —— 该次 `tool.call` 事件的 id。**链引用**（请求 → 询问 → 裁决 → 结果四事件
 *   靠它串）。本域铸完就持有；调用方（对话域）若要按链对账 / 落条目，不必再去事件流里猜；
 * - `content` —— 记录侧形态（内联或 blob 引用）。`output` 是**面向模型的文本**，
 *   而记录该存什么由大块转存决定——两者**在大负载时不同**：文本是全文，记录是引用。
 *   不给这一件，写条目的那一方就没法与事件侧结构对齐（`ToolResultPayload.output: Content`），
 *   只能把截断后的文本当全文记——重放时尾巴就没了。
 *
 * 契约 `ToolResult` 只出 `{ ok, output }`——**面向端口的消费者照旧只见这两件**，
 * 超集不构成对契约的依赖倒置（`invoke` 的返回类型是它的子类型，赋值给端口类型恒合法）。
 */

import type {
  BlobStore,
  Content,
  EventSink,
  EventStamper,
  OutputDelta,
  PermissionGate,
  RecordId,
  Sandbox,
  ToolCall,
  ToolResult,
  ToolRuntime as ToolRuntimePort,
  WorkspaceService,
} from '@magic/contracts'
import type { ToolDefinition } from './registry.ts'

/** `invoke` 的第二参——与契约端口同形（给出名字，供消费方标注）。 */
export type ToolInvokeOptions = {
  readonly signal?: AbortSignal
  /** 执行输出的增量——实时回调（本域另会转 `tool.output.delta` 事件）。 */
  readonly onOutput?: (delta: OutputDelta) => void
}

/** 一次调用的**回填物**——契约 `ToolResult` ＋ 本域多知道的两件（见文件头注）。 */
export type ToolInvocation = ToolResult & {
  /** 该次 `tool.call` 事件的 id——贯穿调用链。 */
  readonly callRef: RecordId
  /** 记录侧形态（内联或 blob 引用）——条目与事件照它对齐。 */
  readonly content: Content
}

/**
 * 工具域端口 —— 契约 `ToolRuntime` 的结构超集。
 *
 * `invoke` 的返回类型收窄到 `ToolInvocation`（子类型，**端口消费者不受影响**）；
 * `definitions()` 逐字照契约——定义随每次调用送模型（词典 · Tool）。
 */
export interface ToolRuntime extends ToolRuntimePort {
  invoke(call: ToolCall, opts: ToolInvokeOptions): Promise<ToolInvocation>
}

/**
 * 装配期构造入参（技术方案 · 领域划分 · 装配视图 3：工具域 ← 沙箱 · 权限 ＋ 事件面）。
 *
 * 六个件各有来处，**没有一件是多余的**：
 * - `sandbox` —— 执行体的场所（本域不直碰文件系统：那是执行域的两处特权之一）；
 * - `workspace` —— 根视图的来处（`PermissionContext` 是**纯数据**，由调用方给出）；
 * - `gate` —— 闸门（在 `invoke` 路径内、不可绕过）；
 * - `sink` / `stamper` —— 事件面（产出方铸信封：链引用要当场拿到）；
 * - `blobs` —— 大块转存的唯一出口（**写权唯一归记录域**，此处只取它的公开面）。
 *
 * `tools` ＝ 追加注册的工具定义（机制在内、工具集在外，可插拔）——阶段 1 默认集**只有
 * `exec`**；`read` / `write` / … 归工具集 v1（U13）。
 */
export type ToolRuntimeOptions = {
  readonly sandbox: Sandbox
  readonly workspace: WorkspaceService
  readonly gate: PermissionGate
  readonly sink: EventSink
  readonly stamper: EventStamper
  readonly blobs: BlobStore
  readonly tools?: readonly ToolDefinition[]
}
