/**
 * 文件原语只处理已裁定目标。文件打开后核对身份，读写使用同一句柄；写前检查内容冲突。
 * O_NOFOLLOW 阻止末端链接跟随，真实路径及父目录身份检查发现可观察到的重定向。
 * 这些检查不代替 openat 等 OS 原子目录绑定；不重判权限、不发起审批。
 * 实际 I/O 错误保留动作、路径与原因，由工具层原样回填。
 */

import type { ListEntry, ReadResult, ResolvedPath, WriteData } from '@magic/contracts'
import { constants, type Dirent } from 'node:fs'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertTarget, identityOf, sameIdentity } from './workspace.ts'

/**
 * 读取上限——**字节**（实现级常量），**单次**而非文件的尽头。
 *
 * 为什么由沙箱持有而不是调用方给：端口签名 `read(path, opts?)` 的缺省就在这里
 * （技术方案 · 领域划分的冻签名）。64 KiB ≈ 一万六千 token，一页够读一个大源码段；
 * 读不完的部分不是「此路不通」——`ReadResult.window.next` 给出下一段从哪一行起，
 * 模型用 `from` 续读，不必绕去 `exec` 的 `sed` / `head`。
 */
export const DEFAULT_MAX_READ_BYTES = 64 * 1024

/**
 * 动作名——进报文的名分（同一份原委，不同动作说不同的话）。
 *
 * ⚠️ **失败那句话只在本文件拼一次**（U83 · 缺陷 D41）——名分 ＋ 路径 ＋ 原委三者
 * 全在下面 `namedFailure` 那一处成句，**工具边界不再另加一层前缀**（`file-tools.ts`
 * 的捕处只把这句话原样回填）。由头：D41 里两处各加了一次前缀，屏上成了
 * 「写入失败：写入失败（path）：…」——**同一条事实说了两遍，而真正有用的那句指引
 * （「上级目录不存在——先建目录」）被淹在前缀里**，模型据此读成「此路不通」。
 */
type Op = '读取' | '写入' | '列目录'

/** `ENOENT` 各动作的名分——同一个错误码，三种事实（读不到文件 / 建不了文件 / 列不了目录）。 */
const MISSING_OF: Record<Op, string> = {
  读取: '文件不存在',
  写入: '上级目录不存在——先建目录',
  列目录: '目录不存在',
}

/**
 * **失败那句话的唯一样式**（U83 · D41）——名分 ＋ 路径 ＋ 原委，一次成句。
 *
 * 本文件里三处抛失败都经它（`failureOf` 与 `readText` 的「是目录」那一支）：
 * 一句话的形制只此一处说了算，调用方（工具域）**只回填、不再拼**。
 */
function namedFailure(op: Op, absolute: string, cause: string): Error {
  return new Error(`${op}失败（${absolute}）：${cause}`)
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
  return namedFailure(op, absolute, named ?? cause)
}

