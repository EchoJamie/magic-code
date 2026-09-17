/**
 * `@magic/execution` —— 执行域（技术方案 · 领域划分：执行边界——沙箱原语 ＋ 工作区）。
 *
 * 两个端口（皆在契约 `@magic/contracts`，本包只出**实现 ＋ 装配期构造入参形态**）：
 * - `Sandbox` —— 执行命令 · 读 · 写 · 列 · 匹配；**阶段 1 只实装 `exec`**，
 *   余四者留桩（工具集 v1／U13 的事——不顺手做完）；
 * - `WorkspaceService` —— 工作区解析；阶段 1 **单根**（启动目录＝默认根）。
 *
 * 内核仅有的两处 fs 直触之一（另一处＝记录域）——沙箱与工作区是它存在的理由
 * （技术方案 · 代码治理 · 边界纪律）。
 *
 * 依赖：只 import `@magic/contracts`——域之间互不 import、域不认知外壳与装配。
 */

export { createSandbox } from './sandbox.ts'
export type { SandboxOptions } from './sandbox.ts'

export { createWorkspaceService } from './workspace.ts'
export type { WorkspaceOptions } from './workspace.ts'
