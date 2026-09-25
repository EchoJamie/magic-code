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
 * - `Skills`（**U33 加**）—— 技能的**只读**来源面（同一个理由、同一份分工）：
 *   入口是 `SKILL.md`（Agent Skills 规范），发现只取名称与描述，正文按需再读。
 * - `Materials`（**U36 加**）—— 文件 / 目录材料的**只读**来源面（同一条分工的第三次）：
 *   正文里的 `@` 引用取它。多一条边界——工作区外**只收单个文件**（用户明确选定的
 *   只读附件），且只收文本。
 *
 * 内核仅有的两处 fs 直触之一（另一处＝记录域）——沙箱 · 工作区 · 规约来源是它存在的理由
 * （技术方案 · 代码治理 · 边界纪律）。
 *
 * 依赖：只 import `@magic/contracts`——域之间互不 import、域不认知外壳与装配。
 */

export { createSandbox } from './sandbox.ts'
export type { SandboxOptions } from './sandbox.ts'

/**
 * **后台运行登记**（U70）——`exec` 的后台那一形的实现（起 · 说一声 · 按 id 停）。
 * 与沙箱并列的第五件：沙箱管「在轮内跑一条」，它管「交出去、按 id 停」。
 */
export { createBackgroundRuns } from './background.ts'
export type { BackgroundOptions } from './background.ts'

/**
 * **自有进程组的归属与收尾**（U50）——不是端口，是这一域给出去的两件本事：
 * 账（`createProcessLedger`，装配造一本、两处共用）与收尾 / 核对
 * （`reapOwned` / `startTimeOf` / `sameProcess`——管理者的「收回已登记自有进程组」用它）。
 */
export {
  PROCESS_START_TOLERANCE_MS,
  createProcessLedger,
  groupAlive,
  reapOwned,
  sameProcess,
  signalGroup,
  startTimeOf,
} from './groups.ts'
export type { ReapOutcome, ReapTimes } from './groups.ts'

export { createWorkspaceService } from './workspace.ts'
export type { WorkspaceOptions } from './workspace.ts'

export { createProjectRules } from './rules.ts'
export type { RulesOptions } from './rules.ts'

export { createSkills } from './skills.ts'
export type { SkillsOptions } from './skills.ts'

export { createMaterials, DEFAULT_CANDIDATES } from './materials.ts'
export type { MaterialsOptions } from './materials.ts'

/**
 * **取回面**（`WebSource` · U72）——出网那一件原语（抓一个 URL）。
 *
 * 落在这里的理由与沙箱同源（见 `../src/web.ts` 头注）：它是**边界动作**，
 * 三条规矩（只认 http(s) 且升 https、本机与无点主机名发请求之前就拒、不跟随跨主机重定向）
 * 在一处写死。工具那一件经这条端口取网，不自己 `fetch`。
 */
export {
  createWebSource,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TIMEOUT_MS,
} from './web.ts'
export type { WebSourceOptions } from './web.ts'
