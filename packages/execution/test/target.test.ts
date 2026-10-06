import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandbox, createWorkspaceService } from '../src/index.ts'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'magic-target-')))
  temporary.push(root)
  const workspace = createWorkspaceService({ roots: [root] })
  const sandbox = createSandbox({ workspace })
  const path = join(root, 'file')
  writeFileSync(path, 'before')
  return { root, path, workspace, sandbox }
}

test('审批后目标被另一普通文件替换，也不能按同路径串到新身份', async () => {
  const f = fixture()
  const binding = f.sandbox.bindTarget!(f.workspace.resolve(f.path), 'read')
  renameSync(f.path, `${f.path}-old`)
  writeFileSync(f.path, 'unreviewed')
  try { await expect(binding.sandbox.read(f.path)).rejects.toThrow('目标已改变') }
  finally { await binding.release() }
})

test('编辑从同一已校验句柄读写；读后路径换成链接不写入链接目标或旧文件', async () => {
  const f = fixture()
  const other = join(f.root, 'other')
  writeFileSync(other, 'untouched')
  const binding = f.sandbox.bindTarget!(f.workspace.resolve(f.path), 'edit')
  try {
    const before = await binding.sandbox.read(f.path)
    renameSync(f.path, `${f.path}-old`)
    symlinkSync(other, f.path)
    await expect(binding.sandbox.write(f.path, { text: 'bad' }, { expectedContent: before.content })).rejects.toThrow('目标已改变')
    expect(readFileSync(other, 'utf8')).toBe('untouched')
    expect(readFileSync(`${f.path}-old`, 'utf8')).toBe('before')
  } finally { await binding.release() }
})

test('编辑读后内容被他人修改，保留新内容并报告冲突', async () => {
  const f = fixture()
  const binding = f.sandbox.bindTarget!(f.workspace.resolve(f.path), 'edit')
  try {
    const before = await binding.sandbox.read(f.path)
    writeFileSync(f.path, 'external change')
    await expect(binding.sandbox.write(f.path, { text: 'bad' }, { expectedContent: before.content })).rejects.toThrow('内容已改变')
    expect(readFileSync(f.path, 'utf8')).toBe('external change')
  } finally { await binding.release() }
})

test('编辑正常完成后再次从同一句柄零偏移读取完整内容', async () => {
  const f = fixture()
  const binding = f.sandbox.bindTarget!(f.workspace.resolve(f.path), 'edit')
  try {
    expect((await binding.sandbox.read(f.path)).content).toBe('before')
    await binding.sandbox.write(f.path, { text: 'after' }, { expectedContent: 'before' })
    expect((await binding.sandbox.read(f.path)).content).toBe('after')
    expect(readFileSync(f.path, 'utf8')).toBe('after')
  } finally { await binding.release() }
})

test('审批后父目录被普通目录替换，新建文件也不落入新目录', async () => {
  const f = fixture()
  const directory = join(f.root, 'dir')
  mkdirSync(directory)
  const path = join(directory, 'new')
  const binding = f.sandbox.bindTarget!(f.workspace.resolve(path), 'write')
  renameSync(directory, `${directory}-old`); mkdirSync(directory)
  try {
    await expect(binding.sandbox.write(path, { text: 'bad' })).rejects.toThrow('目标已改变')
    expect(() => readFileSync(path)).toThrow()
  } finally { await binding.release() }
})

test('审批时不存在的文件不能覆盖后来出现的同名文件', async () => {
  const f = fixture()
  unlinkSync(f.path)
  const binding = f.sandbox.bindTarget!(f.workspace.resolve(f.path), 'write')
  writeFileSync(f.path, 'external new file')
  try {
    await expect(binding.sandbox.write(f.path, { text: 'bad' })).rejects.toThrow()
    expect(readFileSync(f.path, 'utf8')).toBe('external new file')
  } finally { await binding.release() }
})

test('搜索不跟递归子目录或文件链接，glob 也不能用 .. 扩大起点', async () => {
  const f = fixture()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'magic-unreviewed-')))
  temporary.push(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(outside, join(f.root, 'linked-dir'))
  symlinkSync(join(outside, 'secret.txt'), join(f.root, 'linked-file.txt'))
  writeFileSync(join(f.root, '.hidden'), 'secret')
  const binding = f.sandbox.bindTarget!(f.workspace.resolve(f.root), 'grep')
  try {
    const hits = await binding.sandbox.match('secret', { mode: 'grep', path: f.root })
    expect(hits.map((hit) => hit.path)).toEqual([join(f.root, '.hidden')])
    expect(await binding.sandbox.match('../**/*', { mode: 'glob', path: f.root })).toEqual([])
    const glob = await binding.sandbox.match('**/*', { mode: 'glob', path: f.root })
    expect(glob.map((hit) => hit.path)).toEqual([f.path])
  } finally { await binding.release() }
})
