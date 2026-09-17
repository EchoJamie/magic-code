/**
 * `@magic/permission` —— 权限域公开面（技术方案 · 领域划分：权限域）。
 *
 * 职责：**裁决**——机械分析 · 危险分级 · 询问流转 · 度量（阶段 2 起加规则与「总是允许」记忆）。
 * 对外端口：**`PermissionGate`**（`decide(call, ctx) → Promise<Decision>` ＋
 * `resolve(requestId, decision)`）。
 *
 * 域纪律（技术方案 · 代码治理 · 领域划分）：
 * - **只依赖 `@magic/contracts`**——域之间互不 import、域不认知外壳与装配；
 * - **裁决独立**——不自证、不押模型自述：判定归**机械分析**（工具名 ＋ 参数）；
 * - **裁决过程只走事件、不入条目**——本域注入面无条目写权（`EventSink` 只有 `emit`）；
 * - **不碰文件系统**——故凡须「文件是否存在」才能判的形态一律归「看不懂」，按不可逆假定问。
 *
 * 出口四件：
 * ① **端口装配**——`createPermissionGate`；
 * ② **形态**——`PermissionGate` / `DecideOptions` / `CALL_REF_UNKNOWN`；
 * ③ **机械分析**——`analyze`（判定 ＋ 材料），供外壳预览与测试直取；
 * ④ **事件构造子**——两个 kind（装配与测试用）。
 *
 * 不出去的：命令分解表 · 路径边界判据 · 在途询问表（域内物）。
 */

// —— ② 形态 ——

export type { DecideOptions, PermissionGate, PermissionGateOptions } from './gate.ts'
export { CALL_REF_UNKNOWN } from './gate.ts'

// —— ① 端口装配 ——

export { createPermissionGate } from './gate.ts'

// —— ③ 机械分析 ——

export type { Analysis } from './analyze.ts'
export { analyze, unclassifiable } from './analyze.ts'

// —— ④ 事件构造子（信封由注入的 `EventStamper` 铸）——

export { decisionMade, decisionRequest } from './events.ts'
