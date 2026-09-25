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

/**
 * **一个 MCP 连接 → 它的工具定义**（U38）——`options.tools` 那个追加出口的**现成一件**。
 *
 * 装配拿它把外部工具接进同一张注册表（**没有第二个工具来源**：审批、取消、记录、回填
 * 走的都是 `createToolRuntime` 那一条链）。传进来的连接是 `@magic/contracts` 的端口——
 * 客户端封在适配器（`@magic/mcp`）后面，本域不认识 MCP。
 */
export { defineMcpTools } from './mcp-tools.ts'

// —— ② 构造入参形态 ——

export type { ToolRuntimeOptions } from './runtime.ts'

// —— ③ 工具定义的形态（`options.tools` 的类型——U13 的入口）——

export type { ToolDefinition, ToolRunContext, ToolRunResult } from './registry.ts'

/**
 * **技能读取入口**（U33）——`options.tools` 的第一位真消费者。
 *
 * 它是**追加**出口上的一件，不替换默认集：「机制在内、工具集在外」说的是可插拔，
 * 而这一件要的依赖（`Skills` 端口）不在本域默认那七件的射程里——由装配把它造好递进来。
 */
export { defineSkillTool } from './skill-tool.ts'

/**
 * **计划与历史三件**（U34）——`options.tools` 追加出口上的又一束。
 *
 * 与 `skill` 同一处境（它要的依赖不在本域默认七件的射程里）：三件读写的是**同会话的
 * 协作笔记与会话记录**，而「当前计划是哪一条、活动窗口从哪儿划」是对话域的判断——
 * 故由装配把那一对只读回调（`PlanReader`，按会话绑定）造好递进来。
 *
 * ⚠️ **三个名字与放行规则同源**（`PLAN_TOOL_NAMES`）：权限域的分析表要显式认这三格、
 * 装配另按名字追加放行规则——名字散在各处时，改名会静默只改一半。
 */
export { definePlanTools, PLAN_TOOL_NAMES } from './plan-tools.ts'

/**
 * **取网页**（U72）——`options.tools` 追加出口上的第四束。
 *
 * 与 `skill` / `plan` 同一处境：它要的两样依赖（`WebSource` 出网面 · `PageDistiller`
 * 提炼面）不在本域默认七件的射程里，由装配造好递进来。
 *
 * ⚠️ **这也是「工具可以调模型」那条护栏的落点**（设计 · 工具执行与权限）：那次提炼调用
 * **不带任何工具**、**深度恒为 1**——它是**这一件工具**的构造入参，不是工具域的公共能力
 * （`ToolRunContext` 一个字都没多）。别的工具想调模型，是另开一条这样的窄端口 ＋ 一次裁决。
 */
export { defineWebFetchTool } from './web-fetch-tool.ts'
export type { WebFetchDeps } from './web-fetch-tool.ts'

/** 网页正文 → markdown 的上限（回执要报的那个数）——装配与用例都读它一处。 */
export { WEB_PAGE_MAX_CHARS } from './web-fetch-tool.ts'
