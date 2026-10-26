/**
 * `@magic/permission` —— 权限域公开面（U129 · 默认放行与禁止清单）。
 *
 * 职责：**只控禁止**。默认放行；禁止清单只剩
 * `rm` / `shred` / `srm` 那族（拒并指路 `trash`）与 `su`（拒）。
 * `sudo` 走专用认证，但形状不合格的直接拒（多行、`sh -c`、here-doc、解释器或脚本）。
 *
 * 域纪律（技术方案 · 代码治理 · 领域划分）：
 * - **只依赖 `@magic/contracts`**——域之间互不 import、域不认知外壳与装配；
 * - **裁决独立**——不自证、不押模型自述：判定归**机械分析**（工具名 ＋ 参数）；
 * - **裁决过程只走事件、不入条目**——本域注入面无条目写权（`EventSink` 只有 `emit`）；
 * - **不碰文件系统**——只看命令字面。
 *
 * 出口三件：
 * ① **端口装配**——`createPermissionGate`；
 * ② **形态**——`PermissionGate`；
 * ③ **机械分析**——`analyze` / `refusalOf` / `refusalDetailOf` / `sudoPlanOf`，
 *    供工具域与测试直取。
 */

// —— ② 形态 ——

export type { PermissionGate, PermissionGateOptions } from './gate.ts'

// —— ① 端口装配 ——

export { createPermissionGate } from './gate.ts'

// —— ③ 机械分析 ——

export type { Analysis } from './analyze.ts'
export { analyze, refusalDetailOf, refusalOf, sudoPlanOf } from './analyze.ts'

// —— 事件构造子（审计用）——

export { decisionMade } from './events.ts'
