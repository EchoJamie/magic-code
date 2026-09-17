/**
 * `@magic/tools` —— **工具域**（技术方案 · 领域划分：工具机制——定义 · 注册 · 分发）。
 *
 * 职责：**工具机制**——工具定义（名称 · 描述 · 参数模式 · 危险归类 · 执行体）· 注册 ·
 * 分发（**请求 → 闸门 → 执行 → 回填**）。对外端口 **`ToolRuntime`**（在 `@magic/contracts`）。
 *
 * 三条域规则（技术方案 · 领域划分 · 工具域）：
 * - **闸门在执行路径内、不可绕过**——`invoke` 里没有第二条路能走到执行体；
 * - **机制在内、工具集在外**（可插拔）——默认集＝**工具集 v1 七件**
 *   （`exec` ＋ `read` / `write` / `edit` / `grep` / `glob` / `ls`，见 `toolset.ts`）；
 *   `options.tools` 是**追加**出口（自定义 / 未来的 MCP 集），不替换默认集；
 * - **危险归类只声明不判定**——`exec` 与 `write` 声明 `by-call`（按命令 / 按调用判定），
 *   实际的机械分析在权限域（`@magic/permission`）。本域**不替它判**，也不把判定结论塞进 `decide`。
 *
 * 域纪律（技术方案 · 代码治理）：
 * - **只依赖 `@magic/contracts`**——域之间互不 import、域不认知外壳与装配；
 * - **不碰文件系统**——执行一律经沙箱（内核仅 records / execution 两处 fs 直触）；
 * - **blob 写权唯一归记录域**——大块转存经其公开面（`BlobStore`），本域只调用。
 *
 * 公开面三件（技术方案 · 代码治理 · 公开面：端口实现 ＋ 装配期构造入参形态）：
 * ① **端口装配**——`createToolRuntime`（返回类型＝契约端口 `ToolRuntime`，
 *    **本域不自持第二套形态**——`ToolResult` 的三件已在契约里，见 `runtime.ts` 头注）；
 * ② **构造入参形态**——`ToolRuntimeOptions`；
 * ③ **工具定义的形态**——`ToolDefinition` / `ToolRunContext` / `ToolRunResult`
 *    （`options.tools` 的类型，U13 的工具集从这里进）。
 *
 * 不出去的：默认集的工具定义与参数模式（`defineToolsetV1` 及各工具的常量——默认集随本域出厂，
 * 消费者只需 `createToolRuntime`）· 回填报文 · 注册表实现 · 参数取用小件 · 大块转存阈值 ·
 * `invoke` 第二参的别名（契约里它是内联类型，消费者不必引名字）。
 */

// —— ① 端口装配 ——

export { createToolRuntime } from './dispatch.ts'

// —— ② 构造入参形态 ——

export type { ToolRuntimeOptions } from './runtime.ts'

// —— ③ 工具定义的形态（`options.tools` 的类型——U13 的入口）——

export type { ToolDefinition, ToolRunContext, ToolRunResult } from './registry.ts'
