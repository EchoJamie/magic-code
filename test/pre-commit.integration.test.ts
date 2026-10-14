import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hook = join(import.meta.dir, '../.githooks/pre-commit')

/** 使用独立仓库；外层 hook 的 Git 环境不能把子仓库操作导向用户暂存区。 */
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
)

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'magic-commit-'))
  const write = (file: string, body: string) => writeFileSync(join(root, file), body)
  const run = async (...cmd: string[]) => {
    const child = Bun.spawn(cmd, {
      cwd: root,
      env: { ...environment, BUN_INSTALL_CACHE_DIR: join(root, '.bun-cache') },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, output: stdout + stderr }
  }
  const checked = async (...cmd: string[]) => {
    const result = await run(...cmd)
    if (result.code !== 0) throw new Error(result.output)
  }
  try {
    for (const dir of ['.githooks', 'packages/consumer', 'packages/value']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    copyFileSync(hook, join(root, '.githooks/pre-commit'))
    write('.gitignore', 'node_modules/\n.bun-cache/\n')
    write('package.json', JSON.stringify({
      name: 'commit-fixture', private: true, workspaces: ['packages/*'],
      dependencies: { '@probe/consumer': 'workspace:*' },
      scripts: {
        'check:commit': 'bun verify.ts',
        // hook 安装依赖不得执行生命周期脚本。
        prepare: 'bun -e "process.exit(41)"',
      },
    }))
    write('packages/consumer/package.json', JSON.stringify({
      name: '@probe/consumer', exports: './index.ts', dependencies: { '@probe/value': 'workspace:*' },
    }))
    write('packages/consumer/index.ts', 'export { value } from "@probe/value"\n')
    write('packages/value/package.json', JSON.stringify({ name: '@probe/value', exports: './index.ts' }))
    write('packages/value/index.ts', 'export const value = 2\n')
    write('verify.ts', [
      'import { value } from "@probe/consumer"',
      'import { existsSync } from "node:fs"',
      'if (value !== 2) throw new Error("STAGED_VALUE=" + value)',
      'if (existsSync("untracked.test.ts")) throw new Error("UNTRACKED_INCLUDED")',
      'console.log("STAGED_OK")',
    ].join('\n'))
    await checked('git', 'init', '--quiet')
    await checked(process.execPath, 'install', '--offline', '--ignore-scripts')
    await checked('git', 'add', '.')
    return {
      directory: root, write, checked,
      check: () => run('sh', '.githooks/pre-commit'),
      dispose: () => rmSync(root, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

test('workspace 依赖读取暂存版本，未暂存修改与未跟踪文件不参与提交门禁', async () => {
  const f = await fixture()
  try {
    f.write('packages/value/index.ts', 'export const value = 999\n')
    f.write('untracked.test.ts', 'throw new Error("本地草稿")\n')
    const result = await f.check()
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain('STAGED_OK')
  } finally { f.dispose() }
})

test('工作区已修好也不能掩盖暂存的错误依赖', async () => {
  const f = await fixture()
  try {
    f.write('packages/value/index.ts', 'export const value = 1\n')
    await f.checked('git', 'add', 'packages/value/index.ts')
    f.write('packages/value/index.ts', 'export const value = 2\n')
    const result = await f.check()
    expect(result.code, result.output).not.toBe(0)
    expect(result.output).toContain('STAGED_VALUE=1')
  } finally { f.dispose() }
})

test('暂存依赖与锁文件不一致时拒绝提交，不沿用工作区已装依赖', async () => {
  const f = await fixture()
  try {
    // 两个版本都能在夹具内离线解析，失败必须来自冻结的锁文件而非缓存缺失。
    const source = join(f.directory, 'fixtures/source/package')
    mkdirSync(source, { recursive: true })
    for (const version of ['1.0.0', '2.0.0']) {
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@probe/archive', version }))
      await f.checked('tar', '-czf', `fixtures/archive-${version}.tgz`, '-C', 'fixtures/source', 'package')
    }
    rmSync(join(f.directory, 'fixtures/source'), { recursive: true })
    const manifest = JSON.parse(readFileSync(join(f.directory, 'package.json'), 'utf8'))
    manifest.dependencies['@probe/archive'] = 'file:fixtures/archive-1.0.0.tgz'
    f.write('package.json', JSON.stringify(manifest))
    await f.checked(process.execPath, 'install', '--offline', '--ignore-scripts')
    await f.checked('git', 'add', '.')

    manifest.dependencies['@probe/archive'] = 'file:fixtures/archive-2.0.0.tgz'
    f.write('package.json', JSON.stringify(manifest))
    await f.checked('git', 'add', 'package.json')
    const result = await f.check()
    expect(result.code, result.output).not.toBe(0)
    expect(result.output).toContain('lockfile had changes, but lockfile is frozen')
  } finally { f.dispose() }
})
