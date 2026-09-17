/**
 * 仓库级守护（M05 重定 · 一域一包的机制保障）。
 *
 * 七组守护（技术方案 · 代码治理 · 边界纪律 ＋ 工程结构）：
 * 1. **包表完备** —— 存在的包必在包表内（防漏登记）；
 * 2. **分包可用** —— 各包经 Bun workspaces 链接、可被消费者解析加载；
 * 3. **域 → 契约** —— 非装配包只 import `@magic/contracts`（＋许可外部库白名单）；
 * 4. **域不认知外壳与装配** —— 域包不得 import `@magic/tui` / `@magic/app`；
 * 5. **内核 fs 边界** —— fs 触达只许 `@magic/records` · `@magic/execution`（扫描面＝各包 `src/`）；
 * 6. **契约包零运行时依赖**；
 * 7. **公开面** —— 各包 `exports` 只出 `.`（不出子路径、不暴露内部目录）。
 *
 * 判定法沿用旧结构已验证的一套：裸名字面 ＋ `Bun.resolveSync` **解析落点双轨**判越界 ·
 * TS AST 遍历取 import（注释与字符串天然排除）· glob 全后缀 · 范围到**包目录**（含包级 `test/`）·
 * `devDependencies` 一并查 · 附「扫描面非空」自检。
 * 两条旧教训不丢：**只认裸名会漏相对路径跨包**；**只查工作树不查暂存区会漏坏版本**（闸门侧）。
 *
 * 机制不靠记性（设计准则 3）：越界在这里失败，而不是等人想起。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..')
const PACKAGES_DIR = join(ROOT, 'packages')

/**
 * 包表（技术方案 · 工程结构）——**含尚未开工的包**：声明即在此，落地即受守护。
 * 值＝该包许可的 `@magic/*` 依赖（依赖单向：域 / 外壳 → contracts；app → 全部）。
 */
const PACKAGE_TABLE: Record<string, readonly string[]> = {
  '@magic/contracts': [],
  '@magic/conversation': ['@magic/contracts'],
  '@magic/records': ['@magic/contracts'],
  '@magic/model': ['@magic/contracts'],
  '@magic/tools': ['@magic/contracts'],
  '@magic/permission': ['@magic/contracts'],
  '@magic/execution': ['@magic/contracts'],
  '@magic/control': ['@magic/contracts'],
  '@magic/tui': ['@magic/contracts'],
  '@magic/faux': ['@magic/contracts'],
  '@magic/app': [
    '@magic/contracts',
    '@magic/conversation',
    '@magic/records',
    '@magic/model',
    '@magic/tools',
    '@magic/permission',
    '@magic/execution',
    '@magic/control',
    '@magic/tui',
    '@magic/faux',
  ],
}

/** 域包——受「域 → 契约」与「域不认知外壳与装配」两条纪律。 */
const DOMAIN_PACKAGES = [
  '@magic/conversation',
  '@magic/records',
  '@magic/model',
  '@magic/tools',
  '@magic/permission',
  '@magic/execution',
  '@magic/control',
]

/** 外壳与装配——域包不得 import。 */
const SHELL_PACKAGES = ['@magic/tui', '@magic/app']

/** 装配根——**唯一可跨多域**者（技术方案 · 边界纪律：装配根唯一）。 */
const ASSEMBLY_PACKAGE = '@magic/app'

/** 许可外部库（技术方案 · 工程结构 · 包表的「依赖」列）——非 `@magic` 的运行时依赖。 */
const ALLOWED_EXTERNAL: Record<string, readonly string[]> = {
  '@magic/model': ['ai', '@ai-sdk/openai-compatible'],
  '@magic/tui': ['ink'],
}

/**
 * fs 直触许可（技术方案 · 边界纪律）——内核仅 `records` · `execution` 两域
 * （记录库 / blob 与沙箱工作区）。
 */
const FS_ALLOWED_PACKAGES = ['@magic/records', '@magic/execution']

/** fs 模块族——import 即触达文件系统。 */
const FS_MODULES = [
  'node:fs',
  'fs',
  'node:fs/promises',
  'fs/promises',
  'bun:sqlite',
  'node:sqlite',
]

/** 不经 import 的 fs 全局调用——`Bun.write` 写侧静默（不报错、落错地方），尤需拦。 */
const FS_GLOBAL_METHODS = ['file', 'write']

/** 扫描面——包目录下的全部源码（含包级 `test/`）；扩展名不设限：`.tsx` 是外壳的将来形态。 */
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
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  exports?: Record<string, unknown>
  bin?: Record<string, string>
}

