/**
 * `Materials` —— 文件 / 目录材料来源面（U36 · 正文里的 `@`）。
 *
 * 与 `rules.ts` / `skills.ts` 同一处境、同一分工（读在边界、选与送在对话侧），
 * 三处细节是这一份特有的：
 *
 * ## 一、路径经**工作区**归位（与沙箱同源）
 *
 * 相对按默认根、绝对须落某条根内——判据与 `Sandbox` 逐字同源（都走
 * `WorkspaceService.resolve`），故「引用得到」与「工具读得到」不会各说一套。
 *
 * ## 二、工作区外：**只收单个文件**，且要用户明确选定
 *
 * 输入 `@` 或粘贴**都不获准**（设计 · 文件与图片）。唯一进口是 `MaterialRequest.external`
 * ——用户在候选里明确按下回车选定那一条；而候选那一侧也**只认打全的那一条路径**
 * （外部路径不做目录浏览）。取到的是一份**只读附件**：读一次内容，
 * **沙箱的根一条都不动**，后续任何工具的可写范围不因此扩大。
 *
 * ## 三、只收文本
 *
 * 二进制（含 NUL 字节 / UTF-8 读不出来）**不当文本解码**——给了乱码进上下文比没有更坏。
 * 拒绝时给出确定的出口（「要用它就让工具去处理」），不是一句「读不了」。
 *
 * 上限与截断都**如实标**（`truncated` / `omitted` 一路带到记录里）：宁可说「只送到这里」，
 * 也不能让模型以为手里是全份（设计：不能静默缺材料）。
 */

