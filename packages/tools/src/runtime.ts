/**
 * 工具域的装配期形态。
 *
 * **端口本身在契约里**（`@magic/contracts` 的 `ToolRuntime`）——本域**不再自持一份结构超集**。
 * 第 1 轮曾以超集给出 `callRef` ＋ `content`（当时契约 `ToolResult` 只有 `{ok, output}`）；
 * 第 2 轮契约补锚把三件**收进了契约本身**（`output` 面向模型的文本 / `content` 记录侧形态 /
 * `callRef` 链引用），于是「本域多知道的那点东西」**就是契约**——再留一份同名补充，
 * 只会长出两个说法来对不上。
 *
 * 故 `createToolRuntime` 的返回类型＝契约端口：消费者按端口取用，无第二套形态要记。
 */

import type {
  BlobStore,
  EventSink,
  EventStamper,
  OutputDelta,
  PermissionGate,
  Sandbox,
  WorkspaceService,
} from '@magic/contracts'
import type { ToolDefinition } from './registry.ts'

/**
 * `invoke` 的第二参——契约端口形参的同形别名。
 *
 * 契约里它是**内联类型**（没有名字），本别名只为本域内部标注用，**不上公开面**：
 * 消费者写 `invoke(call, { signal })` 即可，不必为此多引一个名字。
 */
export type ToolInvokeOptions = {
  readonly signal?: AbortSignal
  /** 执行输出的增量——实时回调（本域另会转 `tool.output.delta` 事件）。 */
  readonly onOutput?: (delta: OutputDelta) => void
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
 *
 * **两种给法**（U38 返工 A）：
 * - **数组**——构造期定死的那一份（静态工具集照旧这么给）；
 * - **函数**——**每次现取**（`definitions()` 与查定义各取一次）。由头：**进程级**的工具来源
 *   （外部连接）与**按条建**的会话链不同寿命——快照会让「链先建、连接后连上」的那些
 *   工具永远进不了模型请求（接续会话首轮漏外部工具，正是这么栽的）。工具表因此
 *   **随连接实况走**：连上就有、断开就没有——这是如实，不是抖动。
 */
export type ToolRuntimeOptions = {
  readonly sandbox: Sandbox
  readonly workspace: WorkspaceService
  readonly gate: PermissionGate
  readonly sink: EventSink
  readonly stamper: EventStamper
  readonly blobs: BlobStore
  readonly tools?: readonly ToolDefinition[] | (() => readonly ToolDefinition[]) | undefined
}
