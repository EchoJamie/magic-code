/**
 * 操作类型 —— 规则条目的第三格（技术方案 · 权限：条目＝工具 × 路径模式 × 操作类型）。
 *
 * **一处词表，两处用**：`analyze` 据它报出「这次调用在做什么」（`Analysis.ops`），
 * 规则解析据它校验用户写下的 `op`（`parseRules`）。两者同表，规则才谈得上对得上判定。
 *
 * 词表与命令分解的归类（`CommandOp`）同一套，另加工具轴上的 `edit`——
 * `write` 是整写（覆盖）、`edit` 是唯一定位串替换，两者不是一回事，不能并成一类，
 * 否则一条「放行增量编辑」的规则会顺手放掉整文件改写。
 */

import type { CommandOp } from './commands.ts'

/** 操作类型——命令分解的归类 ∪ 工具轴的增量编辑。 */
export type RuleOp = CommandOp | 'edit'

/** 词表（解析校验与拒绝缘由共用一处）。 */
export const RULE_OPS: readonly RuleOp[] = [
  'read', // 只读
  'create', // 新建
  'edit', // 增量编辑（唯一定位串替换）
  'overwrite', // 覆盖 / 整写
  'delete', // 删除
  'move', // 移动 / 重命名
  'system', // 提权 · 系统
  'outbound', // 外发
  'unknown', // 判不出
]
