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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Materials } from '@magic/contracts'
import { createMaterials } from '../src/materials.ts'
import { createWorkspaceService } from '../src/workspace.ts'

// —— 夹具 ——

function sandbox(): { readonly at: string; dispose: () => void } {
  const at = mkdtempSync(join(tmpdir(), 'magic-materials-'))
  return { at, dispose: () => rmSync(at, { recursive: true, force: true }) }
}

function put(root: string, relative: string, text: string): string {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

function materialsAt(root: string): Materials {
  return createMaterials({ workspace: createWorkspaceService({ roots: [root] }) })
}

// —— 读文件 ——

describe('U36 · 文件：按身份取，到上限为止，只收文本', () => {
  test('正文就是当前那一份（排队期间改了也不冻结——用的那一刻读）', async () => {
    const sand = sandbox()
    try {
      put(sand.at, 'src/需求.md', '第一版')
      const materials = materialsAt(sand.at)

      const first = await materials.load([{ kind: 'file', source: join(sand.at, 'src/需求.md') }])
      expect(first.ok && first.materials[0]?.text).toBe('第一版')

      // 用之前改了文件——下一趟读到的是新的（设计：材料动态读取，不做版本）
      put(sand.at, 'src/需求.md', '第二版')
      const second = await materials.load([{ kind: 'file', source: join(sand.at, 'src/需求.md') }])
      expect(second.ok && second.materials[0]?.text).toBe('第二版')
    } finally {
      sand.dispose()
    }
  })

  test('超上限即截断，且**如实标**（`truncated`）', async () => {
    const sand = sandbox()
    try {
      put(sand.at, 'big.txt', 'x'.repeat(70 * 1024))
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: join(sand.at, 'big.txt') }])
      expect(read.ok).toBe(true)
      if (!read.ok) return

      const material = read.materials[0]
      expect(material?.kind === 'file' && material.truncated).toBe(true)
      expect(material?.text.length).toBe(64 * 1024)
    } finally {
      sand.dispose()
    }
  })

  test('二进制（含 NUL）**不当文本解码**——给出确定的拒绝与出口', async () => {
    const sand = sandbox()
    try {
      const path = join(sand.at, 'png.bin')
      writeFileSync(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: path }])
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.reason).toContain('二进制')
      expect(read.reason).toContain('工具') // 出口：让它用工具去处理
    } finally {
      sand.dispose()
    }
  })

  test('读不出 UTF-8 的同样拒（不是文本，就不装成文本）', async () => {
    const sand = sandbox()
    try {
      const path = join(sand.at, 'gbk.txt')
      writeFileSync(path, new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xff, 0xfe]))
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: path }])
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.reason).toContain('UTF-8')
    } finally {
      sand.dispose()
    }
  })

  test('不在的、以及「文件说成目录」的——都指着那一份说清', async () => {
    const sand = sandbox()
    try {
      put(sand.at, 'src/a.ts', 'a')
      const materials = materialsAt(sand.at)

      const missing = await materials.load([{ kind: 'file', source: join(sand.at, 'src/gone.ts') }])
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.reason).toContain('不在了')

      const asFile = await materials.load([{ kind: 'file', source: join(sand.at, 'src') }])
      expect(asFile.ok).toBe(false)
      if (!asFile.ok) expect(asFile.reason).toContain('目录')
    } finally {
      sand.dispose()
    }
  })

  test('**成套**：一份取不到，整批都不给（不发残缺输入）', async () => {
    const sand = sandbox()
    try {
      put(sand.at, 'a.txt', '甲')
      const materials = materialsAt(sand.at)

      const read = await materials.load([
        { kind: 'file', source: join(sand.at, 'a.txt') },
        { kind: 'file', source: join(sand.at, 'b.txt') },
      ])

      expect(read.ok).toBe(false)
    } finally {
      sand.dispose()
    }
  })

  test('总量超限整批拒，并说清怎么办（不静默少带）', async () => {
    const sand = sandbox()
    try {
      for (const name of ['a', 'b', 'c', 'd', 'e']) put(sand.at, `${name}.txt`, 'x'.repeat(60 * 1024))
      const materials = materialsAt(sand.at)

      const read = await materials.load(
        ['a', 'b', 'c', 'd', 'e'].map((name) => ({ kind: 'file' as const, source: join(sand.at, `${name}.txt`) })),
      )

      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.reason).toContain('去掉几份')
    } finally {
      sand.dispose()
    }
  })
})

// —— 目录 ——

