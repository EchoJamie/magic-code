/**
 * 搜索与列目录工具 —— `grep` · `glob` · `ls`（工具集 v1 之三）。
 *
 * 出处：技术方案 · 工具「工具集 v1」——`grep` 内容搜索（正则 · 输出截断）· `glob` 文件名匹配 ·
 * `ls` 列目录。三件都落在沙箱的**一条**匹配底上（`match`：grep / glob 共用底——技术方案 · 执行）
 * 与 `list`；本域只做两件：**把参数摆对**、**把结果摆成模型读得懂的文本**。
 *
 * `SEARCH_MAX_RESULTS` 为什么由本域显式给：与 `exec` 的超时 / 输出上限同一条理由
 * （`exec-tool.ts` 头注）——「一次搜索最多看多少条」是**工具的行为**，不是沙箱的私事；
 * 显式交出去，换一个沙箱实现（远端 / 托管）也不会悄悄变口径。
 */

import type { ListEntry, MatchHit } from '@magic/contracts'
import { isText } from './args.ts'
import {
  cappedOutput,
  OUTPUT_EMPTY_DIR,
  OUTPUT_NO_MATCH,
  OUTPUT_PATH_REQUIRED,
  OUTPUT_PATTERN_REQUIRED,
  searchFailedOutput,
} from './messages.ts'
import type { ToolDefinition, ToolRunContext, ToolRunResult } from './registry.ts'
import { refused, reasonOf, rowOf } from './toolkit.ts'

/** 命中上限——条（实现级常量；`grep` 的「输出截断」按它）。 */
export const SEARCH_MAX_RESULTS = 200

// ══ 参数模式（自写朴素 JSON Schema——承载形态见契约「参数键」注）═══════

/** `grep` / `glob` 共用的两个键（模式 ＋ 起点）。 */
const PATTERN_KEY = {
  type: 'string',
  description: '搜索模式（grep 是正则；glob 是文件名模式）',
} as const

const SCOPE_KEY = {
  type: 'string',
  description: '搜索起点——相对按工作区默认根；绝对路径须落在工作区内；缺省＝工作区根',
} as const

export const GREP_PARAMETERS = {
  type: 'object',
  description:
    '按正则搜索文件内容（逐行匹配，命中给「路径:行号: 该行原文」）。递归搜索；跳过 .git 与 node_modules；命中数有上限。',
  properties: {
    pattern: { ...PATTERN_KEY, description: 'JavaScript 正则（不是 glob 模式）' },
    path: SCOPE_KEY,
  },
  required: ['pattern'],
  additionalProperties: false,
} as const

export const GLOB_PARAMETERS = {
  type: 'object',
  description:
    '按文件名匹配（`*` 不跨目录、`**` 递归——如 `**/*.ts`）。只列文件，不列目录；结果有上限。',
  properties: {
    pattern: { ...PATTERN_KEY, description: 'glob 模式（`**` 递归；如 `**/*.ts`）' },
    path: SCOPE_KEY,
  },
  required: ['pattern'],
  additionalProperties: false,
} as const

export const LS_PARAMETERS = {
  type: 'object',
  description: '列目录——目录带尾斜杠，文件带字节数。',
  properties: {
    path: {
      type: 'string',
      description: '目录路径——相对按工作区默认根；绝对路径须落在工作区内；缺省＝工作区根',
    },
  },
  required: [],
  additionalProperties: false,
} as const

// ══ 结果成文 ══════════════════════════════════════════════════════════

/**
 * 命中摆成文本——grep 给「路径:行号: 原文」（`编译器诊断` 的经典形状，模型见得最多），
 * glob 只有路径。
 *
 * 取满上限时**不假装完整**：明说「可能还有更多」——模型据此收窄模式，而不是拿一份
 * 被截断的清单当全集（超长的 `read` 同理，两者是同一条诚实）。
 */
function composeHits(hits: readonly MatchHit[], limit: number): string {
  if (hits.length === 0) return OUTPUT_NO_MATCH

  const lines = hits.map((hit) =>
    hit.line === undefined ? hit.path : `${hit.path}:${hit.line}: ${hit.text ?? ''}`,
  )

  const body = lines.join('\n')
  return hits.length >= limit ? `${body}\n${cappedOutput(limit)}` : body
}

/** 列目录摆成文本——目录带尾斜杠（一眼分辨能不能进去），文件带字节数（值不值得读）。 */
function composeLs(entries: readonly ListEntry[]): string {
  if (entries.length === 0) return OUTPUT_EMPTY_DIR

  return entries
    .map((entry) => {
      if (entry.kind === 'directory') return `${entry.name}/`
      if (entry.kind === 'other') return `${entry.name}  (其他)`

      // 文件，或类型位缺席（替身桩）——给了尺寸就带上
      return entry.size === undefined ? entry.name : `${entry.name}  (${entry.size} 字节)`
    })
    .join('\n')
}

// ══ 定义 ══════════════════════════════════════════════════════════════

/** `grep` / `glob` 的执行体只差一个判别式——同一条路。 */
async function runSearch(
  args: Readonly<Record<string, unknown>>,
  ctx: ToolRunContext,
  mode: 'grep' | 'glob',
): Promise<ToolRunResult> {
  const pattern = args['pattern']
  if (!isText(pattern)) return refused(OUTPUT_PATTERN_REQUIRED)

  const scope = args['path']
  if (scope !== undefined && !isText(scope)) return refused(OUTPUT_PATH_REQUIRED)

  try {
    const hits = await ctx.sandbox.match(pattern, {
      mode,
      path: scope,
      maxResults: SEARCH_MAX_RESULTS,
      signal: ctx.signal,
    })
    return { ok: true, output: composeHits(hits, SEARCH_MAX_RESULTS) }
  } catch (error) {
    return refused(searchFailedOutput(reasonOf(error)))
  }
}

/** 造 `grep` 的工具定义。 */
export function defineGrepTool(): ToolDefinition {
  const row = rowOf('grep')

  return {
    spec: { name: row.name, summary: row.summary, parameters: GREP_PARAMETERS, danger: row.danger },
    run: (args, ctx) => runSearch(args, ctx, 'grep'),
  }
}

/** 造 `glob` 的工具定义。 */
export function defineGlobTool(): ToolDefinition {
  const row = rowOf('glob')

  return {
    spec: { name: row.name, summary: row.summary, parameters: GLOB_PARAMETERS, danger: row.danger },
    run: (args, ctx) => runSearch(args, ctx, 'glob'),
  }
}

/** 造 `ls` 的工具定义。 */
export function defineLsTool(): ToolDefinition {
  const row = rowOf('ls')

  return {
    spec: { name: row.name, summary: row.summary, parameters: LS_PARAMETERS, danger: row.danger },

    async run(args, ctx): Promise<ToolRunResult> {
      const scope = args['path']
      if (scope !== undefined && !isText(scope)) return refused(OUTPUT_PATH_REQUIRED)

      try {
        // 缺省＝工作区默认根——「.」按默认根解析（与沙箱 `match` 的起点缺省同一姿势）
        return { ok: true, output: composeLs(await ctx.sandbox.list(scope ?? '.')) }
      } catch (error) {
        // ⚠️ **这一支不加前缀**（与上面 `grep` / `glob` 那一支不同）——列目录归**文件类**：
        // 沙箱那句 `列目录失败（path）：目录不存在` 已是一整句，本域再缀一次就是
        // 「列目录失败：列目录失败（…）：…」（U83 · D41）。搜索那两支的措辞本单不动。
        return refused(reasonOf(error))
      }
    },
  }
}
