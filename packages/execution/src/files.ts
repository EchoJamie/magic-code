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
 * 读取上限——**字节**（实现级常量）。
 *
 * 为什么由沙箱持有而不是调用方给：端口签名 `read(path)` **没有选项位**——这是它的形态
 * （技术方案 · 领域划分的冻签名）。64 KiB ≈ 一万六千 token，够读一个大源码文件；
 * 再长的部分模型用 `exec` 的 `sed` / `head` 自己取（工具侧只据 `truncated` 如实措辞）。
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
export async function verifyHandle(target: ResolvedPath, handle: FileHandle): Promise<void> {
  assertTarget(target.absolute)
  const opened = identityOf(await handle.stat({ bigint: true }))
  const current = identityOf(await stat(target.absolute, { bigint: true }))
  if (!sameIdentity(opened, current) || (target.identity != null && !sameIdentity(opened, target.identity))) {
    throw new Error(`操作目标已改变：${target.absolute}`)
  }
}

/** 所有读取从句柄的零偏移开始，编辑随后仍使用此句柄。 */
export async function readOpened(handle: FileHandle, absolute: string, cap: number): Promise<ReadResult> {
  try {
    const info = await handle.stat()
    if (info.isDirectory()) throw new Error('是目录，不是文件')
    const buffer = new Uint8Array(cap + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const truncated = length > cap || info.size > cap
    return {
      content: new TextDecoder().decode(buffer.subarray(0, Math.min(length, cap)), { stream: truncated }),
      ...(truncated ? { truncated: true } : {}),
    }
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

export async function readText(target: ResolvedPath, cap: number): Promise<ReadResult> {
  const handle = await openTarget(target, 'read')
  try { return await readOpened(handle, target.absolute, cap) } finally { await handle.close() }
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
