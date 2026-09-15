/**
 * 仓库级脚手架守护（U01）。
 *
 * 守护两条已冻结合同（技术方案 · 代码治理）：
 * 1. 分包可用 —— 三包经 Bun workspaces 链接、可被解析；
 * 2. 依赖单向 —— kernel ← tui ← app，声明与源码 import 皆不得越界。
 *
 * 机制不靠记性（设计准则 3）：越界在这里失败，而不是等人想起。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const PACKAGES = ['kernel', 'tui', 'app'] as const

/** 包名 → 允许依赖的 `@magic/*` 包（依赖单向：kernel ← tui ← app）。 */
const ALLOWED: Record<string, readonly string[]> = {
  '@magic/kernel': [],
  '@magic/tui': ['@magic/kernel'],
  '@magic/app': ['@magic/kernel', '@magic/tui'],
}

interface Manifest {
  name: string
  dependencies?: Record<string, string>
}

function manifestOf(dir: string): Manifest {
  return JSON.parse(
    readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8'),
  ) as Manifest
}

/** 收集目录下所有 .ts 文件里的模块说明符（含 `import` / `export ... from` / 动态 `import()`）。 */
async function importSpecifiers(dir: string): Promise<string[]> {
  const found: string[] = []
  const glob = new Bun.Glob('**/*.ts')

  for await (const file of glob.scan({ cwd: join(ROOT, dir) })) {
    const source = readFileSync(join(ROOT, dir, file), 'utf8')
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (specifier !== undefined) found.push(specifier)
    }
  }

  return found
}

describe('分包可用', () => {
  test('各包能解析并加载其声明的 workspace 依赖', async () => {
    for (const dir of PACKAGES) {
      const { dependencies } = manifestOf(dir)
      const from = join(ROOT, 'packages', dir)

      for (const dep of Object.keys(dependencies ?? {})) {
        const resolved = Bun.resolveSync(dep, from)
        await expect(import(resolved)).resolves.toBeDefined()
      }
    }
  })
})

describe('依赖单向', () => {
  test('包声明的依赖不越界', () => {
    for (const dir of PACKAGES) {
      const { name, dependencies } = manifestOf(dir)
      const allowed = ALLOWED[name] ?? []
      const crossed = Object.keys(dependencies ?? {}).filter(
        (dep) => dep.startsWith('@magic/') && !allowed.includes(dep),
      )

      expect(crossed).toEqual([])
    }
  })

  test('源码 import 不越界（内核不 import 外壳）', async () => {
    for (const dir of PACKAGES) {
      const { name } = manifestOf(dir)
      const allowed = ALLOWED[name] ?? []
      const specifiers = await importSpecifiers(`packages/${dir}/src`)
      const crossed = specifiers.filter(
        (s) => s.startsWith('@magic/') && !allowed.includes(s),
      )

      expect(crossed).toEqual([])
    }
  })
})
