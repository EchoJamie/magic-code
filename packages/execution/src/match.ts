/**
 * 匹配原语 —— `match`（**grep / glob 共用一条底**；技术方案 · 执行）。
 *
 * 一条原语两个面，靠 `MatchOptions.mode` 分：`'grep'` 按**内容**（正则 · 逐行），
 * `'glob'` 按**文件名**（模式匹配）。两个面共用的三件——起点解析（`sandbox.ts` 已归位）、
 * **上限**（`maxResults`）、**取消**（`signal`，返回已收到的、不抛）。
 *
 * 三条实现级裁量（都往「搜索顺手」的方向，随回报备案）：
 * - **跳过 `.git` / `node_modules`**——搜这两个目录几乎从不是本意（版本库对象不是源码、
 *   依赖树是别人的代码），代价却是整棵树；skip 掉是本域替模型做的常识判断，不是夹带判定。
 * - **不跟符号链接**——`readdir` 的类型位对链接不报目录，递归自然不进；绕开目录环，
 *   也是薄隔离的既有姿态（技术方案 · 执行 · 隔离姿态）。
 * - **坏的局部不毁整趟**——某个子目录读不动、某个文件读不出，跳过继续；**但起点立不住
 *   （不存在 / 不是目录）＝响亮报错**——那是「问错了」，不是「没命中」。
 */

import type { MatchHit, MatchOptions } from '@magic/contracts'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 命中上限缺省——条（实现级常量；`grep` 的「输出截断」按它）。 */
export const DEFAULT_MAX_RESULTS = 200

/**
 * 单个文件的搜索上限——字节。
 *
 * 超过即**跳过**（不截读）：截读会让大文件尾部的命中静默消失，而「跳过」至少是同一套
 * 名额规则下的行为（`maxResults` 只管命中数，不管扫了多少）。8 MiB 远超任何源码文件。
 */
const MAX_GREP_FILE_BYTES = 8 * 1024 * 1024

/** 搜索跳过的目录名——按**段**比（任意一层叫这个名字即跳）。 */
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

/** 匹配一趟——起点已由调用方解析（绝对 · 落根内）。 */
export async function matchIn(
  start: string,
  pattern: string,
  opts: MatchOptions,
): Promise<readonly MatchHit[]> {
  const limit = positiveOr(opts.maxResults, DEFAULT_MAX_RESULTS)

  await assertDirectory(start, pattern)

  return opts.mode === 'glob'
    ? globIn(start, pattern, limit, opts.signal)
    : grepIn(start, pattern, limit, opts.signal)
}

/**
 * 起点必须**立得住**——不存在 / 不是目录即抛。
 *
 * 与「坏的子目录跳过」不矛盾：起点是调用方点的名，点错了该响亮说；树深处的意外是另一回事。
 */
async function assertDirectory(absolute: string, pattern: string): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>

  try {
    info = await stat(absolute)
  } catch {
    throw new Error(`搜索失败（${absolute}）：目录不存在——模式 ${pattern}`)
  }

  if (!info.isDirectory()) throw new Error(`搜索失败（${absolute}）：不是目录——模式 ${pattern}`)
}

/** 正有限数取正，否则回落缺省（同 `sandbox.ts` 的 `positiveOr` 口径）。 */
function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

// —— grep：按内容 ——

async function grepIn(
  start: string,
  pattern: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<readonly MatchHit[]> {
  let regex: RegExp

  try {
    regex = new RegExp(pattern)
  } catch (error) {
    throw new Error(
      `正则无效（${pattern}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const hits: MatchHit[] = []

  for await (const file of walkFiles(start, signal)) {
    const text = await candidateText(file)
    if (text === undefined) continue

    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = stripCarriageReturn(lines[index] ?? '')
      // 逐行 `exec`（无 `g` 标志——不带 lastIndex 状态，逐行独立判定）
      const found = regex.exec(line)
      if (found === null) continue

      hits.push({ path: file, line: index + 1, column: found.index + 1, text: line })
      if (hits.length >= limit) return hits
    }
  }

  return hits
}

/** 递归走文件——名字序（同层稳定）· 跳过 `SKIPPED_DIRS` · 中止即停。 */
async function* walkFiles(dir: string, signal: AbortSignal | undefined): AsyncGenerator<string> {
  // 信号值随时间**会变**（TS 会把 `signal?.aborted` 收窄成一次判定后的常量：
  // 首次判过 `!== true`，其后处处都当它还是那样）——故每次经这个函数现读。
  const aborted = (): boolean => signal?.aborted === true
  if (aborted()) return

  let dirents: Dirent[]

  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 子目录读不动（权限一类）——跳过，不毁整趟
  }

  const sorted = [...dirents].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )

  for (const entry of sorted) {
    if (aborted()) return

    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      yield* walkFiles(join(dir, entry.name), signal)
    } else if (entry.isFile()) {
      yield join(dir, entry.name)
    }
    // 其余（链接 / 设备 / 套接字）：不走也不给——见文件头注
  }
}

/** 候选文件的文本——过大 / 疑似二进制 / 读不出，一律 `undefined`（跳过）。 */
async function candidateText(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file)
    if (info.size > MAX_GREP_FILE_BYTES) return undefined

    const text = await readFile(file, 'utf8')
    // 含 NUL ＝ 二进制（`grep -I` 的老判据）——按行匹配二进制只会吐一堆乱码
    return text.includes('\0') ? undefined : text
  } catch {
    return undefined
  }
}

/** 行尾 `\r`（CRLF 文件）去掉——命中文本就是那一行，不该夹一个不可见字符。 */
function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

// —— glob：按文件名 ——

async function globIn(
  start: string,
  pattern: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<readonly MatchHit[]> {
  let glob: Bun.Glob

  try {
    glob = new Bun.Glob(pattern)
  } catch (error) {
    throw new Error(
      `模式无效（${pattern}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const hits: MatchHit[] = []

  for await (const relative of glob.scan({ cwd: start, dot: false, onlyFiles: true })) {
    if (signal?.aborted === true) break // 只此一处判——此后不再读该标志（TS 收窄，见 `walkFiles` 注）
    if (hasSkippedSegment(relative)) continue

    hits.push({ path: join(start, relative) })
    if (hits.length >= limit) break
  }

  // 名字序——扫描序不作保证（超上限时选出哪一批属实现级，见备案）
  return hits.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function hasSkippedSegment(relative: string): boolean {
  return relative.split('/').some((segment) => SKIPPED_DIRS.has(segment))
}
