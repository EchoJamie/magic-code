/**
 * U36 · 材料来源面 —— 判据：**按身份取得到 · 只收文本 · 有界且如实 · 工作区外不获准**。
 *
 * 本文件只咬**执行域这一半**（哪条路径、读到的是什么）：文件快照 · 目录有界清单 ·
 * 二进制的确定拒绝 · 候选只列一层 · 工作区外只收单个文件。「什么时候送进模型、
 * 送出去的那一份记在哪儿」归对话域与装配，判据在 `@magic/conversation` 与
 * `packages/app/test/refs.test.ts`。
 *
 * 判定法同 `skills.test.ts`：临时目录当真工作区（测试用 fs 不受守护拦——守护面收窄至
 * 各包 `src/`），每例把目录摆好再断言产物。
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Materials } from '@magic/contracts'
import { createMaterials } from '../src/materials.ts'
import { createWorkspaceService } from '../src/workspace.ts'

function sandbox(): { readonly at: string; dispose: () => void } {
  const at = mkdtempSync(join(tmpdir(), 'magic-materials-'))
  return { at, dispose: () => rmSync(at, { recursive: true, force: true }) }
}

function materialsAt(root: string): Materials {
  return createMaterials({ workspace: createWorkspaceService({ roots: [root] }) })
}

// —— 非普通文件 ——

describe('U36 · 非普通文件：不当文本读（否则会挂在 open 上）', () => {
  test('FIFO：**即拒**（`open` 会一直等写端——那一档根本不该去读）', async () => {
    const sand = sandbox()
    try {
      const path = join(sand.at, 'pipe')
      execFileSync('mkfifo', [path])

      const materials = materialsAt(sand.at)
      // ⚠️ 这一条要是没挡住，本用例会**挂到超时**（FIFO 上 `open(path,'r')` 等写端）
      const read = await materials.load([{ kind: 'file', source: path }])
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.reason).toContain('不是普通文件')

      // 候选里也不列（列出来也读不了）
      expect((await materials.candidates('pipe', 30)).rows).toEqual([])
    } finally {
      sand.dispose()
    }
  })

  test('**工作区外**的非普通文件同样不列（内外同一个类型判据）', async () => {
    const sand = sandbox()
    const outside = mkdtempSync(join(tmpdir(), 'magic-out-dev-'))
    try {
      const materials = materialsAt(sand.at)
      const pipe = join(outside, 'pipe')
      execFileSync('mkfifo', [pipe])

      // 反例（独立复核报的那一条）：`/dev/null` 曾被当成一条**可选的外部文件**给出去
      const device = await materials.candidates('/dev/null', 30)
      expect(device.rows).toEqual([])
      expect(device.note).toContain('普通文本文件')

      const fifo = await materials.candidates(pipe, 30)
      expect(fifo.rows).toEqual([])
      expect(fifo.note).toContain('普通文本文件')

      // load 两处都照旧安全拒绝（外部那一条同样走类型判据）
      expect((await materials.load([{ kind: 'file', source: '/dev/null', external: true }])).ok).toBe(false)
      const read = await materials.load([{ kind: 'file', source: pipe, external: true }])
      expect(read.ok).toBe(false)
      if (!read.ok) expect(read.reason).toContain('不是普通文件')
    } finally {
      sand.dispose()
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
