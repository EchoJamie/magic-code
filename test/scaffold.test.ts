/**
 * 仓库级脚手架守护（U01）。
 *
 * 三组守护，对应三条已冻结合同（技术方案 · 代码治理）：
 * 1. 分包可用 —— 三包经 Bun workspaces 链接、可被消费者解析加载；
 * 2. 依赖单向 —— kernel ← tui ← app，**声明**与**源码落点**皆不得越界；
 * 3. 可执行名 —— `magic` 已装配到根 `.bin`。
 *
 * 机制不靠记性（设计准则 3）：越界在这里失败，而不是等人想起。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..')
const PACKAGES = ['kernel', 'tui', 'app'] as const

/** 包名 → 允许依赖的 `@magic/*` 包（依赖单向：kernel ← tui ← app）。 */
const ALLOWED: Record<string, readonly string[]> = {
  '@magic/kernel': [],
  '@magic/tui': ['@magic/kernel'],
  '@magic/app': ['@magic/kernel', '@magic/tui'],
}

/** 扫描面——包目录下的全部源码（含包级 test）；扩展名不设限：.tsx 是 tui 的将来形态。 */
const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'

/** 相对说明符的补全候选（按序试探）。 */
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']
const INDEX_SUFFIXES = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.cjs']

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
}

interface Manifest {
  name: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  bin?: Record<string, string>
}

function manifestOf(dir: string): Manifest {
  return JSON.parse(
    readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8'),
  ) as Manifest
}

// —— 越界判定 ——

function candidatesOf(base: string): string[] {
  return [
    ...RESOLVE_SUFFIXES.map((suffix) => base + suffix),
    ...INDEX_SUFFIXES.map((suffix) => base + suffix),
  ]
}

/** 说明符的落点（绝对路径）；解析不了（内建 / 未安装的依赖）返回 undefined。 */
function landingOf(specifier: string, fromFile: string): string | undefined {
  const from = dirname(fromFile)

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return candidatesOf(resolve(from, specifier)).find((candidate) => existsSync(candidate))
  }

  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return undefined

  try {
    return Bun.resolveSync(specifier, from)
  } catch {
    return undefined
  }
}

/** 落点所属的包目录名；落在任何包之外（依赖 / 系统）返回 undefined。 */
function owningPackage(landing: string): string | undefined {
  return PACKAGES.find((dir) => {
    const root = join(ROOT, 'packages', dir)
    return landing === root || landing.startsWith(root + sep)
  })
}

/**
 * 一条引用是否越界。**双轨**——
 * 一轨看说明符字面：`@magic/<别的包>` 一律越界（解析不到也算：未声明依赖同样是越界）；
 * 二轨看解析落点：落在别的包目录内即越界——相对路径与深链由此覆盖。
 */
function isCrossing(
  specifier: string,
  fromFile: string,
  packageName: string,
  packageDir: string,
): boolean {
  if (specifier.startsWith('@magic/')) {
    const target = specifier.split('/', 2).join('/')
    if (target === packageName) return false // 自引用——不经包边界
    const allowed = ALLOWED[packageName] ?? []
    if (!allowed.includes(target)) return true
    return specifier.length > target.length // 已允许的包：深链他人内部同样越界
  }

  const landing = landingOf(specifier, fromFile)
  if (landing === undefined) return false
  const owner = owningPackage(landing)
  return owner !== undefined && owner !== packageDir
}

// —— 说明符提取（AST：注释与字符串里的示例文本天然排除）——

function scriptKindOf(fileName: string): ts.ScriptKind {
  return SCRIPT_KINDS[fileName.slice(fileName.lastIndexOf('.'))] ?? ts.ScriptKind.TS
}