// —— 包发现与清单 ——

/** 包目录名缓存——同步惰性填（`owningPackage` 在同步判定里反复取用）。 */
let packageDirsCache: string[] | undefined

/**
 * 实际存在的包目录名（`packages/<dir>/package.json` 存在者）。
 *
 * ⚠️ 用 `readdirSync` 而**非** `Bun.Glob('*')`——实测 **Glob 的 `*` 不匹配目录**（返回空），
 * 拿它做包发现会静默扫出零个包（M05 落地时的第一版即栽在此）。
 */
function packageDirsOf(): string[] {
  packageDirsCache ??= readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(PACKAGES_DIR, entry.name, 'package.json')),
    )
    .map((entry) => entry.name)
    .sort()

  return packageDirsCache
}

function manifestOfDir(dir: string): Manifest {
  return JSON.parse(readFileSync(join(PACKAGES_DIR, dir, 'package.json'), 'utf8')) as Manifest
}

/** 存在的包（目录名 → 包名）。 */
function packagesOf(): { dir: string; name: string }[] {
  const found: { dir: string; name: string }[] = []

  for (const dir of packageDirsOf()) {
    const { name } = manifestOfDir(dir)
    if (name !== undefined) found.push({ dir, name })
  }

  return found
}

/** 某包许可的 `@magic/*` 依赖。 */
function allowedMagicDeps(name: string): readonly string[] {
  return PACKAGE_TABLE[name] ?? []
}

// —— 越界判定（双轨）——

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
  for (const dir of packageDirsOf()) {
    const root = join(PACKAGES_DIR, dir)
    if (landing === root || landing.startsWith(root + sep)) return dir
  }
  return undefined
}

/**
 * 一条引用是否越界。**双轨**——
 * 一轨看说明符字面：`@magic/<别的包>` 不在许可清单即越界（解析不到也算：未声明依赖同样是越界）；
 * 二轨看解析落点：落在别的包目录内即越界——**相对路径与深链由此覆盖**（旧守护的教训一）。
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
    if (!allowedMagicDeps(packageName).includes(target)) return true
    return specifier.length > target.length // 已允许的包：深链他人内部同样越界
  }

  const landing = landingOf(specifier, fromFile)
  if (landing === undefined) return false
  const owner = owningPackage(landing)
  return owner !== undefined && owner !== packageDir
}

/** 越界的分类（诊断用）——域认知外壳 / 装配越权 / 域间越界 / 其他。 */
function classifyCrossing(packageName: string, specifier: string): string {
  const target = specifier.startsWith('@magic/') ? specifier.split('/', 2).join('/') : undefined

  if (target !== undefined && SHELL_PACKAGES.includes(target) && DOMAIN_PACKAGES.includes(packageName)) {
    return '域认知外壳/装配'
  }
  if (packageName !== ASSEMBLY_PACKAGE && target !== undefined) return '非装配包跨域'
  return '包边界越界'
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

  for await (const file of glob.scan({ cwd: join(PACKAGES_DIR, packageDir) })) {
    if (file.split(sep).includes('node_modules')) continue
    files.push(file)
  }

  return files
}

/** 某包源码里的越界引用（`文件 → 说明符 [分类]`，便于定位）。 */
async function crossingsOf(packageDir: string, packageName: string): Promise<string[]> {
  const crossings: string[] = []

  for (const file of await sourceFilesOf(packageDir)) {
    const absolute = join(PACKAGES_DIR, packageDir, file)
    const source = readFileSync(absolute, 'utf8')

    for (const specifier of importSpecifiersOf(absolute, source)) {
      if (isCrossing(specifier, absolute, packageName, packageDir)) {
        crossings.push(`${file} → ${specifier}（${classifyCrossing(packageName, specifier)}）`)
      }
    }
  }

  return crossings
}

// —— 内核 fs 边界 ——

/** 不经 import 的 fs 全局调用（`Bun.file` / `Bun.write`）——单查说明符会漏。 */
function fsGlobalCallsOf(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindOf(fileName),
  )
  const calls: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const { expression, name } = callee
        if (expression.text === 'Bun' && FS_GLOBAL_METHODS.includes(name.text)) {
          calls.push(`Bun.${name.text}`)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return calls
}

/** 文件里的 fs 触达点——模块说明符（含 `require` / 动态 `import`）与 `Bun` 全局调用。 */
function fsTouchesOf(fileName: string, source: string): string[] {
  const modules = importSpecifiersOf(fileName, source).filter((specifier) =>
    FS_MODULES.includes(specifier),
  )
  return [...modules, ...fsGlobalCallsOf(fileName, source)]
}

