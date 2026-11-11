import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, link, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path'
import type { NoteLink, NoteReadQuery, NoteState, ResolvedPath, Sandbox, WorkingNotes } from '@magic/contracts'
import { assertIdentity, assertTarget, inspectTarget, isInside, resolveTarget } from './workspace.ts'
import { listDir } from './files.ts'
import { matchIn } from './match.ts'

const saves = new Map<string, Promise<void>>()
const PAGE_CHARS = 8000
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export function noteDirectory(dataDir: string, session: string): string {
  if (!session || session === '.' || session === '..' || /[\\/\0]/.test(session)) throw new Error('笔记会话身份无效')
  return join(resolveTarget(resolve(dataDir)), 'notes', session)
}

export function normalizeNotePath(path: string): string {
  if (!path || path.includes('\\') || path.includes('\0') || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('笔记路径必须是本会话目录内的规范相对路径')
  }
  return path
}

/** 文件为唯一正文；读取不建目录，保存只建立实际需要的父目录。 */
export function createWorkingNotes(dataDir: string, session: string, pageLimit = 32000): WorkingNotes {
  const directory = noteDirectory(dataDir, session)
  const base = resolveTarget(resolve(dataDir))
  const receipts = new Map<string, { fingerprint: string; cursor: string; through: number; complete: boolean }>()
  const written: Record<string, string> = {}
  let saved = 0

  async function checkPath(absolute: string): Promise<void> {
    if (!isInside(absolute, directory)) throw new Error('笔记目标超出本会话范围')
    assertTarget(base)
    let current = base
    for (const part of relative(base, absolute).split(sep)) {
      current = join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`笔记不跟随符号链接：${current}`)
      } catch (error) { if (!missing(error)) throw error }
    }
    assertTarget(absolute)
  }
  async function content(path: string): Promise<{ text: string; fingerprint: string } | undefined> {
    const absolute = join(directory, normalizeNotePath(path))
    await checkPath(absolute)
    let handle
    try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if (missing(error)) return undefined; throw error }
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()) throw new Error(`笔记目标不是文件：${path}`)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile())
      const after = await handle.stat({ bigint: true })
      const current = await lstat(absolute, { bigint: true })
      await checkPath(absolute)
      if (before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.size !== after.size || current.ino !== after.ino || current.mtimeNs !== after.mtimeNs) {
        throw new Error(`笔记在读取时改变：${path}，请重新读取`)
      }
      return { text, fingerprint: `${after.dev}:${after.ino}:${after.mtimeNs}:${hash(text)}` }
    } finally { await handle.close() }
  }
  async function files(): Promise<string[]> {
    const found: string[] = []
    async function walk(folder: string) {
      await checkPath(folder)
      let entries
      try { entries = await readdir(folder, { withFileTypes: true }) }
      catch (error) { if (missing(error)) return; throw error }
      for (const item of entries) {
        const path = join(folder, item.name)
        if (item.isDirectory()) await walk(path)
        else if (item.isFile() && item.name.endsWith('.md')) found.push(relative(directory, path))
      }
    }
    await walk(directory)
    return found.sort()
  }
  async function read(query: NoteReadQuery = {}): Promise<NoteState> {
    const path = normalizeNotePath(query.path ?? 'MEMORY.md')
    const list = await files()
    const state = { directory, path, files: list }
    const current = await content(path)
    if (!current) return { ...state, status: path !== 'MEMORY.md' ? 'missing' : list.length ? 'entry-missing' : 'empty' }
    const cursor = hash(`${session}\0${path}\0${current.fingerprint}`)
    if (query.cursor !== undefined && query.cursor !== cursor) return { ...state, status: 'changed' }
    const offset = query.offset ?? 0, limit = query.limit ?? PAGE_CHARS
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > current.text.length || !Number.isSafeInteger(limit) || limit < 1) throw new Error('笔记分页位置或长度无效')
    const text = current.text.slice(offset, offset + Math.min(limit, pageLimit))
    const next = offset + text.length
    return { ...state, status: 'ready', page: { session, path, absolute: join(directory, path), text, offset,
      total: current.text.length, complete: next === current.text.length, ...(next < current.text.length ? { next } : {}), cursor,
      links: noteLinks(path, text),
    } }
  }
  async function serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = saves.get(directory) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => {}, () => {})
    saves.set(directory, tail)
    try { return await result } finally { if (saves.get(directory) === tail) saves.delete(directory) }
  }
  async function save(target: ResolvedPath, text: string, expectedContent?: string, signal?: AbortSignal) {
    return serial(async () => {
      signal?.throwIfAborted()
      const absolute = target.absolute, path = relative(directory, absolute)
      if (!path.endsWith('.md')) throw new Error('工作笔记请保存为 Markdown 文件（.md）')
      await checkPath(absolute)
      assertIdentity(target)
      const before = await content(path)
      if (before) {
        if (expectedContent !== undefined) {
          if (before.text !== expectedContent) throw new Error('笔记内容已改变，未覆盖；请重新读取')
        } else {
          const seen = receipts.get(path)
          if (!seen?.complete || seen.fingerprint !== before.fingerprint) throw new Error('覆盖前须完整读取当前笔记；未读或内容已改变，未覆盖')
        }
      } else if (expectedContent !== undefined || target.identity != null) throw new Error('笔记已不存在，未创建替代内容')
      await mkdir(dirname(absolute), { recursive: true })
      await checkPath(absolute)
      const temporary = join(dirname(absolute), `.note-${crypto.randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        let staged
        try { await handle.writeFile(text, 'utf8'); await handle.sync(); staged = await handle.stat({ bigint: true }) } finally { await handle.close() }
        signal?.throwIfAborted()
        await checkPath(absolute)
        const latest = await content(path)
        if (latest?.fingerprint !== before?.fingerprint) throw new Error('保存期间笔记发生外部修改，未覆盖；请重新读取')
        signal?.throwIfAborted()
        if (before === undefined) { await link(temporary, absolute); await unlink(temporary) }
        else await rename(temporary, absolute)
        saved += 1
        written[path] = `${staged.dev}:${staged.ino}:${staged.mtimeNs}:${hash(text)}`
        const parent = await open(dirname(absolute), constants.O_RDONLY)
        try { await parent.sync() } finally { await parent.close() }
        // 保存本身不是读取；下一次整篇覆盖仍须读取当前文件。
        receipts.delete(path)
      } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
    })
  }
  const notes: WorkingNotes = {
    directory, read, saved: () => saved,
    fork: limit => createWorkingNotes(dataDir, session, limit ?? pageLimit),
    writes: () => ({ ...written }),
    async snapshot() {
      const state: Record<string, string> = {}
      for (const path of await files()) state[path] = (await content(path))?.fingerprint ?? 'missing'
      return state
    },
    resolve(path) {
      if (!isAbsolute(path)) return undefined
      const requested = resolve(path)
      const declaredDirectory = join(resolve(dataDir), 'notes', session)
      if (!isInside(requested, directory) && !isInside(requested, declaredDirectory)) return undefined
      const absolute = isInside(requested, directory) ? requested : join(directory, relative(declaredDirectory, requested))
      if (resolveTarget(absolute) !== absolute) throw new Error('笔记不跟随符号链接')
      return inspectTarget(absolute)
    },
    bindTarget(target, tool, signal) {
      const same = (path: string) => { if (path !== target.absolute) throw new Error('笔记目标与裁决不一致'); return relative(directory, path) }
      const sandbox: Sandbox = {
        async exec() { throw new Error('笔记范围不授予命令执行权限') },
        async read(path, opts) {
          const key = same(path)
          await checkPath(path); assertIdentity(target)
          const previous = receipts.get(key)
          const offset = opts?.offset ?? 0
          const result = await read({ path: key, offset, limit: opts?.limit ?? (tool === 'edit' ? 32000 : PAGE_CHARS),
            ...(offset > 0 && previous ? { cursor: previous.cursor } : {}) })
          if (!result.page) throw new Error(result.status === 'changed' ? '续读期间笔记已变化，请从头重新读取' : `笔记不存在：${key}`)
          const page = result.page
          const current = await content(key)
          if (!current || hash(`${session}\0${key}\0${current.fingerprint}`) !== page.cursor) throw new Error('笔记已变化，请重新读取')
          const through = offset === 0 || previous?.through === offset ? offset + page.text.length : -1
          receipts.set(key, { fingerprint: current.fingerprint, cursor: page.cursor, through, complete: through === page.total })
          const { cursor: _, links: __, ...note } = page
          return { content: page.text, ...(page.complete ? {} : { truncated: true }), note }
        },
        async write(path, data, opts) { same(path); await save(target, 'text' in data ? data.text : new TextDecoder('utf-8', { fatal: true }).decode(data.bytes), opts?.expectedContent, signal) },
        async edit(path, old, replacement) {
          const key = same(path)
          await checkPath(path); assertIdentity(target)
          const current = await content(key)
          if (!current) throw new Error(`笔记不存在：${key}`)
          const start = current.text.indexOf(old)
          if (!old || start < 0) throw new Error('未找到待替换原文，笔记未改')
          if (current.text.indexOf(old, start + old.length) >= 0) throw new Error('原文匹配不唯一，笔记未改')
          await save(target, current.text.slice(0, start) + replacement + current.text.slice(start + old.length), current.text, signal)
        },
        async list(path) { same(path); await checkPath(path); assertIdentity(target); return listDir(path).catch(error => { if (target.identity === null) return []; throw error }) },
        async match(pattern, opts) { const path = opts.path ?? target.absolute; same(path); await checkPath(path); assertIdentity(target); return target.identity === null ? [] : matchIn(path, pattern, opts) },
      }
      return { sandbox, release: async () => {} }
    },
  }
  return notes
}

/** 只解释明确 Markdown 链接；来源授权仍由 Engine 按当前会话及已受理引用裁决。 */
function noteLinks(path: string, text: string): NoteLink[] {
  return [...text.matchAll(/\[([^\]]+)\]\(([^\s)]+)\)/g)].map(match => {
    const label = match[1]!, target = match[2]!
    const source = /^([^/#\s]+)#([1-9]\d*)$/.exec(target)
    if (source && !source[1]!.endsWith('.md')) return { kind: 'source', label, source: { session: source[1]!, entry: Number(source[2]) } }
    try {
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('/')) throw new Error('该链接不属于本会话笔记')
      const file = decodeURIComponent(target.split('#')[0]!)
      const resolved = normalizeNotePath(posix.normalize(posix.join(posix.dirname(path), file || posix.basename(path))))
      return { kind: 'note', label, path: resolved }
    } catch (error) { return { kind: 'unavailable', label, target, reason: error instanceof Error ? error.message : String(error) } }
  })
}
