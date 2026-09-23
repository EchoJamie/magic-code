/**
 * **导出原图**（U37）——把记录里那份字节落到一个**本地文件**上，并把路径交回用户。
 *
 * 出处：设计 · 文件与图片 ·「历史附件可按需选择『查看原图』，将记录字节导出到唯一临时文件
 * 并给本地路径；**不覆盖已有文件、不自动打开外部应用**」。
 *
 * ## 为什么归装配
 *
 * 写盘是装配那一层的事（同配置 / 授权文件的读写——域不碰文件系统）。对话域只负责
 * **取字节**（从记录里那份 blob）并说清「这是哪一张」，**落点在哪儿、重名怎么办**
 * 是这一层的规矩。
 *
 * ## 三条分寸
 *
 * - **唯一命名**：同一张图导两次得两条路（时间戳 ＋ 随机尾巴），**绝不覆盖**已有的文件
 *   ——`wx` 打开，撞上就换一个名字再来（而不是「先删再写」：那正是覆盖）；
 * - **不自动打开**：给路径就完事。用不用看图软件打开是用户自己的事，内核没有理由
 *   动他的屏幕（设计明文，且这一条在 macOS 上尤其要紧——`open` 会把前台整个切走）；
 * - **不进工作区**：落在系统临时目录下一个自持的子目录里（`magic-attachments`），
 *   免得「看一眼图」这件事往用户的仓库里丢文件。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 导出的落点——系统临时目录下一个自持的子目录（见文件头注）。 */
export const ATTACHMENT_DIR = 'magic-attachments'

/** 一次导出的产物——判别式（失败是正常结果的一种，同材料 / 技能那两处）。 */
export type SavedAttachment =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string }

/**
 * 把一份字节写成一条新文件——**唯一命名、不覆盖**（见文件头注）。
 *
 * 名字的取法：**原名**（认得出来是哪一张）＋ 一小段唯一尾巴 ＋ 原扩展名。
 * 原名先过一道清洗（路径分隔符与控制字符一律换掉）——它来自用户盘上的文件名，
 * 直接拼进路径就是一次目录穿越（`../../.ssh/authorized_keys` 也是「一个文件名」）。
 */
export async function saveAttachmentFile(file: {
  readonly name: string
  readonly mime: string
  readonly bytes: Uint8Array
}): Promise<SavedAttachment> {
  const dir = join(tmpdir(), ATTACHMENT_DIR)

  try {
    // `recursive: true` ＝ 已经有就用（不报错）；权限只给本用户（导出的是用户自己的材料）
    await mkdir(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    return { ok: false, reason: `建不了导出目录「${dir}」：${messageOf(error)}` }
  }

  const { stem, extension } = splitName(file.name, file.mime)

  // **撞上就换一个名字再来**（不覆盖）——次数封顶：连着三次同名是系统出了别的问题，
  // 那时报清楚比继续转强
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const path = join(dir, `${stem}-${stamp()}-${randomUUID().slice(0, 8)}${extension}`)

    try {
      await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 })
      return { ok: true, path }
    } catch (error) {
      if (isExists(error)) continue

      return { ok: false, reason: `写不进「${path}」：${messageOf(error)}` }
    }
  }

  return { ok: false, reason: `连续三次都撞上了同名文件（${dir} 里）——请先清一清那里` }
}

/**
 * 文件名 → 「主名 ＋ 扩展名」——主名清洗过（见 `saveAttachmentFile`）。
 *
 * 扩展名取**原名**那一段（认得出来）；原名没有扩展名时按 MIME 补一个
 * （导出的文件得能被看图软件认出来，否则用户拿到一条打不开的路径）。
 */
function splitName(name: string, mime: string): { readonly stem: string; readonly extension: string } {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const rawStem = dot > 0 ? base.slice(0, dot) : base
  const rawExtension = dot > 0 ? base.slice(dot) : ''

  const stem = rawStem.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 60) || 'attachment'
  const extension = /^\.[A-Za-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : extensionOf(mime)

  return { stem, extension }
}

/** MIME → 扩展名（只认得我们收的那五种；认不出就 `.bin`——总比没有强）。 */
function extensionOf(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/bmp':
      return '.bmp'
    default:
      return '.bin'
  }
}

/** 时间戳那一段（`20260924-153012`）——人一眼看得出是什么时候导的。 */
function stamp(): string {
  const at = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')

  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  )
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
