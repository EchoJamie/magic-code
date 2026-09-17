/**
 * 文件类工具 —— `read` · `write` · `edit`（工具集 v1 之三）。
 *
 * 出处：技术方案 · 工具「工具集 v1（阶段 2 · 规格）」——
 * `read` 读文件（超长截断）· `write` 新建 / 整写文件 · `edit` 串替换增量编辑（唯一定位 · 失配即报）。
 *
 * 三件共同的形态（与 `exec-tool.ts` 同一姿势）：
 * - **规格的静态三件取自契约 `TOOLSET_V1` 的冻结行**（经 `rowOf`——本域不另抄一份），
 *   只有**参数模式**与**执行体**在本文件；
 * - **执行一律经沙箱**（内核不直碰文件系统），路径解析与越界拒绝归执行域；
 * - **失败以 `ok:false` 回填**——沙箱四原语的冻签名载不下失败位（见契约 `ports.ts`），
 *   它们以**抛**表达失败；「错误＝返回值」这一条就落在这里：捕之、翻成模型读得懂的一句话。
 *
 * 一处刻意的**不猜**：`edit` 的「唯一」是全部语义——找不到、找到多处，都**不动文件**并照实报。
 */

import type { ReadResult } from '@magic/contracts'
import { isText } from './args.ts'
import { byteLength } from './blobs.ts'
import {
  editDoneOutput,
  editFailedOutput,
  OUTPUT_CONTENT_REQUIRED,
  OUTPUT_EDIT_AMBIGUOUS,
  OUTPUT_EDIT_NOT_FOUND,
  OUTPUT_EDIT_SAME,
  OUTPUT_EDIT_TRUNCATED,
  OUTPUT_FILE_EMPTY,
  OUTPUT_NEW_REQUIRED,
  OUTPUT_OLD_REQUIRED,
  OUTPUT_PATH_REQUIRED,
  OUTPUT_READ_TRUNCATED,
  readFailedOutput,
  writeDoneOutput,
  writeFailedOutput,
} from './messages.ts'
import type { ToolDefinition, ToolRunResult } from './registry.ts'
import { refused, reasonOf, rowOf } from './toolkit.ts'

// ══ read ══════════════════════════════════════════════════════════════

/**
 * 参数模式——**命令之外的键名也锚在契约里**（技术方案 · 工具 · 参数键：随 U13 定）。
 * 模式写一份朴素的 JSON Schema（`JsonSchema` 的承载形态＝自写、不取件）：送得出去、
 * 也读得懂，不赌任何库。`description` 是给模型读的——它就是「这个键怎么用」的说明书。
 */
export const READ_PARAMETERS = {
  type: 'object',
  description: '读一个文件。内容超长会被截断（只读到前一段）。',
  properties: {
    path: {
      type: 'string',
      description: '文件路径——相对按工作区默认根；绝对路径须落在工作区内',
    },
  },
  required: ['path'],
  additionalProperties: false,
} as const

/** 读到的内容摆成面向模型的文本（空文件与截断都**明说**——空输出会被当成失败）。 */
function composeRead(result: ReadResult): string {
  const body = result.content === '' ? OUTPUT_FILE_EMPTY : result.content
  if (result.truncated !== true) return body

  // 截断说明自成一行——正文不以换行收尾时先补一个，免得注与末行黏成一句
  return (body.endsWith('\n') ? body : `${body}\n`) + OUTPUT_READ_TRUNCATED
}

/** 造 `read` 的工具定义。 */
export function defineReadTool(): ToolDefinition {
  const row = rowOf('read')

  return {
    spec: { name: row.name, summary: row.summary, parameters: READ_PARAMETERS, danger: row.danger },

    async run(args, ctx): Promise<ToolRunResult> {
      const path = args['path']
      if (!isText(path)) return refused(OUTPUT_PATH_REQUIRED)

      try {
        return { ok: true, output: composeRead(await ctx.sandbox.read(path)) }
      } catch (error) {
        return refused(readFailedOutput(reasonOf(error)))
      }
    },
  }
}

// ══ write ═════════════════════════════════════════════════════════════

export const WRITE_PARAMETERS = {
  type: 'object',
  description:
    '新建或整写一个文件（**覆盖**已有内容，不是追加）。覆盖是必闸操作。不会自动建上级目录。',
  properties: {
    path: {
      type: 'string',
      description: '文件路径——相对按工作区默认根；绝对路径须落在工作区内',
    },
    content: {
      type: 'string',
      description: '文件内容——整写（不是追加）；空串＝写一个空文件',
    },
  },
  required: ['path', 'content'],
  additionalProperties: false,
} as const

