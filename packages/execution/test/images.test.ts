/**
 * U37 · 认图 —— 判据：**按字节认**（不认名字）· **结构底线**（半截的不要）。
 *
 * 这一层只做两个是非判断，故用例也是这两个：
 * - `sniffImage` —— 认得出是哪一种图（认不出＝`undefined`，不是报错）；
 * - `checkImageIntact` —— 这份字节完整吗（半截的要拦在**送出去之前**）。
 *
 * 字节的真来源：PNG / JPEG / GIF 用**真的**最小图（1×1，base64 解出来——它们是真文件，
 * 拿它们当夹具才验得出「真图不会被误杀」）；WEBP / BMP 手搭（本模块不解码，
 * 只要结构底线那几件齐——用例里逐字节说清了搭的是什么）。
 */

import { describe, expect, test } from 'bun:test'
import { checkImageIntact, looksLikeImageName, sniffImage } from '../src/images.ts'

// —— 真文件的字节（1×1，最小合法图）——

function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

/** 1×1 透明 PNG（67 字节，真文件）。 */
const PNG = bytesOf(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
)

/** 1×1 JPEG（真文件）。 */
const JPEG = bytesOf(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
)

/** 1×1 GIF（真文件，`GIF89a`）。 */
const GIF = bytesOf('R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7')

/**
 * 手搭的 WEBP 头——`RIFF` ＋ **长度字段**（＝总长 − 8，规范强制自洽）＋ `WEBP` ＋ 一点负载。
 * 本模块只查那个长度字段（不解码），故这一份过得了结构底线。
 */
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x0c, 0x00, 0x00, 0x00, // 长度 = 20 - 8 = 12
  0x57, 0x45, 0x42, 0x50, // WEBP
  0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, // 'VP8 ' ＋ 四位负载
])

/** 手搭的 BMP 头——`BM` ＋ 长度字段（＝实际长度）＋ 一点负载。 */
const BMP = new Uint8Array([
  0x42, 0x4d, // 'BM'
  0x0e, 0x00, 0x00, 0x00, // 长度 = 14
  0, 0, 0, 0, 0, 0, 0, 0, // 其余字段（本模块不看）
])

describe('U37 · 认图：按字节，不按名字', () => {
  test('五种光栅图各认各的 MIME', () => {
    expect(sniffImage(PNG)?.mime).toBe('image/png')
    expect(sniffImage(JPEG)?.mime).toBe('image/jpeg')
    expect(sniffImage(GIF)?.mime).toBe('image/gif')
    expect(sniffImage(WEBP)?.mime).toBe('image/webp')
    expect(sniffImage(BMP)?.mime).toBe('image/bmp')
  })

  test('认不出的（文本 / 空 / 太短）＝`undefined`——不是报错、也不是猜一个类型', () => {
    expect(sniffImage(new TextEncoder().encode('这是一段文字\n'))).toBeUndefined()
    expect(sniffImage(new Uint8Array(0))).toBeUndefined()
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeUndefined() // 只够半个魔数
  })

  test('只差一两个字节的近似形态不算（魔数是整串，不是前缀找得到就行）', () => {
    // GIF 头认到版本那两位（`GIF8` 之后不是 `7a`/`9a` 就不认）
    expect(sniffImage(new TextEncoder().encode('GIF8xx'))).toBeUndefined()
    // RIFF 之后不是 WEBP 的（比如 WAV）不算图
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ])
    expect(sniffImage(wav)).toBeUndefined()
  })

  test('**内容说了算**：没有扩展名、或扩展名骗人，都不影响认图', () => {
    // 这里判的是字节（名字压根不参与）——下面那一句是同一个函数对「名字像图」的说法
    expect(sniffImage(PNG)?.mime).toBe('image/png')
    expect(looksLikeImageName('shot.png')).toBe(true)
    expect(looksLikeImageName('shot.PNG')).toBe(true)
    expect(looksLikeImageName('shot.jpeg')).toBe(true)
    expect(looksLikeImageName('shot')).toBe(false) // 没扩展名——不当成「名字像图」
    expect(looksLikeImageName('README.md')).toBe(false)
  })
})

describe('U37 · 结构底线：半截的不要（只查规范强制的那几件）', () => {
  test('真的那几张都过（不误杀）', () => {
    expect(checkImageIntact(PNG, { mime: 'image/png', format: 'PNG' }).ok).toBe(true)
    expect(checkImageIntact(JPEG, { mime: 'image/jpeg', format: 'JPEG' }).ok).toBe(true)
    expect(checkImageIntact(GIF, { mime: 'image/gif', format: 'GIF' }).ok).toBe(true)
    expect(checkImageIntact(WEBP, { mime: 'image/webp', format: 'WEBP' }).ok).toBe(true)
    expect(checkImageIntact(BMP, { mime: 'image/bmp', format: 'BMP' }).ok).toBe(true)
  })

  test('截断的：尾巴一掉就认得出（PNG / GIF / WEBP 各一例）', () => {
    // PNG：IEND 那一块没了
    const cutPng = PNG.subarray(0, PNG.length - 12)
    const png = checkImageIntact(cutPng, { mime: 'image/png', format: 'PNG' })
    expect(png.ok).toBe(false)
    if (!png.ok) expect(png.reason).toContain('PNG')

    // GIF：结尾那个 `0x3B` 没了
    const cutGif = GIF.subarray(0, GIF.length - 1)
    expect(checkImageIntact(cutGif, { mime: 'image/gif', format: 'GIF' }).ok).toBe(false)

    // WEBP：RIFF 说 12 字节，实际只有 8 了
    const cutWebp = WEBP.subarray(0, WEBP.length - 4)
    expect(checkImageIntact(cutWebp, { mime: 'image/webp', format: 'WEBP' }).ok).toBe(false)
  })

  test('JPEG：尾部挂一点东西照收（相机常这么干），EOI 真没了才拒', () => {
    const withTrailer = new Uint8Array([...JPEG, 0x00, 0x11, 0x22])

    expect(checkImageIntact(withTrailer, { mime: 'image/jpeg', format: 'JPEG' }).ok).toBe(true)
    // 把 EOI 切掉（尾部挂的东西盖不住它了）
    const cut = new Uint8Array([...JPEG.subarray(0, JPEG.length - 2), 0x00, 0x11, 0x22])
    expect(checkImageIntact(cut, { mime: 'image/jpeg', format: 'JPEG' }).ok).toBe(false)
  })

  test('拒的那一句话说得出**是哪一种不过**（「没传完的 PNG」）', () => {
    const cut = PNG.subarray(0, PNG.length - 12)
    const verdict = checkImageIntact(cut, { mime: 'image/png', format: 'PNG' })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('没传完')
  })
})
