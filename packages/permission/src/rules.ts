/**
 * 规则 —— 自动放行的**唯一**入口（技术方案 · 权限：规则化（阶段 2））。
 *
 * > 自动放行 ＝ 规则命中：条目 ＝（工具 × 路径模式 × 操作类型）→ 允许；
 * > **必闸类为禁区**——任何规则不可放行（清单即禁区）。「总是允许」＝会话级记忆；
 * > 持久规则存配置文件、用户维护（写回机制留后）。优先级：**必闸 ＞ 规则 ＞ 默认问**。
 *
 * 本文件只有**形态与解析**：持久规则从配置文件来（装配侧读文件、原样交给 `parseRules`）——
 * 本域**不碰文件系统**（域间只经契约），也不写回（「写回机制留后」）。
 *
 * **解析从严**：一条读不懂的规则**不生效**（而不是退化成更宽的规则）——
 * 误放行比多问一次更坏。被拒的条目连同缘由交回调用方（装配侧据以提示用户）。
 */

import type { PermissionContext } from '@magic/contracts'
import type { Landing } from './paths.ts'
import { expandPattern } from './paths.ts'
import { RULE_OPS, type RuleOp } from './ops.ts'

/**
 * 一条规则 —— （工具 × 路径模式 × 操作类型）→ 允许。
 *
 * - `tool`——工具名；`'*'` ＝任意工具。**必填**（其余两格缺省时它就是整条规则的全部）。
 * - `path`——路径模式（`*` 段内 · `**` 跨段 · `?` 单字符）；**缺省＝根内**（工作区内）。
 *   相对模式按**默认根**展开（与越界判据同源：相对按默认根 · 绝对须落根内）。
 * - `op`——操作类型（单个或一组）；**缺省＝任意**。给的是一组时，本次调用的**每一个**
 *   操作类型都要在组里才算命中（规则声明的是「这一类调用整体放行」）。
 */
export type PermissionRule = {
  readonly tool: string
  readonly path?: string
  readonly op?: RuleOp | readonly RuleOp[]
}

/** 被拒的条目——`index` ＝ 它在配置数组里的位置（`-1` ＝整个值就不是数组）。 */
export type RuleProblem = {
  readonly index: number
  readonly reason: string
}

/** 解析结果——收下的规则 ＋ 被拒的条目（**且缘由**：静默丢弃会让人对着不生效的规则发呆）。 */
export type RuleParseResult = {
  readonly rules: readonly PermissionRule[]
  readonly rejected: readonly RuleProblem[]
}

/** 条目认得的键——不认得的键**不收**（`pth` 写了不等于没写）。 */
const RULE_KEYS: readonly string[] = ['tool', 'path', 'op']

/**
 * 解析配置里的权限规则（**只读**——本域不写回）。
 *
 * 入参是**配置里那一段的原值**（`unknown`）：形状不对＝整体拒绝，逐条不对＝逐条拒绝；
 * 两种情形都返回**空规则 ＋ 缘由**，于是「没有规则」＝照旧问（从严方向）。
 */
export function parseRules(raw: unknown): RuleParseResult {
  const entries: readonly unknown[] = Array.isArray(raw) ? raw : []
  if (!Array.isArray(raw)) {
    return { rules: [], rejected: [{ index: -1, reason: '权限规则须是数组（一条规则一个条目）' }] }
  }

  const rules: PermissionRule[] = []
  const rejected: RuleProblem[] = []

  entries.forEach((entry, index) => {
    const reason = problemOf(entry)
    if (reason !== undefined) {
      rejected.push({ index, reason })
      return
    }
    rules.push(toRule(entry as Record<string, unknown>))
  })

  return { rules, rejected }
}

/** 逐条校验——`undefined` ＝收下；否则是拒绝缘由。 */
function problemOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return '条目须是对象（形如 { tool, path?, op? }）'
  }

  const fields = entry as Record<string, unknown>

  const strange = Object.keys(fields).filter((key) => !RULE_KEYS.includes(key))
  if (strange.length > 0) {
    return `不认识的键「${strange.join(' / ')}」——写错的键名不会被猜中（从严不收）`
  }

  if (!nonEmptyString(fields['tool'])) {
    return '缺工具名（`tool` 须是非空字符串；`\'*\'` ＝任意工具）'
  }

  const path = fields['path']
  if (path !== undefined && !nonEmptyString(path)) {
    return '路径模式须是非空字符串'
  }

  const op = fields['op']
  if (op !== undefined) {
    const list = Array.isArray(op) ? op : [op]
    if (list.length === 0) return '操作类型给了空的一组'
    for (const candidate of list) {
      if (typeof candidate !== 'string' || !RULE_OPS.includes(candidate as RuleOp)) {
        return `操作类型「${String(candidate)}」不在词表里（${RULE_OPS.join(' · ')}）`
      }
    }
  }

  return undefined
}

