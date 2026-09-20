/**
 * 机械分析 —— 判定（该不该问）与呈现（怎么问）的**唯一入口**。
 *
 * 出处：技术方案 · 权限：判定 ＝ 内核的机械分析——工具调用是结构化的（工具名 ＋ 参数）：
 * 命令可解析、路径可比对工作区边界、读写类型天然可分；**不押模型自述**。
 * 姿态：不可逆从严、可逆从宽——**看不懂的形态按不可逆假定问**。
 *
 * 本域只做**域内机械分析**：不 import 执行域 / 工具域，不碰文件系统（域间只经契约）。
 * 故凡需「文件是否存在 / 内容是什么」才能判的形态（如 `write` 的新建 vs 覆盖），
 * 一律归入「看不懂」——按不可逆假定问。
 *
 * 阶段 1 全人工门：本节的产出**只定呈现轻重**（`weight`）与判断材料；阶段 2 起，
 * 必闸清单才是自动放行禁区（U14）。
 */

import type { DangerReason, DecisionWeight, PermissionContext, ToolCall } from '@magic/contracts'
import type { SegmentAnalysis } from './commands.ts'
import { OP_LABEL, OP_REASON, WRITE_OPS, decompose } from './commands.ts'
import type { RuleOp } from './ops.ts'
import type { Landing } from './paths.ts'
import { describeLanding, landPath } from './paths.ts'

/**
 * 一次调用的分析结论。
 *
 * - `weight: 'heavy'` ＝ 必闸类（技术方案 · 权限：危险分级 v0 必闸清单）——材料须给足判断依据；
 * - `weight: 'light'` ＝ 放行区方向（读与搜索 · 新建 · 增量编辑 · 只读命令）；
 * - `reason` 只在 `heavy` 时给——命中的必闸判据（`unknown` ＝看不懂）；
 * - `ops` / `landings` ＝ **规则轴**（阶段 2）：规则条目是（工具 × 路径模式 × 操作类型），
 *   后两格照这两个字段比对。它们与 `weight` **同一处产出**——规则匹配与危险判定读的是
 *   同一份结论，两条路径因此结构上无从分叉（必闸 ＞ 规则 ＞ 默认问）。
 */
export type Analysis = {
  readonly weight: DecisionWeight
  readonly reason?: DangerReason
  readonly material: string
  /** 本次调用的**操作类型**——多段命令取并集（每一段都算数）。 */
  readonly ops: readonly RuleOp[]
  /** **影响面词条**——路径模式的对照面（与越界判据同一处产出）。 */
  readonly landings: readonly Landing[]
}

/** 必闸判据的中文（材料用——呈现是给人的）。 */
const REASON_LABEL: Readonly<Record<DangerReason, string>> = {
  irreversible: '不可逆（收不回）',
  'out-of-bounds': '越界（工作区之外）',
  system: '系统级（机器全局 / 已装环境）',
  outbound: '外发（出去即收不回）',
  unknown: '看不懂（无法归类——按不可逆假定问）',
}

/** 判据的代表序——具体优先（越界 / 系统 / 外发 ＞ 不可逆 ＞ 看不懂）。 */
const REASON_ORDER: readonly DangerReason[] = [
  'out-of-bounds',
  'system',
  'outbound',
  'irreversible',
  'unknown',
]

/** 取代表判据（多中时按 `REASON_ORDER`）。 */
function representative(reasons: readonly DangerReason[]): DangerReason | undefined {
  return REASON_ORDER.find((reason) => reasons.includes(reason))
}

// —— 参数取值 ——

/**
 * 命令字段名——**单一键**（技术方案 · 工具：参数键部分锚定——`exec` 的命令字段名＝`cmd`）。
 * 取不到即从严（不再按候选键兜底：写错的键名不该被猜中）。
 */
const COMMAND_KEY = 'cmd'

/** 路径字段的候选键——`path` / `file` / `dir` 系的常见拼法（去分隔符后比对）。 */
function isPathKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '')
  return (
    normalized === 'path' ||
    normalized === 'filepath' ||
    normalized === 'file' ||
    normalized === 'filename' ||
    normalized === 'dir' ||
    normalized === 'dirname' ||
    normalized === 'directory' ||
    normalized === 'target' ||
    normalized === 'cwd' ||
    normalized === 'root' ||
    normalized.endsWith('path') ||
    normalized.endsWith('dir') ||
    normalized.endsWith('file')
  )
}