describe('U36 · 目录：有界清单，明确未展开的部分', () => {
  test('只列一层，目录带尾斜杠；未列出的如实报数', async () => {
    const sand = sandbox()
    try {
      put(sand.at, 'src/a.ts', 'a')
      put(sand.at, 'src/sub/b.ts', 'b')
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'dir', source: join(sand.at, 'src') }])
      expect(read.ok).toBe(true)
      if (!read.ok) return

      const material = read.materials[0]
      expect(material?.kind).toBe('dir')
      // 一层：`sub/` 在里面，`sub/b.ts` 不在（不递归塞进整个项目）
      expect(material?.text).toBe('a.ts\nsub/')
      expect(material?.kind === 'dir' && material.omitted).toBeUndefined()
    } finally {
      sand.dispose()
    }
  })

  test('超过条数上限：列到上限为止，**报数**（不静默少列）', async () => {
    const sand = sandbox()
    try {
      for (let at = 0; at < 205; at += 1) put(sand.at, `many/f${String(at).padStart(3, '0')}.txt`, 'x')
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'dir', source: join(sand.at, 'many') }])
      expect(read.ok).toBe(true)
      if (!read.ok) return

      const material = read.materials[0]
      expect(material?.text.split('\n')).toHaveLength(200)
      expect(material?.kind === 'dir' ? material.omitted : undefined).toBe(5)
    } finally {
      sand.dispose()
    }
  })

  test('不可读的目录给确定的拒绝（不是一句「读不了」）', async () => {
    const sand = sandbox()
    try {
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'dir', source: join(sand.at, 'nope') }])
      expect(read.ok).toBe(false)
      if (!read.ok) expect(read.reason).toContain('不在了')
    } finally {
      sand.dispose()
    }
  })
})

// —— 工作区外 ——

describe('U36 · 工作区外：不因输入获准，只收用户明确选定的那一个文件', () => {
  test('没带 `external` 的外部路径 ⇒ 拒（输入 `@` 或粘贴都不获准）', async () => {
    const sand = sandbox()
    const outside = sandbox()
    try {
      put(outside.at, 'notes.md', '外面的笔记')
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: join(outside.at, 'notes.md') }])
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.reason).toContain('工作区外')
      expect(read.reason).toContain('用户明确选定')
    } finally {
      sand.dispose()
      outside.dispose()
    }
  })

  test('用户明确选定（`external`）⇒ 只读附件读得到；目录仍不收', async () => {
    const sand = sandbox()
    const outside = sandbox()
    try {
      put(outside.at, 'notes.md', '外面的笔记')
      const materials = materialsAt(sand.at)

      const file = await materials.load([
        { kind: 'file', source: join(outside.at, 'notes.md'), external: true },
      ])
      expect(file.ok && file.materials[0]?.text).toBe('外面的笔记')
      // 身份是**真路径**（`realpath` 之后）——`/var` 在 macOS 上实为 `/private/var`
      expect(file.ok && file.materials[0]?.label).toBe(realpathSync(join(outside.at, 'notes.md')))

      const dir = await materials.load([{ kind: 'dir', source: outside.at, external: true }])
      expect(dir.ok).toBe(false)
      if (!dir.ok) expect(dir.reason).toContain('单个文件')
    } finally {
      sand.dispose()
      outside.dispose()
    }
  })
})

// —— 候选 ——

describe('U36 · 路径候选：只列一层，工作区外不做目录浏览', () => {
  test('相对写法按默认根列一层，按名排序；目录与文件分得开', async () => {
    const sand = sandbox()
    try {
      put(sand.at, 'src/a.ts', 'a')
      put(sand.at, 'src/login.ts', 'b')
      put(sand.at, 'src/sub/c.ts', 'c')
      const materials = materialsAt(sand.at)

      const all = await materials.candidates('src/', 30)
      expect(all.rows.map((row) => row.display)).toEqual(['src/a.ts', 'src/login.ts', 'src/sub'])
      expect(all.rows.map((row) => row.kind)).toEqual(['file', 'file', 'directory'])
      expect(all.rows.every((row) => row.external === false)).toBe(true)

      const filtered = await materials.candidates('src/log', 30)
      expect(filtered.rows.map((row) => row.display)).toEqual(['src/login.ts'])
    } finally {
      sand.dispose()
    }
  })

  test('打全的那一条照收；条数封顶时如实报「还有 N 条」', async () => {
    const sand = sandbox()
    try {
      for (let at = 0; at < 40; at += 1) put(sand.at, `many/f${String(at).padStart(3, '0')}.txt`, 'x')
      const materials = materialsAt(sand.at)

      const capped = await materials.candidates('many/', 30)
      expect(capped.rows).toHaveLength(30)
      expect(capped.note).toContain('还有 10 条')

      const exact = await materials.candidates('many/f001.txt', 30)
      expect(exact.rows.map((row) => row.display)).toEqual(['many/f001.txt'])
    } finally {
      sand.dispose()
    }
  })

  test('工作区外：**只认打全的那一条文件**；目录不列（一句说明指路）', async () => {
    const sand = sandbox()
    const outside = sandbox()
    try {
      put(outside.at, 'notes.md', '外面的笔记')
      const materials = materialsAt(sand.at)

      const file = await materials.candidates(join(outside.at, 'notes.md'), 30)
      expect(file.rows).toHaveLength(1)
      expect(file.rows[0]?.external).toBe(true)
      expect(file.rows[0]?.display).toBe(realpathSync(join(outside.at, 'notes.md')))

      const dir = await materials.candidates(`${outside.at}/`, 30)
      expect(dir.rows).toEqual([])
      expect(dir.note).toContain('只收单个文件')
    } finally {
      sand.dispose()
      outside.dispose()
    }
  })
})
