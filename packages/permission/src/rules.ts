/**
 * 规则 —— 自动放行的**唯一**入口（技术方案 · 权限：规则化（阶段 2））。
 *
 * > 自动放行 ＝ 规则命中：条目 ＝（工具 × 路径模式 × 操作类型 × 域名）→ 允许；
 * > **必闸类为禁区**——任何规则不可放行（清单即禁区）。「总是允许」＝**工作区级授权**
 * > （见 `grants.ts`）；持久规则存配置文件、用户维护（写回机制留后）。
 *
 * **优先级链一次留全**（技术方案 · 权限「授权的落点」）：
 * **必闸禁区 ＞ 项目规约（留缝不实现） ＞ 用户手写规则 ＞ 点出来的授权 ＞ 默认问**
 * ——本文件是「用户手写规则」那一格（`parseRules`），授权那一格在 `grants.ts`，
 * 次序由 `gate.ts` 一处落定。
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
 * 一条规则 —— （工具 × 路径模式 × 操作类型 × **域名**）→ 允许。
 *
 * - `tool`——工具名；`'*'` ＝任意工具。**必填**（其余几格缺省时它就是整条规则的全部）。
 * - `path`——路径模式（`*` 段内 · `**` 跨段 · `?` 单字符）；**缺省＝根内**（工作区内）。
 *   相对模式按**默认根**展开（与越界判据同源：相对按默认根 · 绝对须落根内）。
 * - `op`——操作类型（单个或一组）；**缺省＝任意**。给的是一组时，本次调用的**每一个**
 *   操作类型都要在组里才算命中（规则声明的是「这一类调用整体放行」）。
 * - `host`（U72）——**域名**模式（`*` 段内 · `?` 单字符；同 `globToRegExp` 那套写法，
 *   如 `*.example.com`）。只有「取网页」那一件带得出这一格（见 `analyzeWebFetch`）。
 *   ⚠️ **这一次调用有域名时，不写 `host` 的规则一律不命中**——见 `matchesHost`。
 */