function importSpecifiersOf(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindOf(fileName),
  )
  const specifiers: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const { moduleSpecifier } = node
      if (moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
        specifiers.push(moduleSpecifier.text)
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const { expression } = node.moduleReference
      if (ts.isStringLiteral(expression)) specifiers.push(expression.text)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const lazy =
        (ts.isIdentifier(callee) && callee.text === 'require') ||
        callee.kind === ts.SyntaxKind.ImportKeyword
      const [first] = node.arguments
      if (lazy && first !== undefined && ts.isStringLiteral(first)) specifiers.push(first.text)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

// —— 扫描 ——

async function sourceFilesOf(packageDir: string): Promise<string[]> {
  const files: string[] = []
  const glob = new Bun.Glob(SOURCE_GLOB)

  for await (const file of glob.scan({ cwd: join(ROOT, 'packages', packageDir) })) {
    if (file.split(sep).includes('node_modules')) continue
    files.push(file)
  }

  return files
}

/** 某包源码里的越界引用（`文件 → 说明符`，便于定位）。 */
async function crossingsOf(packageDir: string, packageName: string): Promise<string[]> {
  const crossings: string[] = []

  for (const file of await sourceFilesOf(packageDir)) {
    const absolute = join(ROOT, 'packages', packageDir, file)
    const source = readFileSync(absolute, 'utf8')

    for (const specifier of importSpecifiersOf(absolute, source)) {
      if (isCrossing(specifier, absolute, packageName, packageDir)) {
        crossings.push(`${file} → ${specifier}`)
      }
    }
  }

  return crossings
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

describe('依赖单向（声明）', () => {
  test('包声明的依赖不越界（dependencies 与 devDependencies 同查）', () => {
    for (const dir of PACKAGES) {
      const { name, dependencies, devDependencies } = manifestOf(dir)
      const allowed = ALLOWED[name] ?? []
      const declared = [...Object.keys(dependencies ?? {}), ...Object.keys(devDependencies ?? {})]
      const crossed = declared.filter(
        (dep) => dep.startsWith('@magic/') && !allowed.includes(dep),
      )

      expect(crossed).toEqual([])
    }
  })
})

describe('依赖单向（源码落点）', () => {
  test('各包源码的引用不越出包边界', async () => {
    for (const dir of PACKAGES) {
      const { name } = manifestOf(dir)

      // 守护面不得为空——目录改名 / 清空时宁可失败，也不要静默空转
      expect((await sourceFilesOf(dir)).length).toBeGreaterThan(0)
      expect(await crossingsOf(dir, name)).toEqual([])
    }
  })
})

describe('越界判定（反向用例）', () => {
  const kernelEntry = join(ROOT, 'packages/kernel/src/index.ts')
  const judgeKernel = (specifier: string): boolean =>
    isCrossing(specifier, kernelEntry, '@magic/kernel', 'kernel')

  test('相对路径跨包＝越界', () => {
    expect(judgeKernel('../../tui/src/index.ts')).toBe(true)
    expect(judgeKernel('../../app/src/index.ts')).toBe(true)
  })

  test('裸包名跨包＝越界——解析不到也算（未声明依赖同样是越界）', () => {
    expect(judgeKernel('@magic/tui')).toBe(true)
    expect(judgeKernel('@magic/app')).toBe(true)
  })

  test('深链他人内部＝越界', () => {
    expect(isCrossing('@magic/kernel/src/records', kernelEntry, '@magic/tui', 'tui')).toBe(true)
  })

  test('本包内引用＝不越界', () => {
    expect(judgeKernel('./index.ts')).toBe(false)
    expect(judgeKernel('@magic/kernel')).toBe(false)
  })

  test('外部依赖与内建＝不越界', () => {
    expect(judgeKernel('typescript')).toBe(false)
    expect(judgeKernel('node:fs')).toBe(false)
    expect(judgeKernel('bun:test')).toBe(false)
  })

  test('注释与字符串里的示例文本不误判', () => {
    const source = [
      `// 用法示例：import { run } from '@magic/tui'`,
      `/* export * from '../../app/src/index.ts' */`,
      `const doc = "import x from '@magic/app'"`,
    ].join('\n')

    expect(importSpecifiersOf(kernelEntry, source)).toEqual([])
  })

  test('require / 动态 import / export-from / import-equals 都被提取', () => {
    const source = [
      `import { a } from './a.ts'`,
      `export * from './b.ts'`,
      `import legacy = require('./c.cjs')`,
      `const lazy = await import('./d.ts')`,
      `const also = require('@magic/tui')`,
    ].join('\n')

    expect(importSpecifiersOf(kernelEntry, source)).toEqual([
      './a.ts',
      './b.ts',
      './c.cjs',
      './d.ts',
      '@magic/tui',
    ])
  })
})

describe('可执行名', () => {
  test('`magic` 已装配到根 .bin（根声明了 @magic/app）', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest
    const { bin } = manifestOf('app')

    expect(root.dependencies?.['@magic/app']).toBeDefined()
    expect(bin?.magic).toBeDefined()
    expect(existsSync(join(ROOT, 'node_modules/.bin/magic'))).toBe(true)
  })
})
