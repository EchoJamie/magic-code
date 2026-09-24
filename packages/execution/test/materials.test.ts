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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Material, Materials } from '@magic/contracts'
import { createMaterials } from '../src/materials.ts'
import { createWorkspaceService } from '../src/workspace.ts'

// —— 夹具 ——

/**
 * 材料 → 文本。**只有文本那两支有正文**（U37 起 `Material` 多了图片支，它的内容是字节）——
 * 用例关心的是「按路径读到了什么字」，故这一处把图片那支收成 `undefined`，
 * 图片自己的判据在下面那一节单写。
 */
function textOf(material: Material | undefined): string | undefined {
  return material === undefined || material.kind === 'image' ? undefined : material.text
}

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
      expect(first.ok && textOf(first.materials[0])).toBe('第一版')

      // 用之前改了文件——下一趟读到的是新的（设计：材料动态读取，不做版本）
      put(sand.at, 'src/需求.md', '第二版')
      const second = await materials.load([{ kind: 'file', source: join(sand.at, 'src/需求.md') }])
      expect(second.ok && textOf(second.materials[0])).toBe('第二版')
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
      expect(textOf(material)?.length).toBe(64 * 1024)
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

  // ⚠️ **改判（U63）**：原先这里测的是「一次交代里全部文本材料的合计上限（256 KiB 字符）
  // 超了整批拒」——那一条守的是「十条交代拼起来会把这一次请求撑爆」。送达方式改成
  // 「模型按需自读」之后**它的由头没了**：文本材料的正文一个字都不进请求（见
  // `DEFAULT_MATERIAL_BYTES` 的注），留着它只会按一个已不成立的理由把好事拒掉。
  // 故本条改成**反过来断**：一次带五份大文件照取不误，且每份仍按单份上限截断。
  test('文本材料不再有合计上限（U63 自读）——五份大文件照取，单份仍按 64 KiB 截断', async () => {
    const sand = sandbox()
    try {
      for (const name of ['a', 'b', 'c', 'd', 'e']) put(sand.at, `${name}.txt`, 'x'.repeat(60 * 1024))
      const materials = materialsAt(sand.at)

      const read = await materials.load(
        ['a', 'b', 'c', 'd', 'e'].map((name) => ({ kind: 'file' as const, source: join(sand.at, `${name}.txt`) })),
      )

      expect(read.ok).toBe(true)
      expect(read.ok && read.materials).toHaveLength(5)
      // 单份那一把尺子照旧（60 KiB < 64 KiB，故这一批都没被截）
      expect(read.ok && read.materials[0]?.kind === 'file' && read.materials[0].truncated).toBeFalsy()
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
      expect(textOf(material)).toBe('a.ts\nsub/')
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
      expect(textOf(material)?.split('\n')).toHaveLength(200)
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
      expect(file.ok && textOf(file.materials[0])).toBe('外面的笔记')
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

// —— 符号链接：真身在根外就是根外（词法兜底不许把它拉回来）——

describe('U36 · 链接绕出去：候选不列、load 不给当「里头的」读', () => {
  /** 沙地 ＋ 一条**指向沙地外**的链接（`link` → 外面那个目录）。 */
  function linked(): {
    readonly inside: string
    readonly outside: string
    readonly dispose: () => void
  } {
    const inside = mkdtempSync(join(tmpdir(), 'magic-link-in-'))
    const outside = mkdtempSync(join(tmpdir(), 'magic-link-out-'))
    mkdirSync(join(outside, 'sub'), { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), '外面的东西', 'utf8')
    symlinkSync(outside, join(inside, 'link'))

    return {
      inside,
      outside,
      dispose: () => {
        rmSync(inside, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      },
    }
  }

  test('`@link/`：**不列**（借链接往外浏览被挡下），说明指得出缘由', async () => {
    const sand = linked()
    try {
      const materials = materialsAt(sand.inside)

      // 打全成目录的：落在**外面**那一支 ⇒ 不列，说明说得出「外面只收单个文件」
      const dir = await materials.candidates('link/', 30)
      expect(dir.rows).toEqual([])
      expect(dir.note).toContain('工作区外')

      // 往里打一层：真身在外面 ⇒ 同样不列
      const deeper = await materials.candidates('link/sub/', 30)
      expect(deeper.rows).toEqual([])
      expect(deeper.note).toContain('工作区外')

      // **写起来在根里、真身在外面的目录**（`link/nothing-here` 这种还没打全的写法）：
      // 也不许列——那一支专门挡「借工作区里的链接往外浏览」
      const borrowed = await materials.candidates('link/nothing-here', 30)
      expect(borrowed.rows).toEqual([])
      expect(borrowed.note).toContain('符号链接')
    } finally {
      sand.dispose()
    }
  })

  test('`load`（没带 external）⇒ **拒**：真身在外面，写起来在根里也不算里头', async () => {
    const sand = linked()
    try {
      const materials = materialsAt(sand.inside)
      const path = join(sand.inside, 'link', 'secret.txt')

      const read = await materials.load([{ kind: 'file', source: path }])
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.reason).toContain('工作区外')

      // 目录那一路同样拒（外部目录本来就不收）
      const dir = await materials.load([{ kind: 'dir', source: join(sand.inside, 'link') }])
      expect(dir.ok).toBe(false)
      if (!dir.ok) expect(dir.reason).toContain('工作区外')
    } finally {
      sand.dispose()
    }
  })

  test('打全那一条＋明确选定（`external`）⇒ 只读读得到（真身认得出是外面那一个）', async () => {
    const sand = linked()
    try {
      const materials = materialsAt(sand.inside)
      const path = join(sand.inside, 'link', 'secret.txt')

      const candidates = await materials.candidates(path, 30)
      expect(candidates.rows).toHaveLength(1)
      expect(candidates.rows[0]?.external).toBe(true)
      expect(candidates.rows[0]?.display).toBe(realpathSync(join(sand.outside, 'secret.txt')))

      const read = await materials.load([{ kind: 'file', source: path, external: true }])
      expect(read.ok && textOf(read.materials[0])).toBe('外面的东西')
    } finally {
      sand.dispose()
    }
  })

  test('**在根内的链接**照旧当里头的用（链接本身不吓人，绕出去才挡）', async () => {
    const sand = linked()
    try {
      const materials = materialsAt(sand.inside)
      writeFileSync(join(sand.inside, 'real.txt'), '里头的', 'utf8')
      symlinkSync(join(sand.inside, 'real.txt'), join(sand.inside, 'alias.txt'))

      const read = await materials.load([{ kind: 'file', source: join(sand.inside, 'alias.txt') }])
      expect(read.ok && textOf(read.materials[0])).toBe('里头的')

      const rows = await materials.candidates('alias', 30)
      expect(rows.rows.map((row) => row.external)).toEqual([false])
    } finally {
      sand.dispose()
    }
  })
})

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

// —— 声明的别名（macOS：`/tmp/...` 与 `/private/tmp/...`）——

describe('U36 · 声明原形：文件不在了按「不在了」说，不误报成「工作区外」', () => {
  test('根用**用户写的那个写法**注册：在的读得到、不在的说「不在了」', async () => {
    // `mkdtempSync` 给的是 `/var/folders/…`，它的真身是 `/private/var/folders/…`——
    // 两者是同一个目录的两条写法（macOS 上 `path.resolve` 抹不平这一层）
    const sand = sandbox()
    try {
      put(sand.at, 'a.txt', '甲')
      const materials = materialsAt(sand.at)

      const found = await materials.load([{ kind: 'file', source: join(sand.at, 'a.txt') }])
      expect(found.ok && textOf(found.materials[0])).toBe('甲')

      const missing = await materials.load([{ kind: 'file', source: join(sand.at, 'gone.txt') }])
      expect(missing.ok).toBe(false)
      if (!missing.ok) {
        expect(missing.reason).toContain('不在了')
        expect(missing.reason).not.toContain('工作区外')
      }
    } finally {
      sand.dispose()
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

// ══ U37 · 图片：按字节认，走另一条出口 ═══════════════════════════════════

/**
 * 判据三件（对应工单的验收）：**真图取得到字节** · **坏文件与半张图当场拒绝** ·
 * **上限如实说**。图片这一支与文本那三把尺子（2000 字符截断 / NUL / UTF-8）**不相干**——
 * 它取的是字节、给的是字节。
 */
describe('U37 · 图片：按字节认，走另一条出口', () => {
  /** 1×1 真 PNG（67 字节）。 */
  const PNG = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  )

  function putBytes(root: string, relative: string, bytes: Uint8Array): string {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, bytes)
    return path
  }

  test('一张真图：取回来的是**字节 ＋ 认出来的类型**（不按扩展名猜）', async () => {
    const sand = sandbox()
    try {
      // 名字故意骗人：内容是 PNG，名字说 .jpg
      putBytes(sand.at, 'shot.jpg', PNG)
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: join(sand.at, 'shot.jpg') }])
      expect(read.ok).toBe(true)
      if (!read.ok) return

      const material = read.materials[0]
      expect(material?.kind).toBe('image')
      if (material?.kind !== 'image') return
      expect(material.mime).toBe('image/png') // **内容说了算**
      expect(material.name).toBe('shot.jpg') // 名字照旧（那是用户的叫法）
      expect([...material.bytes]).toEqual([...PNG]) // 逐字节，一个不少
    } finally {
      sand.dispose()
    }
  })

  test('没有扩展名也认得出（截图的常见样子）——内容就是判据', async () => {
    const sand = sandbox()
    try {
      putBytes(sand.at, '截图', PNG)
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: join(sand.at, '截图') }])
      expect(read.ok).toBe(true)
      if (!read.ok) return

      expect(read.materials[0]?.kind).toBe('image')
    } finally {
      sand.dispose()
    }
  })

  test('半截的图当场拒（不送半张出去让对面报错）', async () => {
    const sand = sandbox()
    try {
      // 尾巴（IEND 那一块）切掉 12 字节——文件还能读，但已经不是一张完整的 PNG
      putBytes(sand.at, 'cut.png', PNG.subarray(0, PNG.length - 12))
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: join(sand.at, 'cut.png') }])
      expect(read.ok).toBe(false)
      if (read.ok) return

      expect(read.reason).toContain('没传完')
      expect(read.reason).toContain('cut.png')
    } finally {
      sand.dispose()
    }
  })

  test('名字像图、内容不是：拒绝的那句话点破这一层（不让人往「换个文本工具」上找）', async () => {
    const sand = sandbox()
    try {
      put(sand.at, 'shot.png', '这不是图片，是一段文本')
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: join(sand.at, 'shot.png') }])
      expect(read.ok).toBe(true) // 内容能被当文本读——那就当文本读（**内容说了算**）
      if (!read.ok) return

      expect(textOf(read.materials[0])).toBe('这不是图片，是一段文本')

      // 真正的坏文件（名字像图、内容是二进制）才拒，且那句点破「文件可能坏了」
      putBytes(sand.at, 'broken.png', new Uint8Array([0x00, 0x01, 0x02, 0x00]))
      const broken = await materials.load([{ kind: 'file', source: join(sand.at, 'broken.png') }])
      expect(broken.ok).toBe(false)
      if (broken.ok) return

      expect(broken.reason).toContain('break.png'.replace('break', 'broken'))
      expect(broken.reason).toContain('坏')
    } finally {
      sand.dispose()
    }
  })

  test('超过单张上限：整条不跑，且说得出是**哪张、多大、怎么办**', async () => {
    const sand = sandbox()
    try {
      // 一张「大的」PNG：真魔数 ＋ 撑到上限之上，并以 IEND 收尾（结构底线过得去）
      const big = new Uint8Array(5 * 1024 * 1024 + 64)
      big.set(PNG.subarray(0, PNG.length - 12), 0)
      big.set(PNG.subarray(PNG.length - 12), big.length - 12)
      putBytes(sand.at, 'big.png', big)
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: join(sand.at, 'big.png') }])
      expect(read.ok).toBe(false)
      if (read.ok) return

      expect(read.reason).toContain('big.png')
      expect(read.reason).toContain('MiB')
      expect(read.reason).toContain('一份都没送出去')
    } finally {
      sand.dispose()
    }
  })

  test('工作区外那一张也走同一条出口（用户明确选定的只读附件）', async () => {
    const sand = sandbox()
    const outside = sandbox()
    try {
      const path = putBytes(outside.at, 'outside.png', PNG)
      const materials = materialsAt(sand.at)

      const read = await materials.load([{ kind: 'file', source: path, external: true }])
      expect(read.ok).toBe(true)
      if (!read.ok) return

      const material = read.materials[0]
      expect(material?.kind).toBe('image')
      // 没有 `external` 那一位就取不到（外部不因输入 `@` 获准——既有那条边界照旧）
      const refused = await materials.load([{ kind: 'file', source: path }])
      expect(refused.ok).toBe(false)
    } finally {
      sand.dispose()
      outside.dispose()
    }
  })
})