/**
 * 造 `write` 的工具定义。
 *
 * **危险归类＝按调用判定**（契约冻结行：新建＝轻；覆盖＝必闸）——本域只声明，
 * 「这一次到底是新建还是覆盖」由**权限域**在调用时判（`by-call` 支）。
 * 本域不做那个判断：做了就等于把闸门的结论提前塞进执行体，而闸门在 `invoke` 路径内、
 * 不可绕过（技术方案 · 工具域规则）。
 */
export function defineWriteTool(): ToolDefinition {
  const row = rowOf('write')

  return {
    spec: { name: row.name, summary: row.summary, parameters: WRITE_PARAMETERS, danger: row.danger },

    async run(args, ctx): Promise<ToolRunResult> {
      const path = args['path']
      if (!isText(path)) return refused(OUTPUT_PATH_REQUIRED)

      const content = args['content']
      // 空串合法（写空文件）——故判据是「是不是字符串」，不是「非空」
      if (typeof content !== 'string') return refused(OUTPUT_CONTENT_REQUIRED)

      try {
        await ctx.sandbox.write(path, { text: content })
        return { ok: true, output: writeDoneOutput(path, byteLength(content)) }
      } catch (error) {
        return refused(writeFailedOutput(reasonOf(error)))
      }
    },
  }
}

// ══ edit ══════════════════════════════════════════════════════════════

export const EDIT_PARAMETERS = {
  type: 'object',
  description:
    '串替换编辑：old 必须在文件中**唯一**出现，否则整个调用不改动文件并报错（要改多处就先给足上下文、逐个改）。',
  properties: {
    path: {
      type: 'string',
      description: '文件路径——相对按工作区默认根；绝对路径须落在工作区内',
    },
    old: {
      type: 'string',
      description: '待替换的原文——须在文件中唯一出现（含缩进与换行，逐字符比对）',
    },
    new: {
      type: 'string',
      description: '替换为——空串＝删除该段',
    },
  },
  required: ['path', 'old', 'new'],
  additionalProperties: false,
} as const

/** 出现次数——逐字扫描（**不用正则**：`old` 里的元字符是字面量，不是模式）。 */
function countOccurrences(text: string, needle: string): number {
  let count = 0
  let index = text.indexOf(needle)

  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }

  return count
}

/** 唯一命中处的替换——按位置拼（`String.replace` 会把替换串里的 `$&` / `$'` 当模式用）。 */
function replaceOnce(text: string, needle: string, replacement: string, index: number): string {
  return text.slice(0, index) + replacement + text.slice(index + needle.length)
}

/** 造 `edit` 的工具定义。 */
export function defineEditTool(): ToolDefinition {
  const row = rowOf('edit')

  return {
    spec: { name: row.name, summary: row.summary, parameters: EDIT_PARAMETERS, danger: row.danger },

    async run(args, ctx): Promise<ToolRunResult> {
      const path = args['path']
      if (!isText(path)) return refused(OUTPUT_PATH_REQUIRED)

      const old = args['old']
      if (!isText(old)) return refused(OUTPUT_OLD_REQUIRED)

      const replacement = args['new']
      if (typeof replacement !== 'string') return refused(OUTPUT_NEW_REQUIRED)
      if (replacement === old) return refused(OUTPUT_EDIT_SAME)

      try {
        const current = await ctx.sandbox.read(path)

        // 读到的是截断文本 ⇒ 改完写回去会抹掉文件尾巴。**先拒**——这是唯一一处
        // 「宁可做不成也不能做错」的分支（截断是沙箱的读取上限，不是文件的问题）。
        if (current.truncated === true) return refused(OUTPUT_EDIT_TRUNCATED)

        const count = countOccurrences(current.content, old)
        if (count === 0) return refused(OUTPUT_EDIT_NOT_FOUND)
        if (count > 1) return refused(`${OUTPUT_EDIT_AMBIGUOUS}（出现 ${count} 处）`)

        const index = current.content.indexOf(old)
        await ctx.sandbox.write(path, { text: replaceOnce(current.content, old, replacement, index) })

        return { ok: true, output: editDoneOutput(path) }
      } catch (error) {
        return refused(editFailedOutput(reasonOf(error)))
      }
    },
  }
}
