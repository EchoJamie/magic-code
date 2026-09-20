/**
 * `@magic/execution` —— 执行域（技术方案 · 领域划分：执行边界——沙箱原语 ＋ 工作区）。
 *
 * 三个端口（皆在契约 `@magic/contracts`，本包只出**实现 ＋ 装配期构造入参形态**）：
 * - `Sandbox` —— 执行命令 · 读 · 写 · 列 · 匹配（**五原语齐**：`exec` 阶段 1 实装，
 *   余四者随工具集 v1／U13 补齐；路径解析与越界拒绝在各原语内同一处归位）；
 * - `WorkspaceService` —— 工作区解析；阶段 1 **单根**（启动目录＝默认根）；
 * - `ProjectRules`（**U32 加**）—— 项目规约的**只读**来源面：发现 · 读取 · 解析 ·
 *   去重 · 诊断。落在这里的理由与沙箱同源：**文件读取归执行 / 基础设施边界**，
 *   选哪些、什么时候送归对话侧。
 *
 * 内核仅有的两处 fs 直触之一（另一处＝记录域）——沙箱 · 工作区 · 规约来源是它存在的理由
 * （技术方案 · 代码治理 · 边界纪律）。
 *
 * 依赖：只 import `@magic/contracts`——域之间互不 import、域不认知外壳与装配。
 */

export { createSandbox } from './sandbox.ts'
export type { SandboxOptions } from './sandbox.ts'

export { createWorkspaceService } from './workspace.ts'
export type { WorkspaceOptions } from './workspace.ts'

export { createProjectRules } from './rules.ts'
export type { RulesOptions } from './rules.ts'
