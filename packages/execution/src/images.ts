/**
 * **认图**（U37）——按**字节**认，不按扩展名认。
 *
 * ## 为什么判据是内容而不是名字
 *
 * 两条都要害：
 * - **扩展名会撒谎**：`shot.png` 里装的可能是截图工具导出失败的半截文件、一个 HTML 错误页，
 *   或者干脆是别的格式。按名字宣判，等于让一个**没被验证过的事实**决定「这份材料以什么
 *   形态送进请求」——送错了，模型那头收到的是一串它读不懂的字节（或者更坏：整条请求 400）。
 * - **名字也会缺**：截图直接拖出来的文件常常没有扩展名。按名字判，一张好好的图会被
 *   当成二进制文本拒掉。
 *
 * 故：**内容说了算**（魔数 → MIME），扩展名只在**两者打架时**派一个用场——
 * 说清「这个名字像是图片，可它内容不是」比含混地说「读不了」有用得多。
 *
 * ## 完整性那一关
 *
 * 认得出来还不够：**半截的图**（下载断在中间、复制没复制完）送出去只会让对面报一个
 * 「图片坏了」的错，而用户看不出是哪一步出的问题。故认出来之后再查一遍**结构底线**——
 * 只查各家规范里**强制**的那几件（PNG 的 IEND 必定在最后、GIF 的结尾一定是 `0x3B`、
 * WEBP 的 RIFF 长度必须自洽、JPEG 必须有 EOI）。
 *
 * ⚠️ **不做完整解码**：本模块不引解码器（那要拖进一整个图像库，而内核只需要「能不能送」
 * 这一个是非判断）。查的是**结构底线**，不是「这张图能不能渲染出来」——超出底线的破损
 * （像素数据乱掉但结构完整）**照送**，由对面报错，那时「哪一步出的问题」是清楚的。
 */

/** 认得出来的一张图——MIME 是按字节定的那一种。 */
export type SniffedImage = {
  readonly mime: string
  /** 人读的格式名（写进拒绝理由用：「像是一张没传完的 PNG」）。 */
  readonly format: string
}

/** 结构底线那一关的结果——过了就是过了，没过要说得出是哪一种不过。 */
export type ImageIntact = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * 按魔数认图——认得出来返回它的 MIME，认不出返回 `undefined`。
 *
 * 只认**光栅图**这五种：供应商的图像部件支持面就这一片最稳（SVG 是文本 + XML，
 * 各家的接受度参差；再冷门的格式收进来只会多出一堆「送出去被拒」）。
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', format: 'PNG' }
  }
  // JPEG：SOI 之后紧跟一个段标记（`FF D8 FF`）——只认 `FF D8` 会把一堆随机字节也放进来
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', format: 'JPEG' }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    const version = bytes[4]
    // `GIF87a` / `GIF89a`——第四五字节是版本，第六七是 `a`/`b` 之外的写法一律不认
    if ((version === 0x37 || version === 0x39) && bytes[5] === 0x61) {
      return { mime: 'image/gif', format: 'GIF' }
    }
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return { mime: 'image/webp', format: 'WEBP' }
  }
  if (startsWith(bytes, [0x42, 0x4d])) return { mime: 'image/bmp', format: 'BMP' }

  return undefined
}

/**
 * **这一张完整吗**——只查各家规范里强制的那几件（见文件头注：不做解码）。
 *
 * 每一种的问法：
 * - **PNG**——`IEND` 块必须收尾（规范：它是最后一个块）。查最后 8 字节那一串固定尾巴；
 * - **GIF**——结尾必须是 `0x3B`（Block Terminator），规范强制；
 * - **WEBP**——RIFF 头里写的总长必须与文件实际长度对得上（差一点点都不行：那个字段
 *   就是用来给读的人知道「读到哪儿为止」的）；
 * - **JPEG**——必须有 EOI（`FF D9`）。**允许尾部挂一点东西**（相机与编辑器常这么干），
 *   故在末尾 256 字节里找；
 * - **BMP**——头部偏移 2 处写的文件长度若**大于**实际长度，就是被截了（小于＝写的人
 *   没更新那格，现实里常见，不算截断）。
 */
export function checkImageIntact(bytes: Uint8Array, image: SniffedImage): ImageIntact {
  switch (image.mime) {
    case 'image/png':
      return endsWith(bytes, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
        ? { ok: true }
        : truncated(image)
    case 'image/gif':
      return bytes[bytes.length - 1] === 0x3b ? { ok: true } : truncated(image)
    case 'image/webp':
      return readUint32LE(bytes, 4) === bytes.length - 8 ? { ok: true } : truncated(image)
    case 'image/bmp':
      return readUint32LE(bytes, 2) > bytes.length ? truncated(image) : { ok: true }
    default:
      // JPEG：EOI 在末尾 256 字节内即可（尾部允许挂附加数据）
      for (let at = bytes.length - 2; at >= 0 && at >= bytes.length - 256; at -= 1) {
        if (bytes[at] === 0xff && bytes[at + 1] === 0xd9) return { ok: true }
      }
      return truncated(image)
  }
}

/**
 * **名字像是图片吗**——只在「按字节认不出图」时派用场：给一句更准的拒绝理由
 * （「这个名字像是图片，可它内容不是」比「读不了」有用）。
 *
 * 它**不参与认图**（见文件头注）——认图永远以字节为准。
 */
export function looksLikeImageName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false

  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** 常见的图片扩展名——只用于**措辞**（见 `looksLikeImageName`），不做判定依据。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'tif', 'tiff'])

function truncated(image: SniffedImage): ImageIntact {
  return {
    ok: false,
    reason: `像是一张没传完的 ${image.format}（文件是半截的）`,
  }
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false

  return magic.every((byte, at) => bytes[at] === byte)
}

function endsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false

  const from = bytes.length - magic.length
  return magic.every((byte, at) => bytes[from + at] === byte)
}

function readUint32LE(bytes: Uint8Array, at: number): number {
  if (bytes.length < at + 4) return -1

  return (
    ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0
  )
}