/**
 * fs 纪律的扫描面——**只查各包的 `src/`**（内核产物）。
 *
 * 测试用 fs 是测试的正常需求（`mkdtemp` 建临时目录、直读库表断言 blob 落盘），
 * 不属「内核不直碰文件系统」——**测试不是内核产物**，其 fs 使用不产生该纪律要防的风险。
 */
async function fsCrossingsOf(): Promise<string[]> {
  const crossings: string[] = []
  const srcPrefix = `src${sep}`

  for (const { dir, name } of packagesOf()) {
    if (FS_ALLOWED_PACKAGES.includes(name)) continue

    for (const file of await sourceFilesOf(dir)) {
      if (!file.startsWith(srcPrefix)) continue

      const absolute = join(PACKAGES_DIR, dir, file)
      for (const touch of fsTouchesOf(absolute, readFileSync(absolute, 'utf8'))) {
        crossings.push(`${name}/${file} → ${touch}`)
      }
    }
  }

  return crossings
}

// ══ 用例 ══════════════════════════════════════════════════════════════

describe('包表完备', () => {
  test('存在的包皆在包表内（新包落地须登记）', () => {
    const found = packagesOf()

    // 扫描面不得为空——目录改名 / 清空时宁可失败，也不要静默空转
    expect(found.length).toBeGreaterThan(0)

    const unregistered = found.filter(({ name }) => !(name in PACKAGE_TABLE)).map(({ name }) => name)
    expect(unregistered).toEqual([])
  })
})

describe('分包可用', () => {
  test('各包能解析并加载其声明的 workspace 依赖', async () => {

    for (const { dir, name } of packagesOf()) {
      const { dependencies } = manifestOfDir(dir)
      const from = join(PACKAGES_DIR, dir)

      for (const dep of Object.keys(dependencies ?? {})) {
        if (!dep.startsWith('@magic/')) continue // 外部依赖由 tsc / 运行时各自保证
        expect(allowedMagicDeps(name)).toContain(dep)
        const resolved = Bun.resolveSync(dep, from)
        await expect(import(resolved)).resolves.toBeDefined()
      }
    }
  })
})

describe('依赖单向（声明）', () => {
  test('包声明的 `@magic/*` 依赖不越界（dependencies 与 devDependencies 同查）', async () => {

    for (const { dir, name } of packagesOf()) {
      const { dependencies, devDependencies } = manifestOfDir(dir)
      const allowed = allowedMagicDeps(name)
      const declared = [...Object.keys(dependencies ?? {}), ...Object.keys(devDependencies ?? {})]
      const crossed = declared.filter((dep) => dep.startsWith('@magic/') && !allowed.includes(dep))

      expect(crossed).toEqual([])
    }
  })

  test('包声明的外部依赖在许可白名单内', async () => {

    for (const { dir, name } of packagesOf()) {
      const { dependencies } = manifestOfDir(dir)
      const allowed = ALLOWED_EXTERNAL[name] ?? []
      const external = Object.keys(dependencies ?? {}).filter((dep) => !dep.startsWith('@magic/'))
      const stray = external.filter((dep) => !allowed.includes(dep))

      expect(stray).toEqual([])
    }
  })
})

describe('依赖单向（源码落点）', () => {
  test('各包源码的引用不越出包边界（域→契约 · 域不认知外壳与装配 · 装配根唯一）', async () => {

    for (const { dir, name } of packagesOf()) {
      // 守护面不得为空——目录改名 / 清空时宁可失败，也不要静默空转
      expect((await sourceFilesOf(dir)).length).toBeGreaterThan(0)
      expect(await crossingsOf(dir, name)).toEqual([])
    }
  })
})

describe('内核 fs 边界', () => {
  test('fs 触达只许 records / execution 两域（扫描面＝各包 src/）', async () => {
    expect(await fsCrossingsOf()).toEqual([])
  })
})

describe('契约包零运行时依赖', () => {
  test('`@magic/contracts` 无任何运行时依赖', async () => {
    const { dependencies, peerDependencies, optionalDependencies } = manifestOfDir('contracts')

    expect(dependencies).toBeUndefined()
    expect(peerDependencies).toBeUndefined()
    expect(optionalDependencies).toBeUndefined()
  })
})

describe('公开面', () => {
  test('各包 exports 只出 `.`（不出子路径、不暴露内部目录）', async () => {

    for (const { dir, name } of packagesOf()) {
      const { exports } = manifestOfDir(dir)
      expect(Object.keys(exports ?? {}), `${name} 的 exports`).toEqual(['.'])
    }
  })
})