function firstString(
  args: Readonly<Record<string, unknown>>,
  match: (key: string) => boolean,
): { readonly key: string; readonly value: string } | undefined {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && match(key)) return { key, value }
  }
  return undefined
}

// —— 兜底：看不懂从严 ——

/**
 * 看不懂 —— 唯一的兜底出口。**按不可逆假定问**（技术方案 · 权限：危险分级 v0 末条）。
 *
 * 材料只陈述**为什么判不出**——不假装知道风险在哪；判断交给人。
 */
export function unclassifiable(tool: string, why: string): Analysis {
  return {
    weight: 'heavy',
    reason: 'unknown',
    material: [
      `工具：${tool}`,
      `判不出：${why}`,
      `处置：按不可逆假定问（${REASON_LABEL.unknown}）。`,
    ].join('\n'),
    ops: ['unknown'],
    landings: [],
  }
}

// —— 主入口 ——

/**
 * 分析一次工具调用。
 *
 * **兜底即从严**：分析表覆盖不到的形态一律 `heavy` · `reason: 'unknown'`——
 * 「漏判即按『看不懂』入单」（技术方案 · 权限：危险分级维护条）。
 *
 * 分析表**对标工具集 v1 的静态危险归类**（`ToolSpec.danger`）：静态归 `by-call` 的
 * （`exec` · `write`）在此**按调用落定**——这正是「按调用判定」的落点。
 */
export function analyze(call: ToolCall, ctx: PermissionContext): Analysis {
  // 参数都没解析出来，工具名与参数都不可信——最先归「看不懂」
  if (call.invalid === true) {
    return unclassifiable(call.name, '参数解析不出（模式不符 / JSON 残缺）——调用形态不可信')
  }

  switch (call.name) {
    case 'exec':
      return analyzeExec(call, ctx)
    case 'read':
    case 'grep':
    case 'glob':
    case 'ls':
      return analyzeSearch(call, ctx)
    case 'edit':
      return analyzeEdit(call, ctx)
    case 'write':
      return analyzeWrite(call, ctx)
    case 'skill':
      return analyzeSkill(call, ctx)
    default:
      return unclassifiable(call.name, `工具「${call.name}」不在机械分析表内`)
  }
}

/**
 * **技能读取**（`skill` · U33）——**只读材料，一律轻**。
 *
 * ⚠️ 这一格**必须显式写**（不能只靠 `ToolSpec.danger: 'light'` 声明）：
 * 分析表覆盖不到的形态一律兜底 `heavy`（「漏判即按看不懂入单」），
 * 而 `ToolSpec.danger` **不参与**这条判定——不写这一格，`skill` 每次调用都会弹卡。
 *
 * **为什么是轻**：它读的是**技能目录**（只读来源），不是工作区里的动作，
 * 与「放行区：读与搜索」同类。而**边界不由这一格担保**——能读哪些由工具入口
 * （`Skills` 端口）按已发现身份与来源内相对引用卡死：`..` 越出、绝对路径、
 * 软链接绕出去，在那边就拒了。闸门这一层只需要知道「这不是一次写动作」。
 *
 * **不收回执的落点**：不因为 `skill` 是「本单新加的」，就顺带放宽别的未知工具——
 * 兜底那一支一个字没动（`default` 仍是 `unclassifiable`）。
 *
 * **影响面词条**（`landings`）取 `source`（技能目录路径，模型给了才认）——
 * 它的用途是规则轴比对（工具 × 路径模式 × 操作类型），故照实给；给不出来就不给
 * （缺省＝只按名字取，那条路在工具入口里归位，不涉及「模型指了哪儿」）。
 * ⚠️ 技能目录**可能在**工作区之外（用户目录下的 `~/.magic/skills`）：`landPath`
 * 照旧算出 `inside: false`，但那**不构成越界必闸**——必闸清单的越界条目管的是
 * 「工作区外的**写 / 删 / 移**」，读材料不在此列（同 `analyzeSearch` 那条口径）。
 */
