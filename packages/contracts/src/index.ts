/**
 * `@magic/contracts` —— 契约包（**共享语言 ＋ 跨域端口**）。
 *
 * 出处：技术方案 · 领域划分（「契约（耦合契约）」）。
 * 域包只 import 本包（＋许可外部库）；域之间互不 import、域不认知外壳与装配——
 * **本包是唯一的跨域入口**。
 *
 * **纯类型、零运行时依赖**（共享内核保持小而稳）；例外只有 `config.ts` 的两个
 * 无依赖纯函数（`apiKeyEnvVarOf` / `expandHome`——规则载体）。
 *
 * 两件：
 * 1. **共享语言**——`ids`（标识与时间口径）· `entries`（条目与 blob 引用）·
 *    `events`（kind 族与载荷 · 信封 · 不落库清单）· `control`（命令面与配对）·
 *    `config`（配置形制）；
 * 2. **跨域端口**——`ports`（九签名 ＋ 沙箱原语 / 工具规格）。
 *
 * 未定处标 `TODO(规划侧)`；**占位内部结构不属契约**——不得依赖（技术方案 · 代码治理 ·
 * 契约生长受控）。
 */

export * from './ids.ts'
export * from './entries.ts'
export * from './events.ts'
export * from './control.ts'
export * from './config.ts'
export * from './ports.ts'