/** 打开后校验身份；不会在校验之前截断既有文件。调用者持有并负责关闭句柄。 */
export async function openTarget(target: ResolvedPath, mode: 'read' | 'write' | 'edit'): Promise<FileHandle> {
  const absolute = target.absolute
  assertTarget(absolute)
  const verifyParent = async (): Promise<void> => {
    if (target.parentIdentity === undefined) return
    const actual = identityOf(await stat(dirname(absolute), { bigint: true }))
    if (!sameIdentity(actual, target.parentIdentity)) throw new Error(`操作目标已改变：${absolute}`)
  }
  await verifyParent()
  const access = mode === 'read' ? constants.O_RDONLY : mode === 'edit' ? constants.O_RDWR : constants.O_WRONLY
  const creation = mode === 'write' && target.identity === null ? constants.O_CREAT | constants.O_EXCL : 0
  const op = mode === 'read' ? '读取' : '写入'
  const handle = await open(absolute, access | creation | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw failureOf(op, absolute, error)
  })
  try {
    await verifyParent()
    await verifyHandle(target, handle)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** 路径仍指向打开的那一个文件；文件身份与裁决前快照一致。 */
async function verifyHandle(target: ResolvedPath, handle: FileHandle): Promise<void> {
  assertTarget(target.absolute)
  const opened = identityOf(await handle.stat({ bigint: true }))
  const current = identityOf(await stat(target.absolute, { bigint: true }))
  if (!sameIdentity(opened, current) || (target.identity != null && !sameIdentity(opened, target.identity))) {
    throw new Error(`操作目标已改变：${target.absolute}`)
  }
}

/** `read` 的行窗口请求——`from` 从 1 数，`lines` 最多多少行；都缺省＝从第 1 行读到字节上限。 */
export type ReadWindowRequest = { readonly from?: number; readonly lines?: number }

/** 换行的字节（`read` 按行切段只认它；落在段尾的半行留到下一段）。 */
const NEWLINE = 0x0a

/** 统计总行数时的扫描上限——再大的文件只报「总行数未统计」（照样能一页页读到底）。 */
const LINE_COUNT_MAX_BYTES = 16 * 1024 * 1024

/** 顺序读的一段（`fill` 只用显式位置，不移动句柄游标：`edit` 读改写共用同一个句柄）。 */
async function fill(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(Math.max(length, 0))
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return buffer.subarray(0, filled)
}

async function countLines(handle: FileHandle, start: number, size: number): Promise<{ lines: number; endsWithNewline: boolean }> {
  let lines = 0, position = start, tail = NEWLINE
  while (position < size) {
    const chunk = await fill(handle, position, Math.min(DEFAULT_MAX_READ_BYTES, size - position))
    if (chunk.length === 0) break
    for (const byte of chunk) if (byte === NEWLINE) lines += 1
    tail = chunk[chunk.length - 1]!
    position += chunk.length
  }
  return { lines, endsWithNewline: tail === NEWLINE }
}

/**
 * 第 `line` 行的行首字节位置（`line` 从 1 数）；越过末尾就抛，并报**实际**多少行。
 *
 * 只能顺着扫——文本文件没有行索引。代价是 `from` 越大越贵（O(前缀)），换来的是
 * **一个地址空间**：`grep` 报第几行、`from` 就填第几行，模型不必换算。
 */
async function startOfLine(handle: FileHandle, size: number, line: number): Promise<number> {
  if (line <= 1) return 0
  let position = 0, seen = 0
  while (position < size) {
    const chunk = await fill(handle, position, Math.min(DEFAULT_MAX_READ_BYTES, size - position))
    if (chunk.length === 0) break
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== NEWLINE) continue
      seen += 1
      if (seen === line - 1) return position + index + 1
    }
    position += chunk.length
  }
  const counted = await countLines(handle, 0, size)
  throw new Error(`文件共 ${counted.lines + (counted.endsWithNewline || size === 0 ? 0 : 1)} 行，from=${line} 已越过末尾`)
}

/**
 * 按行切一段：从 `from` 行起，最多 `lines` 行、最多 `cap` 字节。
 *
 * 三条都以**整行**为界：`content` 不会停在一行的中间（`edit` 要拿它逐字匹配），
 * 没读完的部分由 `window.next` 指路。唯一例外是一行本身就超 `cap`——那时只能给到上限
 * 并明说（`oversizedLine`），因为**行**越界了，按行续读根本没有下一段。
 */
