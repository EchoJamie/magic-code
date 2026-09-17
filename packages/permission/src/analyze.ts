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
import type { Landing } from './paths.ts'
import { describeLanding, landPath } from './paths.ts'

/**
 * 一次调用的分析结论。
 *
 * - `weight: 'heavy'` ＝ 必闸类（技术方案 · 权限：危险分级 v0 必闸清单）——材料须给足判断依据；
 * - `weight: 'light'` ＝ 放行区方向（读与搜索 · 新建 · 增量编辑 · 只读命令）；
 * - `reason` 只在 `heavy` 时给——命中的必闸判据（`unknown` ＝看不懂）。
 */
export type Analysis = {
  readonly weight: DecisionWeight
  readonly reason?: DangerReason
  readonly material: string
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

/** 命令字段的候选键（工具集 v1 的参数模式未锚定——键名按惯例多选，全落空即从严）。 */
const COMMAND_KEYS = ['cmd', 'command', 'script', 'shell']

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
    default:
      return unclassifiable(call.name, `工具「${call.name}」不在机械分析表内`)
  }
}

/**
 * 读与搜索（`read` · `grep` · `glob` · `ls`）——**放行区方向，一律轻**。
 *
 * 读的**越界不闸**：必闸清单的越界条目限「**工作区外的写 / 删 / 移**」，
 * 而放行区明列「读与搜索」（技术方案 · 权限：放行区）。
 */
function analyzeSearch(call: ToolCall, ctx: PermissionContext): Analysis {
  const path = firstString(call.args, isPathKey)
  if (path === undefined) {
    return unclassifiable(call.name, '参数里找不到可判的路径字段（键名未锚定——见回报待决）')
  }

  const landing = landPath(path.value, ctx)
  return { weight: 'light', material: `影响面：${describeLanding(landing)}` }
}

/** 增量编辑（`edit`）——放行区方向（diff 可审）；**但工作区外的写＝必闸**。 */
function analyzeEdit(call: ToolCall, ctx: PermissionContext): Analysis {
  const path = firstString(call.args, isPathKey)
  if (path === undefined) {
    return unclassifiable(call.name, '参数里找不到可判的路径字段（键名未锚定——见回报待决）')
  }

  const landing = landPath(path.value, ctx)
  if (landing.inside) return { weight: 'light', material: `影响面：${describeLanding(landing)}` }

  return {
    weight: 'heavy',
    reason: 'out-of-bounds',
    material: impact([landing], '工作区外的写——越界即必闸（技术方案 · 权限：必闸清单 · 越界）'),
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
  if (!landing.inside) {
    return {
      weight: 'heavy',
      reason: 'out-of-bounds',
      material: impact([landing], '工作区外的写——越界即必闸（技术方案 · 权限：必闸清单 · 越界）'),
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
  }
}

// —— exec ——

/**
 * 命令执行（`exec`）——静态归类 `by-call`：**按命令解析**。
 *
 * 逐段分解 → 归类 → 越界比对；多段取并集，**任一段入必闸即重**。
 */
function analyzeExec(call: ToolCall, ctx: PermissionContext): Analysis {
  const command = firstString(call.args, (key) => COMMAND_KEYS.includes(key.toLowerCase()))
  if (command === undefined) {
    return unclassifiable('exec', `参数里找不到命令字段（候选：${COMMAND_KEYS.join(' / ')}）`)
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

  return reason === undefined
    ? { weight: 'light', material }
    : { weight: 'heavy', reason, material }
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
