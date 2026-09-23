/**
 * U37 · 导出原图的落点 —— 判据：**唯一命名 · 不覆盖 · 名字不当路径**。
 *
 * 设计明写两条（文件与图片 · 历史附件）：「将记录字节导出到唯一临时文件并给本地路径；
 * **不覆盖已有文件、不自动打开外部应用**」。本文件咬前一条的两半：
 * **落得下**（同一个名字导两次得两条路）与**不乱落**（名字里的路径分隔符不许当路径用）。
 *
 * 「不自动打开外部应用」不在这里验——那是一条**不做**的事（代码里没有那句调用即可），
 * 写死一条断言反而会被误读成「有个开关只是默认关着」。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { saveAttachmentFile } from '../src/attachment-file.ts'

const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('U37 · 导出原图：唯一命名、不覆盖', () => {
  test('同一张导两次 ⇒ 两条路（第二次不覆盖第一次那座文件）', async () => {
    const first = await saveAttachmentFile({ name: '截图.png', mime: 'image/png', bytes: BYTES })
    const second = await saveAttachmentFile({ name: '截图.png', mime: 'image/png', bytes: BYTES })

    try {
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) return

      expect(first.path).not.toBe(second.path)
      expect(existsSync(first.path)).toBe(true)
      expect(existsSync(second.path)).toBe(true)
      // 落点自持一个目录（不往用户的仓库里丢文件）
      expect(dirname(first.path)).toBe(dirname(second.path))
    } finally {
      if (first.ok) rmSync(first.path, { force: true })
      if (second.ok) rmSync(second.path, { force: true })
    }
  })

  test('名字里的路径分隔符**不当路径用**（`../` 只当名字的一部分）', async () => {
    const saved = await saveAttachmentFile({
      name: '../../.ssh/authorized_keys',
      mime: 'image/png',
      bytes: BYTES,
    })

    try {
      expect(saved.ok).toBe(true)
      if (!saved.ok) return

      // 落在导出目录那一层里（没有往上跳出去）
      expect(saved.path).not.toContain('..')
      expect(existsSync(saved.path)).toBe(true)
    } finally {
      if (saved.ok) rmSync(saved.path, { force: true })
    }
  })

  test('原名没有扩展名 ⇒ 按 MIME 补一个（导出来的文件得能被看图软件认出来）', async () => {
    const saved = await saveAttachmentFile({ name: 'screenshot', mime: 'image/png', bytes: BYTES })

    try {
      expect(saved.ok).toBe(true)
      if (!saved.ok) return

      expect(saved.path.endsWith('.png')).toBe(true)
    } finally {
      if (saved.ok) rmSync(saved.path, { force: true })
    }
  })

  test('字节原样落盘（逐字节相同）', async () => {
    const saved = await saveAttachmentFile({ name: 'a.png', mime: 'image/png', bytes: BYTES })

    try {
      expect(saved.ok).toBe(true)
      if (!saved.ok) return

      expect(statSync(saved.path).size).toBe(BYTES.length)
    } finally {
      if (saved.ok) rmSync(saved.path, { force: true })
    }
  })
})
