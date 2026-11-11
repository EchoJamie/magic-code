/**
 * 按测试层收集用例——目录层级随 0.2.0 搬迁变化，不把包路径写死在 package.json。
 *
 * 用法：bun scripts/test-layer.ts integration|e2e
 */
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '..')
const suite = process.argv[2]
if (suite !== 'integration' && suite !== 'e2e') {
  console.error('用法：bun scripts/test-layer.ts integration|e2e')
  process.exit(2)
}

const suffix = `.${suite}.test.ts`
const roots = ['test', 'packages', 'apps']
const files: string[] = []

function walk(path: string): void {
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) walk(child)
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(relative(root, child))
  }
}

for (const dir of roots) walk(join(root, dir))
files.sort()

if (files.length === 0) {
  console.log(`没有 ${suite} 测试`)
  process.exit(0)
}

console.log(`运行 ${files.length} 个 ${suite} 测试`)
const child = Bun.spawn(['bun', 'test', ...files], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] })
process.exit(await child.exited)
