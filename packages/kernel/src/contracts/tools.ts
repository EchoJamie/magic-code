/**
 * 工具接口 + 工具集 v1 规格 —— **工具契约**（已冻结）。
 *
 * 出处：技术方案 · 工具：机制与集。
 * 机制——工具定义（名称 · 描述 · 参数模式 · 危险归类 · 执行体经沙箱）· 注册进运行环境 ·
 * 定义随每次调用送模型；分发：模型请求 → 闸门 → 沙箱执行 → 结果回填。
 *
 * 本文件是**转写**：只落技术方案已冻结之名与结构，不加设计。
 * 阶段 1 集＝`exec`（经沙箱 · 工作目录约束）；工具集 v1 随阶段 2。
 */

// —— 危险归类 ——

/**
 * 必闸判据（危险分级 v0）——命中其一即须闸。
 *
 * TODO(规划侧)：技术方案 · 权限 · 危险分级 v0 的**必闸类清单**（删除覆盖 / 移动重命名 /
 * 破坏性 git / 提权系统 / 越界 / 外发）以「例」列示，未定其在代码中的归类粒度；
 * 此处只转写**判据**——归类粒度由 U07（权限闸门）与 U06（工具机制）落定后回正。
 */
export type DangerReason =
  | 'irreversible' // 不可逆（收不回）
  | 'out-of-bounds' // 越界（工作区之外）
  | 'system' // 系统级（机器全局 / 已装环境）
  | 'outbound' // 外发（出去即收不回）
  | 'unknown' // 看不懂（无法归类 → 按不可逆假定问）

/**
 * 危险归类——「轻」（放行区）或「必闸」。
 * 阶段 1 全人工门下，本节定**呈现轻重**；阶段 2 起，必闸清单＝自动放行禁区。
 */
export type DangerClass =
  | { readonly level: 'light' }
  | { readonly level: 'gated'; readonly reason?: DangerReason }

/** 工具集 v1 的一行规格。 */
export type ToolSpec = {
  readonly name: string
  readonly summary: string
  readonly danger: DangerClass
}

/**
 * 工具集 v1 规格（阶段 2 · 已冻结）——供并行实现。
 * 注：`write` 的归类**随调用而变**（新建＝轻；覆盖＝必闸）——条目取严，判定在调用时落定。
 */
export const TOOLSET_V1 = [
  { name: 'read', summary: '读文件（超长截断）', danger: { level: 'light' } },
  { name: 'write', summary: '新建 / 整写文件', danger: { level: 'gated' } },
  { name: 'edit', summary: '串替换增量编辑（唯一定位 · 失配即报）', danger: { level: 'light' } },
  { name: 'grep', summary: '内容搜索（正则 · 输出截断）', danger: { level: 'light' } },
  { name: 'glob', summary: '文件名匹配', danger: { level: 'light' } },
  { name: 'ls', summary: '列目录', danger: { level: 'light' } },
] as const satisfies readonly ToolSpec[]

// —— 工具定义 ——

/**
 * 参数模式。
 *
 * TODO(规划侧)：承载形态（自写 JSON Schema / 取件）未定；占位为可序列化的不透明模式。
 */
export type JsonSchema = Readonly<Record<string, unknown>>

/**
 * 执行体——经**沙箱**（不得直碰文件系统）。
 *
 * TODO(规划侧)：签名（入参 / 返回 / 与沙箱的接线）未定；占位如下。
 */
export type ToolExecute = (args: Readonly<Record<string, unknown>>) => Promise<unknown>

/** 工具定义——名称 · 描述 · 参数模式 · 危险归类 · 执行体（经沙箱）。 */
export type ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly danger: DangerClass
  readonly execute: ToolExecute
}
