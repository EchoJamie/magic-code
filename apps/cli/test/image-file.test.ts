/**
 * **导出原图**（U110）——那一份落盘的小工具：唯一命名 · 不覆盖 · 名字清洗。
 *
 * ## 这一条是从哪儿来的
 *
 * 它当年叫 `attachment-file.test.ts`，随 `/attachments` 整链被 U111 删掉；U110 把
 * 「导出原图」按裁定搬进**查看那一屏**，同一份工具因此回来（行为一字未改），判据也照同一套
 * 重钉。三条口径（设计 · 文件与图片那一条）：
 *
 * | 口径 | 错了会怎样 |
 * | --- | --- |
 * | **唯一命名、绝不覆盖** | 同一张图导两次，第二回把第一回那份盖掉（用户手上那份就变了） |
 * | **不自动打开外部应用** | 这条不在本文件量（它压根没有打开动作）——**没有那个调用**就是它的判据 |
 * | **落系统临时目录** | 往用户仓库里丢文件（「看一眼图」不该改工作区） |
 *
 * ⚠️ **名字来自用户盘上的文件名**——直接拼进路径就是一次目录穿越，故清洗那一条单独钉。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IMAGE_DIR, saveImageFile } from '../src/image-file.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])

/** 收摊：把这一趟写出去的几个文件删掉（目录留着——别的用例还在用）。 */
function clean(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      rmSync(path)
    } catch {
      // 没写成就没得删
    }
  }
}

describe('导出原图：落一个文件', () => {
  test('成的时候给**路径**，字节一字不差', async () => {
    const saved = await saveImageFile({ name: '报错截图.png', mime: 'image/png', bytes: PNG })

    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    try {
      expect(existsSync(saved.path)).toBe(true)
      expect(new Uint8Array(readFileSync(saved.path))).toEqual(PNG)
      // 落在**系统临时目录**下一个自持的子目录里（不进工作区）
      expect(saved.path.startsWith(join(tmpdir(), IMAGE_DIR))).toBe(true)
      expect(saved.path).toContain('报错截图')
      expect(saved.path.endsWith('.png')).toBe(true)
    } finally {
      clean([saved.path])
    }
  })

  test('同一张图导两次得**两条路**（绝不覆盖前一份）', async () => {
    const first = await saveImageFile({ name: 'same.png', mime: 'image/png', bytes: PNG })
    const second = await saveImageFile({ name: 'same.png', mime: 'image/png', bytes: PNG })

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    try {
      expect(second.path).not.toBe(first.path)
      // 前一份**还在**（这才是「不覆盖」的意思）
      expect(existsSync(first.path)).toBe(true)
      expect(new Uint8Array(readFileSync(first.path))).toEqual(PNG)
    } finally {
      clean([first.path, second.path])
    }
  })

  test('文件名里的路径分隔符与控制字符被清洗（不穿越）', async () => {
    const saved = await saveImageFile({
      name: '../../../.ssh/authorized_keys',
      mime: 'image/png',
      bytes: PNG,
    })

    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    try {
      // 落点仍在那个目录**里面**（穿越没发生）
      expect(saved.path.startsWith(join(tmpdir(), IMAGE_DIR) + '/')).toBe(true)
      expect(saved.path).not.toContain('..')
      expect(saved.path).toContain('authorized_keys')
    } finally {
      clean([saved.path])
    }
  })

  test('原名没有扩展名时按 MIME 补一个（拿到手的路径得是能被认出来的那种）', async () => {
    const saved = await saveImageFile({ name: '剪贴板', mime: 'image/jpeg', bytes: PNG })

    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    try {
      expect(saved.path.endsWith('.jpg')).toBe(true)
    } finally {
      clean([saved.path])
    }
  })
})
