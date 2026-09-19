/**
 * `@magic/permission` —— 权限域公开面（技术方案 · 领域划分：权限域）。
 *
 * 职责：**裁决**——机械分析 · 危险分级 · **规则** · 询问流转 · 度量。
 * 对外端口：**`PermissionGate`**（`decide(call, ctx, callRef) → Promise<Decision>` ＋
 * `resolve(requestId, decision)`）。
 * **优先级：必闸 ＞ 规则 ＞ 默认问**——默认照旧是问（阶段 1 姿态），规则是唯一的例外路径。
 *
 * 域纪律（技术方案 · 代码治理 · 领域划分）：
 * - **只依赖 `@magic/contracts`**——域之间互不 import、域不认知外壳与装配；
 * - **裁决独立**——不自证、不押模型自述：判定归**机械分析**（工具名 ＋ 参数）；
 * - **裁决过程只走事件、不入条目**——本域注入面无条目写权（`EventSink` 只有 `emit`）；
 * - **不碰文件系统**——故凡须「文件是否存在」才能判的形态一律归「看不懂」，按不可逆假定问；
 *   规则也从**配置的已解析值**进来（`parseRules`），读文件是装配的事。
 *
 * 出口六件：
 * ① **端口装配**——`createPermissionGate`；
 * ② **形态**——`PermissionGate`（＝契约端口，三参 `decide` ＋ `resolve`）＋ 度量读面 `tally`；
 * ③ **机械分析**——`analyze`（判定 ＋ 材料 ＋ 规则轴），供外壳预览与测试直取；
 * ④ **事件构造子**——两个 kind（装配与测试用）；
 * ⑤ **规则**——`PermissionRule` 形态 ＋ `parseRules`（配置解析 · 只读）；
 * ⑥ **授权**（U22）——`Grant` / `GrantsFile` 形态 ＋ `parseGrants`（**授权文件**解析 · 只读）
 *    ＋ `createGrantLedger`（**工作区级**账本 · 纯内存）。
 *
 * 不出去的：命令分解表 · 路径判据与模式匹配 · 在途询问表（域内物）。
 */

// —— ② 形态 ——

export type { GateTally, PermissionGate, PermissionGateOptions, ResolveOptions } from './gate.ts'

// —— ① 端口装配 ——

export { createPermissionGate } from './gate.ts'

// —— ③ 机械分析 ——

export type { Analysis } from './analyze.ts'
export { analyze, unclassifiable } from './analyze.ts'
export type { Landing } from './paths.ts' // 影响面词条（`Analysis.landings` 的元素）

// —— ④ 事件构造子（信封由注入的 `EventStamper` 铸）——

export { decisionMade, decisionRequest } from './events.ts'

// —— ⑤ 规则（阶段 2：规则自动放行）——

export type { RuleOp } from './ops.ts'
export { RULE_OPS } from './ops.ts'
export type { PermissionRule, RuleParseResult, RuleProblem } from './rules.ts'
export { parseRules } from './rules.ts'

// —— ⑥ 授权（U22：授权的落点＝工作区）——

export type {
  Grant,
  GrantChange,
  GrantLedger,
  GrantLedgerOptions,
  GrantParseResult,
  GrantProblem,
  GrantsFile,
} from './grants.ts'
export {
  createGrantLedger,
  emptyGrants,
  GRANTS_VERSION,
  parseGrants,
  STALE_AFTER_MS,
} from './grants.ts'