function analyzeSkill(call: ToolCall, ctx: PermissionContext): Analysis {
  const source = firstString(call.args, (key) => key === 'source')
  const path = firstString(call.args, (key) => key === 'name')

  const where =
    source === undefined
      ? '技能目录（按名字取，落点由工具入口按已发现的身份归位）'
      : `技能目录 ${source.value}`
  const what = path === undefined ? '技能材料' : `技能「${path.value}」的正文或引用`

  return {
    weight: 'light',
    material: [`读的是一份只读材料：${what}`, `来源：${where}`].join('\n'),
    ops: ['read'],
    landings: source === undefined ? [] : [landPath(source.value, ctx)],
  }
}

/**
 * **路径必填**的读类工具——照**参数键全表**（契约 · 工具：`read` —— `path`，
 * 而 `ls` / `grep` / `glob` 是 `path?`）。「缺席合不合法」只认这张表。
 */
const PATH_REQUIRED_TOOLS: readonly string[] = ['read']

/**
 * 「没给路径」的落点＝**默认根**——`.` 经 `landPath` 的「相对按默认根」正好归一出
 * 默认根本身，与执行域同一判据（不另造一条算法）。
 */
const DEFAULT_ROOT = '.'

/**
 * 读与搜索（`read` · `grep` · `glob` · `ls`）——**放行区方向，一律轻**。
 *
 * 读的**越界不闸**：必闸清单的越界条目限「**工作区外的写 / 删 / 移**」，
 * 而放行区明列「读与搜索」（技术方案 · 权限：放行区）。
 *
 * **没给路径**的形态（缺陷 D15）按**参数键全表**分两种——「可选键缺席即取缺省」是通则：
 * - `ls` / `grep` / `glob` 的 `path` **是可选键**，而缺省就是**默认根**
 *   （工具 schema 的说明一字不差：「缺省＝工作区根」）⇒ `ls {}`（列当前目录）是
 *   **合法且常见**的形态，仍归**轻**；
 * - `read` 的 `path` **是必填**——缺了就是模式不符的调用（工具那边回 `OUTPUT_PATH_REQUIRED`），
 *   此处**不假装知道落点** ⇒ 归「判不出」。
 *
 * ⇒「判不出」只留给**真正看不懂**的形态，不再兜住「没给参数」这种合法写法。
 */
function analyzeSearch(call: ToolCall, ctx: PermissionContext): Analysis {
  const path = firstString(call.args, isPathKey)

  if (path === undefined && PATH_REQUIRED_TOOLS.includes(call.name)) {
    return unclassifiable(call.name, `参数里缺必填的路径字段（参数键全表：${call.name} 的 path 必填）`)
  }

  const landing = landPath(path?.value ?? DEFAULT_ROOT, ctx)
  const material =
    path === undefined
      ? `影响面：${describeLanding(landing)}（调用没给路径——参数键全表：缺省＝默认根）`
      : `影响面：${describeLanding(landing)}`

  return { weight: 'light', material, ops: ['read'], landings: [landing] }
}

/** 增量编辑（`edit`）——放行区方向（diff 可审）；**但工作区外的写＝必闸**。 */
function analyzeEdit(call: ToolCall, ctx: PermissionContext): Analysis {
  const path = firstString(call.args, isPathKey)
  if (path === undefined) {
    return unclassifiable(call.name, '参数里找不到可判的路径字段（键名未锚定——见回报待决）')
  }

  const landing = landPath(path.value, ctx)
  if (landing.inside) {
    return { weight: 'light', material: `影响面：${describeLanding(landing)}`, ops: ['edit'], landings: [landing] }
  }

  return {
    weight: 'heavy',
    reason: 'out-of-bounds',
    material: impact([landing], '工作区外的写——越界即必闸（技术方案 · 权限：必闸清单 · 越界）'),
    ops: ['edit'],
    landings: [landing],
  }
}

/**
 * 整写（`write`）——静态归类 `by-call`：**新建＝轻；覆盖＝必闸**。
 *
 * ⚠️ 判不出：权限域**不碰文件系统**（域间只经契约、fs 边界归执行域），问不到「文件在不在」。
 * 故一律按**覆盖**假定——即「看不懂从严」（技术方案 · 权限：危险分级 v0 末条）。
 * 存在性若由调用方带进来（参数模式补 `overwrite` 之类），此处即可分流——见回报「待决」。
 */