import type {
  ListEntry,
  Material,
  MaterialLoad,
  MaterialRequest,
  Materials,
  PathCandidate,
  PathCandidates,
  WorkspaceService,
} from '@magic/contracts'
import { realpathSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { isInside } from './workspace.ts'

/** 装配期构造入参——与沙箱一样：工作区端口由装配给（同一份实现，边界因此同源）。 */
export type MaterialsOptions = {
  readonly workspace: WorkspaceService
}

/**
 * 单个文件的读取上限——**字节**（实现级常量）。
 *
 * 取 64 KiB 的由头：与沙箱 `read` 的缺省同一个数（`files.ts` 的 `DEFAULT_MAX_READ_BYTES`）
 * ——「引用读到的」与「工具读到的」在**同一个上限**上说话，用户不必记两把尺子。
 * 到上限即截断并**如实标**（`truncated`），要更多让模型用 `read` / `exec` 自己去取。
 */
export const DEFAULT_MATERIAL_BYTES = 64 * 1024

/**
 * 一次交代里全部材料的**总量上限**——**字符**（实现级常量）。
 *
 * 由头：单条 64 KiB 挡不住「一次带十份」——十条交代拼起来同样是几百 KB 进上下文，
 * 而这一次请求可能因此当场超限（白搭一次调用）。256 KiB ≈ 六万 token 上下：够一次带上
 * 几份真材料，又不至于把窗口一口吃满。**超了就整条不跑并说清**（不静默少带，
 * 也不悄悄截断几份）——用户手上的动作是「去掉几份再发」，那句话要在回执里说得出。
 */
export const DEFAULT_TOTAL_CHARS = 256 * 1024

/** 目录清单最多列几项——超出的**如实报数**（`omitted`），不静默少列。 */
export const DEFAULT_DIR_ENTRIES = 200

/** 路径候选最多列几条（`@` 那一栏是「边打边认」的辅助，不是浏览面——同 `MAX_CANDIDATES` 的姿势）。 */
export const DEFAULT_CANDIDATES = 30

// —— 一次「拆目录 ＋ 前缀」的产物 ——

/**
 * 用户打的那一段 → 「列哪个目录 ＋ 前缀是什么」。
 *
 * 两种收尾都要照顾到：`src/`（用户明说要往这个目录里看）与 `src/lo`（打到一半的名字）。
 * 前者整段就是目录，后者拆成「目录 ＋ 前缀」。
 */
type Split = {
  readonly dir: string
  readonly prefix: string
  /**
   * 用户**写成了目录**（尾巴带一个分隔符）——`src/` 是「往这个目录里看」，
   * `src` 是「打到一半的名字」。
   *
   * ⚠️ 这个位**必须在归一之前取**：`path.resolve` 会把尾巴那个斜杠吃掉
   * （`resolvePath('/ws', 'src/')` 给 `/ws/src`），事后就分不出这两种写法了。
   */
  readonly isDir: boolean
}

function splitQuery(raw: string, absolute: string): Split {
  if (raw === '') return { dir: absolute, prefix: '', isDir: true }
  if (raw.endsWith(sep)) return { dir: absolute, prefix: '', isDir: true }

  return { dir: dirname(absolute), prefix: basename(absolute), isDir: false }
}

/**
 * 造一份材料来源面（工作区端口由装配给）。
 *
 * 只读：本文件没有一处写盘调用（`readdir` / `readFile` / `stat` / `realpath` 而已）。
 */
export function createMaterials(options: MaterialsOptions): Materials {
  const { workspace } = options

  /** 落在哪条根里（**两张表都认**——与 `resolve` 同一把尺子）；不在任何根里＝`undefined`。 */
  const rootOf = (absolute: string): string | undefined =>
    workspace.roots().find((root) => isInside(absolute, root))

  /**
   * 按**声明原形**判落点——给「文件已经不在了」那一档用（取不到 `realpath` 时，
   * 真路径那一张表够不着：用户写的 `/tmp/proj/x` 与注册的 `/private/tmp/proj` 是两条写法）。
   *
   * 判据与 `resolve` 同源（同两张表、同一条段边界规则），**只是不抛**：这里要的是
   * 「它本来在工作区里吗」这一个是非判断，不是一个已解析的路径。
   */
  const declaredRootOf = (raw: string): string | undefined => {
    try {
      return workspace.resolve(raw).root
    } catch {
      return undefined
    }
  }

  /**
   * 写进正文的**写法**——默认根里＝相对写法（用户认得的那个），其余（别的根 / 工作区外）
   * ＝绝对路径。多根与外部来源因此**在字面上就分得开**（不必再标一次）。
   */
  const displayOf = (absolute: string): string => {
    const inside = rootOf(absolute)

    return inside === workspace.defaultRoot() ? relative(inside, absolute) : absolute
  }

  /** 真路径（身份）——文件不在（竞态）时退回词法路径：给得出一个可报的落点。 */
  const realOf = (absolute: string): string => resolvedOf(absolute).real

  /**
   * **真身 ＋ 它在不在**——「按哪条路径判里外」这件事的取材。
   *
   * `exists: true` ⇒ `real` 是 `realpath` 之后的真身；`false` ⇒ 取不到真身，
   * `real` 原样退回词法路径。
   *
   * ⚠️ **这一位是判据的一半**（见 `insideOf`）：真身取到了，里外就按真身说了算——
   * 工作区里一条指向外面的链接（`link/ → /etc`），真身在根外就是**在根外**，
   * 词法那张表不许把它拉回来（那就是符号链接绕过边界）。
   */
  const resolvedOf = (absolute: string): { readonly real: string; readonly exists: boolean } => {
    try {
      return { real: realpathSync(absolute), exists: true }
    } catch {
      return { real: absolute, exists: false }
    }
  }

  /**
   * **这一条落在工作区里吗**——判据分两档，由「真身取到没有」决定：
   *
   * - **取得了真身**（这一条存在）⇒ **只看真身**。符号链接绕出去的、软链到别处的，
   *   一律按真身算作**外面**——工作区边界不吃词法兜底（`link/secret.txt` 不许因为
   *   写起来在根里就当里头的读）。
   * - **取不到真身**（这一条不在）⇒ 回落**词法两张表**（`WorkspaceService.resolve` 那一把
   *   尺子：声明原形 ＋ 规范形）。这一档只为把「不在」与「越界」这两种话说准：
   *   macOS 上用户写的 `/tmp/proj/x` 与注册的 `/private/tmp/proj` 是两条写法，
   *   文件真被删掉时取不到真身，光比规范形会把「不在了」误报成「工作区外」。
   */
  const insideOf = (absolute: string): boolean => {
    const at = resolvedOf(absolute)

    return at.exists ? rootOf(at.real) !== undefined : declaredRootOf(absolute) !== undefined
  }

  // —— 候选：只回答「有这么一条吗、它是文件还是目录」——

  /**
   * 一条路径的类型——**里外、候选与 load 都经这一个入口判**（三处各判一次就是三处口径，
   * 迟早分叉：真出现过分叉——工作区里的「非普通文件」挡住了，外部那一支却漏了，
   * 于是 `/dev/null` 会被当成一条可选的外部文件给出去）。
   *
   * `other` ＝ **非普通文件**（管道 / 设备 / 套接字）：文本读不了（FIFO 上 `open` 会等写端），
   * 一律不入候选、不取材料。
   */
  const kindOf = (info: { isFile(): boolean; isDirectory(): boolean }): 'file' | 'directory' | 'other' =>
    info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'

  /** 一条目录项 → 候选（链接等归 'other' 的不列——列出来也引用不了）。 */
  const rowOf = async (
    absolute: string,
    name: string,
    kind: 'file' | 'directory' | 'other',
  ): Promise<PathCandidate | undefined> => {
    const path = join(absolute, name)

    if (kind === 'other') {
      // 符号链接 / 设备：看**指向的东西**是什么（读的时候是跟链接的，候选也得跟）
      try {
        const info = await stat(path)
        const pointed = kindOf(info)
        if (pointed === 'other') return undefined
        return candidateOf(path, pointed)
      } catch {
        return undefined
      }
    }

    return candidateOf(path, kind)
  }

  /**
   * 一条目录项 → 候选行；**工作区外的目录不入候选**（`undefined`）。
   *
   * 为什么连行都不给：外面那个只收**单个文件**（选定即只读附件），给一条「外部目录」的行
   * 只会让用户选到一个到提交那一刻必然失败的引用。行里的 `external` 也在这儿定
   * ——**按真身判**：工作区里的链接指向外面时，这一条仍是「外面那一条」。
   */
  const candidateOf = (path: string, kind: 'file' | 'directory'): PathCandidate | undefined => {
    const real = realOf(path)
    const external = rootOf(real) === undefined
    if (external && kind === 'directory') return undefined

    return { path: real, display: displayOf(real), kind, external }
  }

  /** 列一层目录（只这一层）——名字筛前缀，按名排序（不靠文件系统序）。 */
  const listCandidates = async (
    dir: string,
    prefix: string,
    limit: number,
  ): Promise<{ readonly rows: readonly PathCandidate[]; readonly more: number }> => {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      throw new Error(`列不了这个目录（${dir}）：${reasonOf(error)}`)
    }

    const matched = dirents
      .filter((entry) => entry.name.startsWith(prefix))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

    const rows: PathCandidate[] = []
    for (const entry of matched.slice(0, limit)) {
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
      const row = await rowOf(dir, entry.name, kind)
      if (row !== undefined) rows.push(row)
    }

    return { rows, more: Math.max(0, matched.length - limit) }
  }

  return {
    async candidates(query: string, limit: number): Promise<PathCandidates> {
      const raw = query
      // 绝对路径按原样、相对路径按默认根（与 `resolve` 同一条规则）
      const target = isAbsolute(raw) ? resolvePath(raw) : resolvePath(workspace.defaultRoot(), raw)
      const { dir, prefix, isDir } = splitQuery(raw, target)

      // 打全的那一条在不在、是什么类型（跟随链接）
      const complete = await statOrUndefined(target)
      const kind = complete === undefined ? undefined : kindOf(complete)
      // **里外按真身判**（`insideOf`）：`link/` 指向外面时，写起来的路径虽在根里，也算外面
      const inside = insideOf(target)

      // 打全的那一条**先认**：`@src/login.ts` 这种（还有工作区外那一条）不必列目录。
      // ⚠️ **写成目录的（`src/`）不走这一支**：那种写法要的是「列它下面那一层」。
      // ⚠️ **非普通文件也不走**（管道 / 设备 / 套接字）：给一条读不了的行没有意义。
      if (!isDir && inside && kind !== undefined && kind !== 'other' && prefix !== '') {
        const row = candidateOf(target, kind)
        // 真身在根内（`inside` 判过）时不会是「外部目录」，故这一支必有行
        if (row !== undefined) return { rows: [row] }
      }

      // —— 工作区外：**只认打全的那一条**，且只收普通文件（判据与里头同一处：`kindOf`）——
      if (!inside) {
        if (kind === undefined) {
          return { rows: [], note: `工作区外，而且这个路径不存在：${raw}` }
        }
        if (kind === 'directory') {
          return {
            rows: [],
            note:
              '工作区外只收单个文件——目录不列、不读（输入 @ 不获准浏览工作区外的地方；' +
              '要带某个文件就把它打全，选定即只读附件）。',
          }
        }
        if (kind === 'other') {
          return {
            rows: [],
            note:
              '工作区外也只收普通文本文件——这一条是管道 / 设备 / 套接字那类，' +
              '读不得（读了会挂在那儿等）。要用它就让工具去处理。',
          }
        }
        const row = candidateOf(target, 'file')
        return row === undefined ? { rows: [] } : { rows: [row] }
      }

      // —— 工作区里：列一层 ——
      //
      // ⚠️ **要列的那个目录自己也得是真身在根内**：`@link/`（`link` → 外面）写起来在根里，
      // 真身却在外面——那一支要按「外面」办（目录不列、不读），否则就是**借链接往外浏览**。
      const dirAt = resolvedOf(isDir ? target : dir)
      if (dirAt.exists && rootOf(dirAt.real) === undefined) {
        return {
          rows: [],
          note:
            '这一处指向工作区外（符号链接）——那边只收单个文件：把要带的那个文件打全，' +
            '选定即只读附件（目录不列、不读）。',
        }
      }

      try {
        const { rows, more } = await listCandidates(dir, prefix, limit)

        return {
          rows,
          ...(more === 0 ? {} : { note: `还有 ${more} 条没列出来——接着打几个字收窄` }),
        }
      } catch (error) {
        return { rows: [], note: reasonOf(error) }
      }
    },

    async load(requests: readonly MaterialRequest[]): Promise<MaterialLoad> {
      const materials: Material[] = []
      let total = 0

      for (const request of requests) {
        const read = await loadOne(request)
        if (!read.ok) return { ok: false, reason: read.reason }

        total += read.material.text.length
        if (total > DEFAULT_TOTAL_CHARS) {
          return {
            ok: false,
            reason:
              `这一条带的材料太大了（已过 ${Math.round(DEFAULT_TOTAL_CHARS / 1024)} KiB 字符）` +
              `——去掉几份再发，或让它用 read / exec 按需读（此刻一份都没送出去）。`,
          }
        }

        materials.push(read.material)
      }

      return { ok: true, materials }
    },
  }

  // —— 取一份材料（工作区里按 kind 取；工作区外只收单个文件）——

  async function loadOne(
    request: MaterialRequest,
  ): Promise<{ readonly ok: true; readonly material: Material } | { readonly ok: false; readonly reason: string }> {
    const source = request.source
    const at = resolvedOf(source)
    // 落在哪条根里——**真身取到了就按真身**（`insideOf` 的两档见其注）：
    // 工作区里一条指向外面的链接（`link/secret.txt`），真身在根外就是**在根外**，
    // 词法那张表不许把它拉回来；只有「这一条不在（取不到真身）」时才回落词法两张表，
    // 为的是把「不在了」与「工作区外」这两种话说准（macOS 的 `/tmp` 别名那一档）。
    const inside = insideOf(source)

    if (!inside && request.external !== true) {
      return {
        ok: false,
        reason:
          `「${source}」不在工作区里——工作区外只收「用户明确选定」的那一个文件` +
          `（输入 @ 或粘贴都不获准）。重新选一次，或把它放进工作区。`,
      }
    }

    const info = await statOrUndefined(source)
    if (info === undefined) {
      return { ok: false, reason: `「${displayOf(at.real)}」现在不在了（可能已改名或删掉）——拿掉这一处引用，或换一份。` }
    }

    // **非普通文件不当文本读**（§ 见 `readBounded`）：FIFO 上 `open(path, 'r')` 会**一直挂着**
    // 等一个写端（设备 / 套接字同理）——那不是「读不到」，是**根本不该去读**。
    if (kindOf(info) === 'other') {
      return {
        ok: false,
        reason:
          `「${displayOf(at.real)}」不是普通文件（管道 / 设备 / 套接字那类）——按路径引用只收` +
          `文本文件。要用它就让工具去处理（例如 exec）。`,
      }
    }

    if (!inside) {
      // 工作区外：只收单个文件（目录不在此列——见端口注）
      if (info.isDirectory()) {
        return {
          ok: false,
          reason: `「${source}」是工作区外的目录——外部只取单个文件。换成某个文件，或把它移进工作区。`,
        }
      }

      const bytes = await readBounded(at.real)
      if (!bytes.ok) return { ok: false, reason: bytes.reason }

      return {
        ok: true,
        material: {
          kind: 'file',
          path: at.real,
          label: at.real,
          text: bytes.text,
          ...(bytes.truncated ? { truncated: true as const } : {}),
        },
      }
    }

    if (request.kind === 'dir') {
      if (!info.isDirectory()) {
        return {
          ok: false,
          reason: `「${displayOf(at.real)}」现在是文件，不是目录——换一处引用，或改成引用这个文件。`,
        }
      }

      const entries = await listOne(at.real)
      if (!entries.ok) return { ok: false, reason: entries.reason }

      const shown = entries.entries.slice(0, DEFAULT_DIR_ENTRIES)
      const omitted = entries.entries.length - shown.length

      return {
        ok: true,
        material: {
          kind: 'dir',
          path: at.real,
          label: displayOf(at.real),
          text: listedOf(shown),
          ...(omitted === 0 ? {} : { omitted }),
        },
      }
    }

    if (info.isDirectory()) {
      const shown = displayOf(at.real)
      return {
        ok: false,
        reason:
          `「${shown}」是个目录——引用目录请写成 @${shown}/（目录取的是有界清单，不展开内容），` +
          `或改成引用它里面的某个文件。`,
      }
    }

    const bytes = await readBounded(at.real)
    if (!bytes.ok) return { ok: false, reason: bytes.reason }

    return {
      ok: true,
      material: {
        kind: 'file',
        path: at.real,
        label: displayOf(at.real),
        text: bytes.text,
        ...(bytes.truncated ? { truncated: true as const } : {}),
      },
    }
  }
}