describe('越界判定（反向用例）', () => {
  const probe = (specifier: string, name = '@magic/conversation', dir = 'conversation'): boolean =>
    isCrossing(specifier, join(PACKAGES_DIR, dir, 'src', 'index.ts'), name, dir)

  test('相对路径跨包＝越界（旧教训一：只认裸名会漏）', () => {
    expect(probe('../../model/src/index.ts')).toBe(true)
    expect(probe('../../app/src/index.ts')).toBe(true)
  })

  test('裸包名跨包＝越界——解析不到也算（未声明依赖同样是越界）', () => {
    expect(probe('@magic/model')).toBe(true)
    expect(probe('@magic/tui')).toBe(true)
    expect(probe('@magic/app')).toBe(true)
  })

  test('深链他人内部＝越界', () => {
    expect(probe('@magic/contracts/src/ports')).toBe(true)
  })

  test('本包内引用 · 契约＝不越界', () => {
    expect(probe('./index.ts')).toBe(false)
    expect(probe('@magic/contracts')).toBe(false)
    expect(probe('@magic/conversation')).toBe(false)
  })

  test('装配根可跨域——app 引域不越界，域引 app 越界', () => {
    expect(probe('@magic/model', '@magic/app', 'app')).toBe(false)
    expect(probe('@magic/tui', '@magic/app', 'app')).toBe(false)
    expect(probe('@magic/app', '@magic/model', 'model')).toBe(true)
  })

  test('外部依赖与内建＝不越界', () => {
    expect(probe('typescript')).toBe(false)
    expect(probe('node:fs')).toBe(false)
    expect(probe('bun:test')).toBe(false)
    expect(probe('ai')).toBe(false)
  })

  test('装配根唯一——「非装配包跨域」分类正确', () => {
    expect(classifyCrossing('@magic/conversation', '@magic/model')).toBe('非装配包跨域')
    expect(classifyCrossing('@magic/model', '@magic/tui')).toBe('域认知外壳/装配')
    expect(classifyCrossing('@magic/app', '@magic/model')).toBe('包边界越界')
  })

  test('注释与字符串里的示例文本不误判', () => {
    const source = [
      `// 用法示例：import { run } from '@magic/model'`,
      `/* export * from '../../app/src/index.ts' */`,
      `const doc = "import x from '@magic/tui'"`,
    ].join('\n')

    expect(importSpecifiersOf(join(PACKAGES_DIR, 'model', 'src', 'index.ts'), source)).toEqual([])
  })

  test('require / 动态 import / export-from / import-equals 都被提取', () => {
    const source = [
      `import { a } from './a.ts'`,
      `export * from './b.ts'`,
      `import legacy = require('./c.cjs')`,
      `const lazy = await import('./d.ts')`,
      `const also = require('@magic/model')`,
    ].join('\n')

    expect(importSpecifiersOf(join(PACKAGES_DIR, 'model', 'src', 'index.ts'), source)).toEqual([
      './a.ts',
      './b.ts',
      './c.cjs',
      './d.ts',
      '@magic/model',
    ])
  })
})

describe('fs 触达提取（反向用例）', () => {
  test('模块 import / require 与 Bun 全局调用都被抓', () => {
    const source = [
      `import { Database } from 'bun:sqlite'`,
      `import { mkdir } from 'node:fs/promises'`,
      `import { join } from 'node:path'`,
      `const legacy = require('node:fs')`,
      `await Bun.write(path, data)`,
      `const f = Bun.file(path)`,
    ].join('\n')

    expect(fsTouchesOf('probe.ts', source)).toEqual([
      'bun:sqlite',
      'node:fs/promises',
      'node:fs',
      'Bun.write',
      'Bun.file',
    ])
  })

  test('fs 许可清单——只放 records / execution', () => {
    expect(FS_ALLOWED_PACKAGES).toEqual(['@magic/records', '@magic/execution'])
    expect(FS_ALLOWED_PACKAGES).not.toContain('@magic/model')
    expect(FS_ALLOWED_PACKAGES).not.toContain('@magic/contracts')
  })
})

describe('可执行名', () => {
  test('`magic` 已装配到根 .bin（根声明了 @magic/app）', async () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest
    const { bin } = manifestOfDir('app')

    expect(root.dependencies?.['@magic/app']).toBeDefined()
    expect(bin?.magic).toBeDefined()
    expect(existsSync(join(ROOT, 'node_modules/.bin/magic'))).toBe(true)
  })
})
