import { afterEach, expect, test, spyOn } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkingNotes } from '../src/notes.ts'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'magic-notes-')); roots.push(base)
  const notes = createWorkingNotes(base, 'session')
  const path = join(notes.directory, 'MEMORY.md')
  const bound = (tool: string) => notes.bindTarget(notes.resolve(path)!, tool).sandbox
  return { base, notes, path, bound }
}

test('读取不建目录；仅主题时有真实入口，分页变化不混拼', async () => {
  const { base, notes } = await fixture()
  expect((await notes.read()).status).toBe('empty')
  expect(await readdir(base)).toEqual([])
  const path = join(notes.directory, 'topic.md')
  await notes.bindTarget(notes.resolve(path)!, 'write').sandbox.write(path, { text: '甲乙丙丁' })
  expect(await notes.read()).toMatchObject({ status: 'entry-missing', files: ['topic.md'] })
  const first = (await notes.read({ path: 'topic.md', limit: 2 })).page!
  expect(first).toMatchObject({ text: '甲乙', next: 2, complete: false })
  await writeFile(path, '新甲乙丙丁')
  expect((await notes.read({ path: 'topic.md', offset: 2, cursor: first.cursor })).status).toBe('changed')
})

test('整篇覆盖要求同调用者完整读取，外部编辑冲突保留；唯一编辑保留其余大正文', async () => {
  const { notes, path, bound } = await fixture()
  await bound('write').write(path, { text: '开头\n' + 'a'.repeat(40000) + '\n末尾' })
  await expect(bound('write').write(path, { text: '未读覆盖' })).rejects.toThrow('完整读取')
  await bound('edit').edit!(path, '末尾', '新末尾')
  expect((await readFile(path, 'utf8')).endsWith('新末尾')).toBe(true)
  await bound('read').read(path, { limit: 32000 })
  await expect(bound('write').write(path, { text: '部分读覆盖' })).rejects.toThrow('完整读取')
  await bound('read').read(path, { offset: 32000, limit: 32000 })
  await writeFile(path, '用户外部编辑')
  await expect(bound('write').write(path, { text: '陈旧覆盖' })).rejects.toThrow('完整读取')
  expect(await readFile(path, 'utf8')).toBe('用户外部编辑')
  await bound('read').read(path)
  const other = notes.fork()
  await expect(other.bindTarget(other.resolve(path)!, 'write').sandbox.write(path, { text: '另一调用者' })).rejects.toThrow('完整读取')
  await bound('write').write(path, { text: '已重读更新' })
  expect(await readdir(notes.directory)).toEqual(['MEMORY.md'])
})

test('自身范围不跟符号链接，不扩权到其他会话或命令', async () => {
  const { base, notes, path } = await fixture()
  expect(notes.resolve(join(base, 'notes', 'other', 'MEMORY.md'))).toBeUndefined()
  await mkdir(notes.directory, { recursive: true })
  const external = join(base, 'external.md'); await writeFile(external, '用户内容')
  await symlink(external, path)
  expect(() => notes.resolve(path)).toThrow('符号链接')
  await expect(notes.read()).rejects.toThrow('符号链接')
  await expect(notes.read({ path: '../other/MEMORY.md' })).rejects.toThrow('规范相对路径')
  expect(await readFile(external, 'utf8')).toBe('用户内容')
})

test('保存前取消不截断文件，不留下临时文件', async () => {
  const { notes, path, bound } = await fixture()
  await bound('write').write(path, { text: '原正文' })
  await bound('read').read(path)
  const controller = new AbortController(); controller.abort()
  await expect(notes.bindTarget(notes.resolve(path)!, 'write', controller.signal).sandbox.write(path, { text: '新正文' })).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('原正文')
  expect(await readdir(notes.directory)).toEqual(['MEMORY.md'])
})

test('两个调用者同时覆盖同一版本只允许一个提交；失败不截断成功版本且无残留', async () => {
  const { notes, path, bound } = await fixture()
  await bound('write').write(path, { text: '初始完整正文' })
  const other = notes.fork()
  await bound('read').read(path)
  await other.bindTarget(other.resolve(path)!, 'read').sandbox.read(path)
  const left = notes.bindTarget(notes.resolve(path)!, 'write').sandbox
  const right = other.bindTarget(other.resolve(path)!, 'write').sandbox
  const outcomes = await Promise.allSettled([left.write(path, { text: '第一份完整正文' }), right.write(path, { text: '第二份完整正文' })])
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(await readFile(path, 'utf8')).toBe('第一份完整正文')
  expect(await readdir(notes.directory)).toEqual(['MEMORY.md'])
})

test('同目录临时文件已经创建后取消保存，原正文完整且临时文件清理', async () => {
  const { notes, path, bound } = await fixture()
  await bound('write').write(path, { text: '保存前的完整正文' })
  await bound('read').read(path)
  const controller = new AbortController()
  let saving = false
  const probe = await fs.open(path, 'r')
  const prototype = Object.getPrototypeOf(probe) as typeof probe
  await probe.close()
  const sync = prototype.sync
  const spy = spyOn(prototype, 'sync').mockImplementation(async function (this: typeof probe) {
    await sync.call(this)
    const temporary = (await readdir(notes.directory)).find(name => name.startsWith('.note-'))!
    expect(await readFile(join(notes.directory, temporary), 'utf8')).toBe('新的完整正文')
    expect(await readFile(path, 'utf8')).toBe('保存前的完整正文')
    saving = true
    controller.abort()
  })
  try {
    const pending = notes.bindTarget(notes.resolve(path)!, 'write', controller.signal).sandbox.write(path, { text: '新的完整正文' })
    await expect(pending).rejects.toThrow()
    expect(saving).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('保存前的完整正文')
    expect(await readdir(notes.directory)).toEqual(['MEMORY.md'])
  } finally { spy.mockRestore() }
})