function analyzeWrite(call: ToolCall, ctx: PermissionContext): Analysis {
  const path = firstString(call.args, isPathKey)
  if (path === undefined) {
    return unclassifiable(call.name, '参数里找不到可判的路径字段（键名未锚定——见回报待决）')
  }

  const landing = landPath(path.value, ctx)
  // 操作类型记 `overwrite`：按**覆盖**假定（判不出新建还是覆盖＝从严那一侧），
  // 故本格的显示与规则都按「整写」认它——待存在性进得来（见回报「待决」）再分流 `create`。
  const ops: readonly RuleOp[] = ['overwrite']

  if (!landing.inside) {
    return {
      weight: 'heavy',
      reason: 'out-of-bounds',
      material: impact([landing], '工作区外的写——越界即必闸（技术方案 · 权限：必闸清单 · 越界）'),
      ops,
      landings: [landing],
    }
  }

  return {
    weight: 'heavy',
    reason: 'unknown',
    material: [
      `影响面：${describeLanding(landing)}`,
      '判不出：新建还是覆盖——本域不碰文件系统，问不到存在性。',
      `处置：按不可逆假定问（覆盖＝必闸——工具集 v1：write 新建＝轻、覆盖＝必闸）。`,
    ].join('\n'),
    ops,
    landings: [landing],
  }
}

// —— exec ——

/**
 * 命令执行（`exec`）——静态归类 `by-call`：**按命令解析**。
 *
 * 逐段分解 → 归类 → 越界比对；多段取并集，**任一段入必闸即重**。
 */
function analyzeExec(call: ToolCall, ctx: PermissionContext): Analysis {
  const command = firstString(call.args, (key) => key === COMMAND_KEY)
  if (command === undefined) {
    return unclassifiable('exec', `参数里找不到命令字段（该字段名锚定为「${COMMAND_KEY}」）`)
  }

  const segments = decompose(command.value, ctx)
  return judge(segments)
}

/** 逐段裁决 → 轻重 ＋ 代表判据 ＋ 命令分解材料。 */
function judge(segments: readonly SegmentAnalysis[]): Analysis {
  const reasons: DangerReason[] = []

  for (const segment of segments) {
    const reason = OP_REASON[segment.op]
    if (reason !== undefined) reasons.push(reason)
    reasons.push(...segment.extra) // 一段多判据（如 `push --force` ＝ 外发 ＋ 不可逆）

    // 越界只对写 / 删 / 移生效（必闸清单 · 越界条目）
    if (WRITE_OPS.includes(segment.op) && segment.landings.some((landing) => !landing.inside)) {
      reasons.push('out-of-bounds')
    }
  }

  const reason = representative(reasons)
  const material = renderDecomposition(segments, reason === undefined ? [] : reasons)

  // 规则轴：操作类型取**并集**（每一段都算数——规则须覆盖全部才命中），
  // 影响面取各段词条之并
  const ops = [...new Set(segments.map((segment) => segment.op))]
  const landings = segments.flatMap((segment) => segment.landings)

  return reason === undefined
    ? { weight: 'light', material, ops, landings }
    : { weight: 'heavy', reason, material, ops, landings }
}

/** 命令分解 —— 重呈现的判断材料（逐段：做了什么 · 影响面）。 */
function renderDecomposition(
  segments: readonly SegmentAnalysis[],
  reasons: readonly DangerReason[],
): string {
  const lines = [`命令分解（${segments.length} 段）：`]

  segments.forEach((segment, index) => {
    lines.push(`  ${index + 1}. ${segment.raw} —— ${OP_LABEL[segment.op]}`)

    for (const landing of segment.landings) lines.push(`       影响面：${describeLanding(landing)}`)
    for (const note of segment.notes) lines.push(`       ${note}`)
  })

  const unique = REASON_ORDER.filter((candidate) => reasons.includes(candidate))
  if (unique.length > 0) {
    lines.push(`判据：${unique.map((candidate) => REASON_LABEL[candidate]).join(' · ')}`)
  }

  return lines.join('\n')
}

/** 单路径工具的影响面材料。 */
function impact(landings: readonly Landing[], why: string): string {
  return [`影响面：${landings.map(describeLanding).join('；')}`, `判据：${why}`].join('\n')
}