// —— 读文件（有界 ＋ 只收文本）——

type ReadBytes =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * 读一个有界的前缀，**只收文本**。
 *
 * 三件：
 * ① **到上限为止**（`truncated`）；② **含 NUL 字节＝二进制**（不当文本解码）；
 * ③ **UTF-8 读不出＝二进制**——截断处可能正劈在一个多字节字符中间，故先把尾部那半片
 * 让掉再判（半片是**我们截的**，不是文件的问题）。
 */
async function readBounded(absolute: string): Promise<ReadBytes> {
  let kept: Uint8Array
  let truncated: boolean

  // 只读**前缀**（上限 ＋ 1 字节用来判「有没有更多」）——大文件不整份进内存
  // （同 `files.ts` 的 `readText` 那条姿势；差别是这里要自己判二进制，故拿的是字节）
  try {
    const handle = await open(absolute, 'r')

    try {
      const buffer = new Uint8Array(DEFAULT_MATERIAL_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      truncated = bytesRead > DEFAULT_MATERIAL_BYTES
      kept = buffer.subarray(0, Math.min(bytesRead, DEFAULT_MATERIAL_BYTES))
    } finally {
      await handle.close()
    }
  } catch (error) {
    return { ok: false, reason: `读不了「${absolute}」：${reasonOf(error)}` }
  }

  if (kept.includes(0)) {
    return {
      ok: false,
      reason:
        `「${absolute}」像是二进制文件（含 NUL 字节）——按路径引用只收文本，` +
        `不当文本解码。要用它就让工具去处理（例如 exec / read）。`,
    }
  }

  const text = decodeUtf8(kept, truncated)
  if (text === null) {
    return {
      ok: false,
      reason: `「${absolute}」不是 UTF-8 文本（解码读不出）——按路径引用只收文本；要用它就让工具去处理。`,
    }
  }

  return { ok: true, text, truncated }
}

/**
 * 严格解码；截断时**让掉尾部那半片多字节字符**再判。
 *
 * 让掉的至多 3 字节（UTF-8 一个字符最长 4 字节）——「是我们截的、不是文件的问题」，
 * 故不算二进制。真读不懂的（非法字节序列）仍返回 `null`。
 */
function decodeUtf8(bytes: Uint8Array, truncated: boolean): string | null {
  for (let drop = 0; drop <= (truncated ? 3 : 0); drop += 1) {
    const slice = drop === 0 ? bytes : bytes.subarray(0, bytes.length - drop)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(slice)
    } catch {
      continue
    }
  }

  return null
}

// —— 目录（有界清单）——

type Listed =
  | { readonly ok: true; readonly entries: readonly ListEntry[] }
  | { readonly ok: false; readonly reason: string }

async function listOne(absolute: string): Promise<Listed> {
  let dirents
  try {
    dirents = await readdir(absolute, { withFileTypes: true })
  } catch (error) {
    return { ok: false, reason: `列不了「${absolute}」：${reasonOf(error)}` }
  }

  const entries: ListEntry[] = [...dirents]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry): ListEntry => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }))
    // 不跟链接（同 `files.ts` 的 listDir）：列出来也读不到实处的东西不入清单
    .filter((entry) => entry.kind !== 'other')

  return { ok: true, entries }
}

/** 清单 → 文本：一行一项，目录带尾斜杠（**一眼分得出文件与目录**）。 */
function listedOf(entries: readonly ListEntry[]): string {
  return entries.map((entry) => (entry.kind === 'directory' ? `${entry.name}/` : entry.name)).join('\n')
}

// —— 小工具 ——

async function statOrUndefined(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
