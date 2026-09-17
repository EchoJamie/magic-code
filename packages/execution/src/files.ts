/**
 * 文件三原语 —— `read` · `write` · `list`（技术方案 · 执行「原语形态（决策级）」）。
 *
 * 与 `sandbox.ts` 的分工：那里管**路径与工作区**（解析 / 越界），本文件只看**文件**
 * ——进来时已是绝对路径（且已落根内）。
 *
 * 三件形态选择：
 * - **失败形态分两路**（技术方案 · 执行 · 原语形态；契约 `Sandbox` 头注）——
 *   **正常结果用判别式**（读到上限＝`ReadResult.truncated`），**调用不成立用抛**
 *   （越界 / 不存在 / 是否目录 / 无权限）：本文件抛**精确报文**，「名分」摆前面、
 *   原委接在后面，由**工具边界**捕之、收敛为 `ToolResult` 的判别式——模型据此改法
 *   （换路径 / 先建目录）而不是重试同一件事。
 * - **上限是字节**——`read` 的截断按 **UTF-8 字节**算（字符数在阈值内、字节数已超的中文串
 *   照样会撑爆调用方的上下文预算）。
 * - **列目录不跟链接**——`readdir` 的类型位对符号链接既非目录也非文件，归 `'other'`：
 *   不跟链接是薄隔离的既有姿态（技术方案 · 执行 · 隔离姿态），也顺手绕开目录环。
 */

import type { ListEntry, ReadResult, WriteData } from '@magic/contracts'
import type { Dirent } from 'node:fs'
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 读取上限——**字节**（实现级常量）。
 *
 * 为什么由沙箱持有而不是调用方给：端口签名 `read(path)` **没有选项位**——这是它的形态
 * （技术方案 · 领域划分的冻签名）。64 KiB ≈ 一万六千 token，够读一个大源码文件；
 * 再长的部分模型用 `exec` 的 `sed` / `head` 自己取（工具侧只据 `truncated` 如实措辞）。
 */
export const DEFAULT_MAX_READ_BYTES = 64 * 1024

/** 动作名——进报文的名分（同一份原委，不同动作说不同的话）。 */
type Op = '读取' | '写入' | '列目录'

/** `ENOENT` 各动作的名分——同一个错误码，三种事实（读不到文件 / 建不了文件 / 列不了目录）。 */
const MISSING_OF: Record<Op, string> = {
  读取: '文件不存在',
  写入: '上级目录不存在——先建目录',
  列目录: '目录不存在',
}

/**
 * 把 `node:fs` 的错误码翻成模型读得懂的名分。
 *
 * 认不出来就照抄原委——**不吞**：认得出的说人话，认不出的留住原文，总比一律「IO 错误」强。
 */
function failureOf(op: Op, absolute: string, error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code

  const named =
    code === 'ENOENT'
      ? MISSING_OF[op]
      : code === 'EISDIR'
        ? '是目录，不是文件'
        : code === 'ENOTDIR'
          ? '不是目录'
          : code === 'EACCES' || code === 'EPERM'
            ? '无权限'
            : undefined

  const cause = error instanceof Error ? error.message : String(error)
  return new Error(`${op}失败（${absolute}）：${named ?? cause}`)
}

/**
 * 读文件——超 `cap` 字节即截断（`truncated`；**字段缺席＝没截**）。
 *
 * 超长时只读**前 `cap` 字节**，并按**流式**解码且**不冲尾**：截断处可能正劈在多字节字符
 * 中间，冲尾会把那半片编成一个替换符（U+FFFD）——**丢掉比编造诚实**，也保住「产出的字节数
 * ≤ 上限」这条不变量（同 `exec.ts` 的 drain 口径）。
 */
export async function readText(absolute: string, cap: number): Promise<ReadResult> {
  let info: Awaited<ReturnType<typeof stat>>

  try {
    info = await stat(absolute)
  } catch (error) {
    throw failureOf('读取', absolute, error)
  }

  if (info.isDirectory()) throw new Error(`读取失败（${absolute}）：是目录，不是文件`)

  if (info.size <= cap) {
    try {
      return { content: await readFile(absolute, 'utf8') }
    } catch (error) {
      throw failureOf('读取', absolute, error)
    }
  }

  const handle = await open(absolute, 'r').catch((error: unknown) => {
    throw failureOf('读取', absolute, error)
  })

  try {
    const buffer = new Uint8Array(cap)
    const { bytesRead } = await handle.read(buffer, 0, cap, 0)
    const decoder = new TextDecoder()
    return {
      content: decoder.decode(buffer.subarray(0, bytesRead), { stream: true }),
      truncated: true,
    }
  } finally {
    await handle.close()
  }
}

/**
 * 整写文件——**覆盖**（不是追加）；不建上级目录；**两选一都收**。
 *
 * - **文本支**——按 UTF-8 落；
 * - **字节支**——原样落（不经文本往返：给 `Uint8Array` 就是要那些字节）。
 *
 * 为什么不顺手 `mkdir -p`：那是**目录层的副作用**，模型没要（要就先 `exec mkdir` 或写全路径）。
 * 悄悄建目录 = 把「一次文件写」扩张成「动了两层结构」——闸门与审计都只看见前者。
 */
export async function writeInto(absolute: string, data: WriteData): Promise<void> {
  try {
    await writeFile(absolute, 'text' in data ? data.text : data.bytes)
  } catch (error) {
    throw failureOf('写入', absolute, error)
  }
}

/** 列目录——名（必给）＋ 类型 / 尺寸；**按名字序**（不靠文件系统序：同一目录两次列结果稳定）。 */
export async function listDir(absolute: string): Promise<readonly ListEntry[]> {
  let dirents: Dirent[]

  try {
    dirents = await readdir(absolute, { withFileTypes: true })
  } catch (error) {
    throw failureOf('列目录', absolute, error)
  }

  const sorted = [...dirents].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )

  return Promise.all(
    sorted.map(async (entry): Promise<ListEntry> => {
      if (entry.isDirectory()) return { name: entry.name, kind: 'directory' }
      if (!entry.isFile()) return { name: entry.name, kind: 'other' } // 链接 / 设备 / 套接字

      const size = await sizeOf(join(absolute, entry.name))
      return size === undefined
        ? { name: entry.name, kind: 'file' }
        : { name: entry.name, kind: 'file', size }
    }),
  )
}

/** 文件字节数——取不到即不给（列目录之后被删的竞态不该让**整次**列目录失败）。 */
async function sizeOf(absolute: string): Promise<number | undefined> {
  try {
    return (await stat(absolute)).size
  } catch {
    return undefined
  }
}
