/**
 * U02 · 记录库 —— **判据 2（blob 往返 ＋ 写权唯一）**。
 *
 * 往返：大负载落 `blobs/` 文件 → 读回引用一致（条目只存引用，字节不进条目表）。
 * 写权唯一：全仓 `packages/ x /src` 里，**字面量 `'blobs'` 只许出现在本包**——
 * 别处要落 blob 只能经 `RecordsService.blobs`（技术方案 · 记录 · 标量口径 v0）。
 *
 * 最后一条是**仓库级不变量**，守护本体是根 `test/scaffold.test.ts`（fs 只许 records /
 * execution 两域）；本文件自持一份落点扫描，免得这条判据在本包内空转——
 * 将来可移交守护扩面（见回报 · 备案）。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import ts from 'typescript'
import type { Entry } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/** blob 目录名——判据里独立写出（不引自实现，防实现改名后测试跟着漂）。 */
const BLOBS_DIR = 'blobs'

describe('判据 2 · blob 往返', () => {
  test('大负载落盘、读回逐字节相等（字符串与字节两形态）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir })
      const records = store.serviceFor('s-blob')

      const bigText = '第一行输出\n第二行输出\n'.repeat(20_000) // ≈ 400KB
      const textRef = await records.blobs.put(bigText)

      // 引用不透明——但落点是可知的：`<dataDir>/blobs/<ref>`
      expect(existsSync(join(dir, BLOBS_DIR, textRef))).toBe(true)
      expect(textRef).not.toContain('/') // 引用是键，不是路径

      const textBack = new TextDecoder().decode(await records.blobs.get(textRef))
      expect(textBack).toBe(bigText)

      const bytes = new Uint8Array(100_000)
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7) % 256
      const byteRef = await records.blobs.put(bytes)
      expect(await records.blobs.get(byteRef)).toEqual(bytes)

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('条目存引用——内容与工具输出两处都是引用，读回一致', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir })
      const records = store.serviceFor('s-blob')

      const contentRef = await records.blobs.put('很长很长的一段正文…'.repeat(5_000)) // ≈ 60KB
      const outputRef = await records.blobs.put('命令输出：\n'.repeat(30_000)) // ≈ 180KB

      const id = records.appendEntry({
        kind: 'tool-result',
        content: { blob: contentRef },
        payload: { ok: true, output: { blob: outputRef } },
        at: 1_700_000_000_000,
      })

      const read: Entry[] = []
      for await (const entry of records.readEntries('s-blob')) read.push(entry)

      expect(read).toEqual([
        {
          id,
          kind: 'tool-result',
          content: { blob: contentRef },
          payload: { ok: true, output: { blob: outputRef } },
          at: 1_700_000_000_000,
        },
      ])
      expect(await records.blobs.get(contentRef)).toEqual(
        new TextEncoder().encode('很长很长的一段正文…'.repeat(5_000)),
      )

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('内容寻址——同内容只落一份（幂等）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir })
      const records = store.serviceFor('s-blob')

      const first = await records.blobs.put('同一份负载')
      const second = await records.blobs.put('同一份负载')
      const third = await records.blobs.put(new TextEncoder().encode('同一份负载'))

      expect(second).toBe(first)
      expect(third).toBe(first)
      expect(readdirSync(join(dir, BLOBS_DIR))).toEqual([first]) // 一份，且不留临时文件

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('引用入口把住——非法引用（含路径穿越）拒读', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir })
      const records = store.serviceFor('s-blob')
      const ref = await records.blobs.put('正经负载')

      // 穿越形态：即便库里混进了别的字符串，也不该变成一次任意文件读
      await expect(records.blobs.get('../../etc/passwd')).rejects.toThrow(/非法 blob 引用/)
      await expect(records.blobs.get(`${ref}/../x`)).rejects.toThrow(/非法 blob 引用/)
      await expect(records.blobs.get('')).rejects.toThrow(/非法 blob 引用/)
      // 本包产出的引用照常可读
      expect(new TextDecoder().decode(await records.blobs.get(ref))).toBe('正经负载')

      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})

describe('判据 2 · 写权唯一（全仓 `blobs/` 落点扫描）', () => {
  test('字面量 `blobs` 只出现在 `packages/records/src`', async () => {
    const hits: string[] = []
    let scanned = 0

    for (const packageDir of packageDirs()) {
      const glob = new Bun.Glob('src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}')

      for await (const file of glob.scan({ cwd: join(PACKAGES_DIR, packageDir) })) {
        const absolute = join(PACKAGES_DIR, packageDir, file)
        scanned += 1
        if (stringLiteralsOf(absolute, readFileSync(absolute, 'utf8')).includes(BLOBS_DIR)) {
          hits.push(join(packageDir, file))
        }
      }
    }

    expect(scanned).toBeGreaterThan(0) // 扫描面不得为空——目录改名时宁可失败，也不要静默空转
    expect(hits.filter((hit) => !hit.startsWith(`records${sep}src${sep}`))).toEqual([])
    expect(hits.length).toBeGreaterThan(0) // 本包必须命中——否则扫的是空气
  })
})

/** 存在的包目录名（`packages/<dir>/package.json`）。 */
function packageDirs(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(PACKAGES_DIR, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort()
}

/**
 * 源码里的**字符串字面量**——走 TS AST，故注释与标识符不误判
 * （本判据要的正是「谁在构造那个路径」，注释里提一嘴不算）。
 */
function stringLiteralsOf(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false)
  const literals: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text)
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return literals
}