export type PermissionRule = {
  readonly tool: string
  readonly path?: string
  readonly op?: RuleOp | readonly RuleOp[]
  readonly host?: string
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
const RULE_KEYS: readonly string[] = ['tool', 'path', 'op', 'host']

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

/**
 * **一条**规则条目的校验 ＋ 归一——`parseRules` 与授权文件（`grants.ts`）共用这一处。
 *
 * 两处各写一遍校验＝两套「什么算合格的规则」；授权是从**同一个三格**凝出来的
 * （工具 × 路径 × 操作），形态上没有第二套可说。
 *
 * ⚠️ 授权条目还带记账的那几个键（`grantedAt` / `lastHitAt` / `hits`）——**取用方先摘掉它们**
 * 再递进来（见 `grants.ts`）：本函数**不认识**它们，塞进来会被当成「不认识的键」拒掉
 * （那正是从严该有的样子——写错键名不会被猜中）。
 */
export function readRuleEntry(entry: unknown): { readonly rule: PermissionRule } | { readonly reason: string } {
  const reason = problemOf(entry)
  return reason === undefined
    ? { rule: toRule(entry as Record<string, unknown>) }
    : { reason }
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

  // 域名模式（U72）——与路径同一姿态：给了就得是个像样的字符串（空串不猜、不扩成通配）
  const host = fields['host']
  if (host !== undefined && !nonEmptyString(host)) {
    return '域名模式须是非空字符串'
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
  const host = fields['host']

  return {
    tool,
    ...(typeof path === 'string' ? { path: path.trim() } : {}),
    // 给单值就给单值、给一组就给一组——**原样**（不替用户归一：写下的形态看得见）
    ...(op === undefined ? {} : { op: op as RuleOp | readonly RuleOp[] }),
    // 域名归一成小写（域名本就不分大小写；`webTargetOf` 那一侧也已经小写）
    ...(typeof host === 'string' ? { host: host.trim().toLowerCase() } : {}),
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
  /**
   * **这一次发往哪个域名**（U72）——`Analysis.host` 原样过来（缺省＝这一次没有域名这一维）。
   *
   * 与 `landings` 分开两位，而不是把域名混进落点词条里：落点那一套从头到尾说的是
   * 「在**工作区**的哪儿」（`inside` 判根内根外、`expandPattern` 按默认根展开），
   * 而域名不在任何根里——混进去之后，`matchesPath` 那条「缺省＝根内」的语义
   * 会顺带决定「域名缺省怎么办」，两件事在一格里各说各的（正是 `PermissionRule`
   * 那条「路径模式与域名各判各的」）。
   */
  readonly host?: string
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
  if (!matchesHost(rule.host, face)) return false
  return matchesPath(rule.path, face.landings, ctx)
}

/**
 * 域名一格——**缺省只在「这一次没有域名」时才是「不过问」**。
 *
 * 两种缺省各说一件事：
 * - **调用这一侧没有域名**（既有那些工具）⇒ 域名格对它**恒真**：这一维根本不存在，
 *   规则写不写 `host` 都不该影响它（既有那一批规则一字不动）；
 * - **调用这一侧有域名、规则没写** ⇒ **不命中**。
 *
 * ## 为什么是「不命中」而不是「缺省＝任意域名」
 *
 * 这一件是**必闸类**（外发）。「必闸类优先于任何允许规则」那条不许被一句没写全的规则
 * 掏空——`{ tool: 'web_fetch' }`（或 `'*'`）若算作「任意域名都放行」，用户随手写的一条
 * 宽规则就让**往后的每一次取网**都不再问，包括从没见过的域名。要求写下域名，等于要求
 * 用户把「往哪一家发」这一件**明确说出口**——那正是「总是允许按域名给」的意思
 * （设计 · 网页与搜索；`analyzeWebFetch` 有一整段）。
 *
 * ⚠️ 这与**路径**那一格的缺省（`path === undefined` ＝「根内」）不矛盾：那一格的缺省收窄，
 * 是因为「用户不写路径」的意图本就落在自己那摊子里；域名这一维则**没有**这样一个安全的
 * 默认值——「随便哪家都行」恰恰是唯一不能默认的那一种。
 *
 * 写法同路径：`*` 段内 · `?` 单字符（`globToRegExp` 一处供两个轴用），其余字面。
 * 域名不分大小写，故两边都比小写。
 */
function matchesHost(declared: string | undefined, face: CallFace): boolean {
  if (face.host === undefined) return true
  if (declared === undefined) return false

  return globToRegExp(declared).test(face.host.toLowerCase())
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
 *
 * **落点认两种写法**（U22 · 声明原形）——模式只展开一种（默认根的规范形，见 `expandPattern`），
 * 而落点带着它的两种写法（`Landing.forms`）：**任一种命中即算命中**。于是「用户写 `src/**`、
 * 模型给 `/tmp/proj/src/x`」与「用户写 `/tmp/proj/**`、落点是规范形」两条路都通——
 * 规则怎么写都行，认不认得出是**落点**那一侧的事。
 */
function matchesPath(
  pattern: string | undefined,
  landings: readonly Landing[],
  ctx: PermissionContext,
): boolean {
  if (pattern === undefined) return landings.every((landing) => landing.inside)
  if (landings.length === 0) return false

  const regex = globToRegExp(expandPattern(pattern, ctx))
  // 判不出落点的词条（`~` 前缀）不参与命中——判不出就不放行（`forms` 为空，自然不中）
  return landings.some((landing) => landing.forms.some((form) => regex.test(form)))
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

  // 域名那一格**只在写了时才报**（U72）：缺省那一位在「取网页」上等于**不命中**
  // （见 `matchesHost`），报成「任意域名」会正好说反——那一行是用户对账用的，不能说反。
  const host = rule.host === undefined ? '' : ` × 域名 ${rule.host}`

  return `${tool} × ${path} × ${ops}${host}`
}
