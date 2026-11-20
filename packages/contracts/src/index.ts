/**
 * `@magic/contracts` —— 契约包（**共享语言 ＋ 跨域端口**）。
 *
 * 出处：技术方案 · 领域划分（「契约（耦合契约）」）。
 * 域包只 import 本包（＋许可外部库）；域之间互不 import、域不认知外壳与装配——
 * **本包是唯一的跨域入口**。
 *
 * **纯类型、零运行时依赖**（共享内核保持小而稳）；例外只有 `config.ts` 的三个
 * 无依赖纯函数（`apiKeyEnvVarOf` / `expandHome` / `resolveMagicHome`——规则载体）。
 *
 * 两件：
 * 1. **共享语言**——`ids`（标识与时间口径）· `entries`（条目与 blob 引用）·
 *    `events`（kind 族与载荷 · 信封 · 不落库清单）· `control`（命令面与配对）·
 *    `config`（配置形制）· `mcp`（外部工具的命名与身份 · 连接端口）·
 *    `process`（自有进程的归属账——U50）；
 * 2. **跨域端口**——`ports`（九签名 ＋ 沙箱原语 / 工具规格 ＋ 阶段 3 加的只读来源面：
 *    项目规约 U32 · 技能 U33）。
 *
 * 未定处标 `TODO(规划侧)`；**占位内部结构不属契约**——不得依赖（技术方案 · 代码治理 ·
 * 契约生长受控）。
 */

export * from './shared/ids.ts'
export * from './shared/wire-budget.ts'
export * from './conversation/entries.ts'
export * from './conversation/events.ts'
export * from './conversation/control.ts'
export * from './shared/config.ts'
export * from './shared/mcp.ts'
export * from './shared/model.ts'
export * from './shared/process.ts'
export * from './conversation/runs.ts'
export * from './shared/web.ts'
export * from './shared/search.ts'
export * from './ports.ts'
export * from './conversation/native.ts'
export * from './scheduling/run-wire.ts'
export { decodeNativeMessage, decodeHostDiscovery } from './conversation/native-codec.ts'
export * from './conversation/collaboration.ts'
export type * from './conversation/collaboration-control.ts'

export * from './conversation/input.ts'

export * from "./shared/settings.ts"

export * from './shared/diagnostics.ts'

export { settingsAction, settingsSnapshot, settingsRequest, settingsResult } from './shared/settings-codec.ts'
export type { ModelProtocol, ProviderAuth, ModelSource, VendorProtocol } from './shared/model.ts'
export type { BackgroundChange, BackgroundTarget, BackgroundCommand, BackgroundView, BackgroundCommandRequest } from './conversation/background.ts'

export type * from './conversation/memory.ts'
export type * from './conversation/knowledge.ts'
export type { NoteReadQuery, NoteLink, NotePage, NoteState, WorkingNotes, ContextCoverage, CoverageRecords } from './conversation/notes.ts'
