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
 * - **失败形态分两路**（技术方案 · 执行 · 原语形态；契约 `Sandbox` 头注）——正常结果的失败
 *   （读到上限＝`truncated`）是**判别式**；**调用不成立**（越界 / 不存在 / 是否目录 / 无权限 /
 *   参数无效）沙箱侧**抛**，捕在**这里**、收敛成 `ToolResult` 的判别式（`ok:false` ＋ 一句话）。
 *
 * 一处刻意的**不猜**：`edit` 的「唯一」是全部语义——找不到、找到多处，都**不动文件**并照实报。
 */

import type { ReadResult } from '@magic/contracts'
import { isText } from './args.ts'
import { byteLength } from './blobs.ts'
import {
  editDoneOutput,
  editFailedOutput,
  editTooLargeOutput,
  OUTPUT_CONTENT_REQUIRED,
  OUTPUT_EDIT_AMBIGUOUS,
  OUTPUT_EDIT_NOT_FOUND,
  OUTPUT_EDIT_SAME,
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
      /**
       * ⚠️ **末一句是 U70 加的**：后台命令的输出文件落在**工作区之外**（运行目录下），
       * 而设计明写它「用既有的 `read` 读」（`exec` 的后台那一形第三格）。
       * 不加这一句，说明书与实情不符——**照说明书办事的模型会以为那条路径读不得**，
       * 于是「取输出」那一格在真实使用里先断在这一句上。
       *
       * 只写「读得到什么」，**不写它为什么在那儿**：那是设计的事，模型要的只是
       * 「这条路径能不能读」这一件。
       */
      description:
        '文件路径——相对按工作区默认根；绝对路径须落在工作区内' +
        '（后台命令的输出文件除外——那种路径直接给，读得到）',
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

/**
 * `edit` 的读取上限——**1 MiB**（实现级常量）。
 *
 * 为什么比沙箱缺省的 64 KiB 大：`edit` 走「读 → 改 → 写回」，按缺省读到的若是**截断文本**，
 * 原样写回就抹掉尾巴——上限小，闸门就得对**大文件**一律关门。放大到 1 MiB 让源码 / 配置
 * 这类文件都够得着；**仍超限才拒**（并指出 `exec` 这条出口）。
 *
 * 代价如实说：一次编辑最多在内存里拿 1 MiB 文本 ＋ 读一遍磁盘。对单机自用可接受。
 */
export const EDIT_MAX_READ_BYTES = 1024 * 1024

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
        // 显式放大读取上限（沙箱缺省 64 KiB 对源码文件偏小）——见 EDIT_MAX_READ_BYTES
        const current = await ctx.sandbox.read(path, { maxBytes: EDIT_MAX_READ_BYTES })

        // 放大之后**仍**截断 ⇒ 改完写回去会抹掉文件尾巴。**先拒**——这是唯一一处
        // 「宁可做不成也不能做错」的分支（截断是读取上限，不是文件的问题）。
        if (current.truncated === true) return refused(editTooLargeOutput(EDIT_MAX_READ_BYTES))

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
