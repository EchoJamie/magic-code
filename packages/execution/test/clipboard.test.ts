/**
 * U107 · **剪贴板取图那一跳**（执行域那一半）——判据两件。
 *
 * ## 一、「那一份字节能不能当图送」——两把尺子与按路径取图是同一把
 *
 * `imageBytesOf` 与 `readFileMaterial` 的图片那一支**共用**认图 · 单张上限 · 完整性
 * 三件判据（都是从同一处 import 的），只是没有路径可报，故说的是「剪贴板里这一张」。
 * 用例把三档都钉住：真图（过）· 超过单张上限（不过）· 半截的图（不过）。
 *
 * ## 二、「取回来的是什么样的字节」——**用桩替掉系统命令**，不碰真剪贴板
 *
 * `readClipboardImage` 走的是一条 `spawn` 命令的路（先 `pngpaste`，再 `osascript`）。
 * 用例在**临时目录里造几个命令桩**，把它**排到 `PATH` 最前面**——于是这一趟跑的是
 * **真代码、真 spawn、真读文件**，只是末端的命令是我们自己的：
 *
 * - 桩 `pngpaste` 吐一份 PNG ⇒ 取回的就是**那一份字节**（一个字节不差）；
 * - 桩 `pngpaste` 退非零（剪贴板没图的样子）＋ 桩 `osascript` 说 `EMPTY`
 *   ⇒ 走 osascript 那条，报「剪贴板是空的」；
 * - 桩 `osascript` 说 `NOIMAGE:4` ⇒ 报「只有文字或文件那一类」；
 * - `osascript` 那条命令**根本叫不动**（PATH 上那个名字是个目录 ⇒ spawn ENOENT）
 *   ⇒ 报「叫不动」，并点明 SSH 那条例外。
 *
 * ⚠️ **为什么不直接读真剪贴板**：那会把用户的剪贴板当夹具（跑一趟测试就换掉他
 * 复制的东西），而且结果随他手上是什么而变——判据验的就不是我们这段代码了。
 * 真剪贴板那一趟是**手工实测**过的（见 `验证/U107-剪贴板取图-20260930/`）。
 */

import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageBytesOf } from '../src/materials.ts'
import { readClipboardImage } from '../src/clipboard.ts'

/** 1×1 透明 PNG（67 字节，真文件——同 `images.test.ts` 那一份）。 */
const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

/** 半截的 PNG（砍掉尾巴——`IEND` 那块必在最后，见 `checkImageIntact`）。 */
const TRUNCATED = PNG.slice(0, 40)

describe('U107 · `imageBytesOf`：这一份字节能不能当图送', () => {
  test('真图 ⇒ 过，并给出按字节认出来的 MIME', () => {
    expect(imageBytesOf(PNG, '剪贴板里这一张')).toEqual({ ok: true, mime: 'image/png' })
  })

  test('**超过单张上限** ⇒ 不过，说的是剪贴板这一份（不是某个文件名）', () => {
    // 上限是 5 MiB；造一份比它大的「图」——只改长度，认图那一步照旧过得去
    const huge = new Uint8Array(5 * 1024 * 1024 + 1)
    huge.set(PNG, 0)

    const checked = imageBytesOf(huge, '剪贴板里这一张')
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.reason).toContain('剪贴板里这一张')
    expect(checked.reason).toContain('超过单张图片的上限 5 MiB')
    // ⚠️ **一句话里不许出现文件名**：它没有文件名
    expect(checked.reason).not.toContain('.png')
  })

  test('**半截的图** ⇒ 不过（送出去只会让对面报一个「图片坏了」）', () => {
    const checked = imageBytesOf(TRUNCATED, '剪贴板里这一张')
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.reason).toContain('没传完的 PNG')
  })

  test('认不出是图 ⇒ 不过（不是抛，是一句说得出的缘由）', () => {
    const checked = imageBytesOf(new Uint8Array([1, 2, 3, 4]), '剪贴板里这一张')
    expect(checked.ok).toBe(false)
  })
})