/** 校验过的条目 → 规则（空格归一，缺省的两格留空）。 */
function toRule(fields: Record<string, unknown>): PermissionRule {
  const tool = (fields['tool'] as string).trim()
  const path = fields['path']
  const op = fields['op']

  return {
    tool,
    ...(typeof path === 'string' ? { path: path.trim() } : {}),
    // 给单值就给单值、给一组就给一组——**原样**（不替用户归一：写下的形态看得见）
    ...(op === undefined ? {} : { op: op as RuleOp | readonly RuleOp[] }),
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

// ══ 匹配 ══════════════════════════════════════════════════════════════

/**
 * 一次调用的**面**——规则三格都照它比对。
 *
 * **由 `analyze` 一处产出**（工具名 ＋ `Analysis.ops` ＋ `Analysis.landings`）：
 * 规则匹配与危险判定读的是同一份分析结论，两条路径因此**结构上无从分叉**。
 */
export type CallFace = {
  readonly tool: string
  readonly ops: readonly RuleOp[]
  readonly landings: readonly Landing[]
}

/**
 * 命中的**第一条**规则（按声明次序；`undefined` ＝一条都不命中）。
 *
 * ⚠️ 本函数**不看** `Analysis.weight`——禁区否决是调用方（`gate`）的下一步。
 * 分开写是要让「规则说放 ≠ 放行」这层看得见：命中只说明**规则这一关**过了。
 */
export function matchRule(
  rules: readonly PermissionRule[],
  face: CallFace,
  ctx: PermissionContext,
): PermissionRule | undefined {
  return rules.find((rule) => matches(rule, face, ctx))
}

function matches(rule: PermissionRule, face: CallFace, ctx: PermissionContext): boolean {
  if (rule.tool !== '*' && rule.tool !== face.tool) return false
  if (!coversOps(rule.op, face.ops)) return false
  return matchesPath(rule.path, face.landings, ctx)
}

/**
 * 操作类型一格——缺省＝任意；给了就要求**覆盖本次调用的全部**。
 *
 * 「覆盖全部」而不是「中一个算一个」：规则声明的是「这一类调用整体放行」，
 * 只要本次调用里有一段不在规则声明的类型里，这次调用就还没被规则覆盖。
 * （`ls && rm -rf build` 里的 `rm` 恰恰是复合命令最容易藏住的那一段。）
 */
function coversOps(declared: RuleOp | readonly RuleOp[] | undefined, ops: readonly RuleOp[]): boolean {
  if (declared === undefined) return true
  const allowed = Array.isArray(declared) ? declared : [declared]
  return ops.every((op) => allowed.includes(op))
}

/**
 * 路径一格——**缺省＝根内**（工作区内）；写了模式＝至少一条影响面被命中。
 *
 * 缺省取「根内」而不是「任意」：用户不写路径时的意图是「我这摊子里的这类事别问了」，
 * 而不是「机器上哪儿都行」；根外留给每次显式确认（要放行就写明，见 `PermissionRule`）。
 *
 * 没有影响面词条的调用（只读命令——本域只收写 / 删 / 移的路径词条）**不受本格约束**：
 * 它压根没碰路径。这与必闸清单的越界条目限「工作区外的**写 / 删 / 移**」同一姿态。
 */
function matchesPath(
  pattern: string | undefined,
  landings: readonly Landing[],
  ctx: PermissionContext,
): boolean {
  if (pattern === undefined) return landings.every((landing) => landing.inside)
  if (landings.length === 0) return false

  const regex = globToRegExp(expandPattern(pattern, ctx))
  // 判不出落点的词条（`~` 前缀）不参与命中——判不出就不放行
  return landings.some((landing) => landing.absolute !== undefined && regex.test(landing.absolute))
}

/**
 * 路径模式 → 正则：`**` 跨段 · `*` 段内 · `?` 单字符。
 *
 * 不取件（本包只依赖契约），也不是 shell 通配的全集——够写规则即可：
 * 其余字符一律按字面处理（`.git` 里的点不会变成「任意字符」）。
 */
function globToRegExp(pattern: string): RegExp {
  let source = ''
  let index = 0

  while (index < pattern.length) {
    const char = pattern[index] ?? ''

    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*'
      index += 2
      continue
    }
    if (char === '*') {
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    index += 1
  }

  return new RegExp(`^${source}$`)
}

/** 规则的短描述——材料里报「是哪一条命中的」（用户对得上自己写的那一行）。 */
export function describeRule(rule: PermissionRule): string {
  const tool = rule.tool === '*' ? '任意工具' : `工具 ${rule.tool}`
  const path = rule.path === undefined ? '根内' : `路径 ${rule.path}`
  const ops =
    rule.op === undefined
      ? '任意操作'
      : `操作 ${(Array.isArray(rule.op) ? rule.op : [rule.op]).join(' / ')}`

  return `${tool} × ${path} × ${ops}`
}