async function readWindow(handle: FileHandle, size: number, cap: number, request?: ReadWindowRequest): Promise<ReadResult> {
  const from = request?.from ?? 1
  const limit = request?.lines
  const start = await startOfLine(handle, size, from)
  // 末尾带换行时 `from = 总行数 + 1` 会落在 `size` 上（不越界）——但那是「没有这一行」，
  // 与 notes 那侧同一条规矩：越过末尾就抛，别给一份空正文配一个 `through < from` 的窗口。
  if (start >= size && size > 0) {
    const counted = await countLines(handle, 0, size)
    throw new Error(`文件共 ${counted.lines + (counted.endsWithNewline ? 0 : 1)} 行，from=${from} 已越过末尾`)
  }
  const bytes = await fill(handle, start, Math.min(cap + 1, size - start))

  // 行数上限：第 limit 个换行之后本段就到头（那个换行本身留在段内）
  let budget = bytes.length
  if (limit !== undefined) {
    let seen = 0
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== NEWLINE) continue
      seen += 1
      if (seen === limit) { budget = index + 1; break }
    }
  }
  const more = start + budget < size

  if (more && bytes.lastIndexOf(NEWLINE, budget - 1) < 0) {
    // 一页里连一个换行都没有：这一行自己就超上限，按行续读没有下一段
    return {
      content: new TextDecoder().decode(bytes.subarray(0, cap), { stream: true }),
      truncated: true,
      window: { from, through: from, totalBytes: size, oversizedLine: from },
    }
  }

  // 后面还有内容时，段尾的半行不收——留到下一段，免得把半行当成完整内容
  const end = more ? bytes.lastIndexOf(NEWLINE, budget - 1) + 1 : budget
  const body = bytes.subarray(0, end)
  let newlines = 0
  for (const byte of body) if (byte === NEWLINE) newlines += 1
  const through = from + newlines + (!more && body.length > 0 && body[body.length - 1] !== NEWLINE ? 1 : 0) - 1
  let totalLines: number | undefined = through
  if (more) {
    totalLines = undefined
    if (size <= LINE_COUNT_MAX_BYTES) {
      const rest = await countLines(handle, start + end, size)
      totalLines = through + rest.lines + (rest.endsWithNewline ? 0 : 1)
    }
  }

  return {
    content: new TextDecoder().decode(body, { stream: true }),
    ...(more ? { truncated: true } : {}),
    window: { from, through, totalBytes: size, ...(totalLines === undefined ? {} : { totalLines }), ...(more ? { next: through + 1 } : {}) },
  }
}

/** 所有读取从句柄上按显式位置取（不移动游标），编辑随后仍使用此句柄。 */
export async function readOpened(handle: FileHandle, absolute: string, cap: number, request?: ReadWindowRequest): Promise<ReadResult> {
  try {
    const info = await handle.stat()
    if (info.isDirectory()) throw new Error('是目录，不是文件')
    return await readWindow(handle, info.size, cap, request)
  } catch (error) { throw failureOf('读取', absolute, error) }
}

/** 写入与编辑在已校验句柄上完成；内容冲突作为执行失败，不触发审批。 */
export async function writeOpened(
  handle: FileHandle, target: ResolvedPath, data: WriteData, expectedContent?: string,
): Promise<void> {
  try {
    await verifyHandle(target, handle)
    if (expectedContent !== undefined) {
      const current = await readOpened(handle, target.absolute, Buffer.byteLength(expectedContent) + 1)
      if (current.truncated || current.content !== expectedContent) throw new Error('内容已改变——文件未改，请重新读取')
    }
    await handle.truncate(0)
    const bytes = 'text' in data ? Buffer.from(data.text) : data.bytes
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
      if (bytesWritten === 0) throw new Error('文件写入没有进展')
      offset += bytesWritten
    }
  } catch (error) { throw failureOf('写入', target.absolute, error) }
}

export async function readText(target: ResolvedPath, cap: number, request?: ReadWindowRequest): Promise<ReadResult> {
  const handle = await openTarget(target, 'read')
  try { return await readOpened(handle, target.absolute, cap, request) } finally { await handle.close() }
}

export async function writeInto(target: ResolvedPath, data: WriteData, expectedContent?: string): Promise<void> {
  const handle = await openTarget(target, expectedContent === undefined ? 'write' : 'edit')
  try { await writeOpened(handle, target, data, expectedContent) } finally { await handle.close() }
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