// —— 那两条系统命令的桩（只在这一组用例里顶上 PATH）——

/** 造一个临时 bin 目录，写上给定的命令桩；返回目录（调用方负责删）。 */
function stubBin(commands: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'u107-stub-'))

  for (const [name, script] of Object.entries(commands)) {
    const file = join(dir, name)
    writeFileSync(file, script, 'utf8')
    chmodSync(file, 0o755)
  }

  return dir
}

/**
 * 在一条**桩目录排在 PATH 最前**的环境里跑一趟取图（跑完原样还回去）。
 *
 * ⚠️ **是「排在最前」不是「换掉」**：桩脚本里用的 `cat` / `dirname` 是系统命令，
 * 把 PATH 整个换掉它们就没了（实测：那样桩什么都不吐，验的就不是产品了）。
 */
async function withStubs<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const before = process.env.PATH
  process.env.PATH = `${dir}:${before ?? ''}`

  try {
    return await body()
  } finally {
    process.env.PATH = before
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('U107 · `readClipboardImage`：取回来的是什么样的字节', () => {
  test('`pngpaste` 在 ⇒ **先走它**，取回的就是它吐的那一份字节', async () => {
    // 桩吐的是一份**可辨认**的字节：既验「走的是 pngpaste」，也验「字节原样过来」。
    // ⚠️ 载荷走**文件**（`cat` 出来），不写进脚本字面量——二进制经 shell 转义必被切坏，
    //    那样验的就是转义而不是产品了。
    const payload = Buffer.concat([Buffer.from(PNG), Buffer.from('U107MARK')])
    const bin = stubBin({ pngpaste: '#!/bin/sh\ncat "$(dirname "$0")/payload.bin"\n' })
    writeFileSync(join(bin, 'payload.bin'), payload)

    const got = await withStubs(bin, () => readClipboardImage())

    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(Buffer.from(got.bytes).equals(payload)).toBe(true)
  })

  test('`pngpaste` 没给出字节 ⇒ **往 osascript 那条走**（不是当场失败）', async () => {
    const bin = stubBin({
      // 剪贴板里没图时 pngpaste 的样子：退非零、什么都不吐
      pngpaste: '#!/bin/sh\nexit 1\n',
      osascript: '#!/bin/sh\necho EMPTY\n',
    })

    const got = await withStubs(bin, () => readClipboardImage())

    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.reason).toContain('剪贴板是空的')
  })

  test('只有文本 / 文件那一类 ⇒ 说的是那一件真事，不是笼统的「没有图」', async () => {
    const bin = stubBin({
      pngpaste: '#!/bin/sh\nexit 1\n',
      osascript: '#!/bin/sh\necho NOIMAGE:4\n',
    })

    const got = await withStubs(bin, () => readClipboardImage())

    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.reason).toContain('只有文字或文件那一类')
  })

  test('**叫不动 osascript** ⇒ 说得出「叫不动」，并点明 SSH 那条例外', async () => {
    // 造「这台机器上没有这条命令」那一形：PATH 上那个名字**是个目录**，spawn 报 ENOENT。
    //
    // ⚠️ **不能拿「一个没有执行位的同名文件」当这一形**（本来想这么做）：实测 Bun 的
    // `spawn` 遇到不可执行的同名文件会**继续往后找**，于是在开发机上就找到了真的
    // `/usr/bin/osascript`，读的成了**用户的真剪贴板**——判据随他手上有什么而变。
    // 目录那一条实测是 ENOENT（不再往后找），而 PATH 只给这一个目录，
    // 真命令一条都不会被摸到。
    const bin = mkdtempSync(join(tmpdir(), 'u107-stub-'))
    mkdirSync(join(bin, 'osascript'))

    const before = process.env.PATH
    process.env.PATH = bin
    try {
      const got = await readClipboardImage()

      expect(got.ok).toBe(false)
      if (got.ok) return
      expect(got.reason).toContain('osascript')
      expect(got.reason).toContain('远端')
    } finally {
      process.env.PATH = before
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
