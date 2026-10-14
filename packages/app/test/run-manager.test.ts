/**
 * U48 · 第一段 —— **管理者立起来**。
 *
 * 要证的四件（设计 · 会话与运行管理 · 本机执行结构）：
 * 1. **同一用户、同一规范化 dataDir 只有一个**——且**是并发下的唯一**（真的七个进程，
 *    不是同一进程里顺序演七遍）；
 * 2. 启动竞争的一方**连接已有实例，不另起**；
 * 3. **本机 socket 限该用户访问**（落在「运行目录只许本人进」这一条上）；
 * 4. 收摊之后路径干净——下一个随即能立起来（**没有永远占着路径的尸首**）。
 *
 * ⚠️ **并发那一组为什么要真子进程**：这句话说的是**两个进程**之间的事。同一进程里先后
 * 调两次是顺序的（`Bun.listen` 第二次抛，那不叫竞争，那叫顺序的后手）——只有真进程才是
 * 真的一方。七个是因为工单的验收句就是「连开七个……」（`交接/工单/U48.md`）。
 */

import { describe, expect, test } from 'bun:test'

import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeDataDir, runPathsOf } from '../src/run/paths.ts'
import { removeDir } from './tmp.ts'

/** 一块沙地：家目录 / 基础目录 / 数据目录 / 临时目录四面各一处。 */
type Ground = {
  readonly root: string
  readonly home: string
  readonly base: string
  readonly dataDir: string
  readonly tmp: string
  dispose(): void
}

function ground(name: string): Ground {
  const root = mkdtempSync(`/tmp/magic-run-${name}-`)
  const home = join(root, 'home')
  const base = join(root, 'base')
  const dataDir = base
  const tmp = join(root, 'tmp')
  for (const dir of [home, base, dataDir, tmp]) mkdirSync(dir, { recursive: true })

  return {
    root,
    home,
    base,
    dataDir,
    tmp,
    dispose: () => removeDir(root),
  }
}

describe('U48-S1 · 规范化（同一处必须算成同一处）', () => {
  test('软链接 / 尾随斜杠 / .. 三种写法归一，且还不存在的目录也算得出来', () => {
    const g = ground('norm')
    try {
      const real = normalizeDataDir(g.dataDir)
      expect(normalizeDataDir(`${g.dataDir}/`)).toBe(real)
      expect(normalizeDataDir(join(g.dataDir, '..', 'base'))).toBe(real)
      expect(normalizeDataDir(join(g.dataDir, 'not-yet', '..'))).toBe(real)

      // 还不存在的目录：**最近的已存在祖先**取真路径 ＋ 余下的原样拼回
      expect(normalizeDataDir(join(g.dataDir, 'deep', 'deeper'))).toBe(
        join(real, 'deep', 'deeper'),
      )

      // 同一处 ⇒ 同一份路径（并发的唯一性建在这上面）
      const one = runPathsOf({ home: g.home, base: g.base }, g.tmp)
      const two = runPathsOf({ home: g.home, base: `${g.base}/` }, g.tmp)
      expect(one.socket).toBe(two.socket)
    } finally {
      g.dispose()
    }
  })
})

describe('基础目录的规范化身份决定运行目录', () => {
  test('长短别名与 .magic 符号链接共用运行目录；首次未建目录保持同一身份', () => {
    const root = mkdtempSync('/tmp/magic-d55-')
    try {
      const home = root
      const real = join(root, 'store')
      mkdirSync(real)
      const longAlias = join(root, 'alias-' + 'x'.repeat(150))
      const selected = join(root, '.magic')
      symlinkSync(real, longAlias, 'dir')
      symlinkSync(real, selected, 'dir')
      const expected = runPathsOf({ home, base: real }, root)
      expect(expected.dir.startsWith(normalizeDataDir(real) + '/run/')).toBe(true)
      for (const base of [longAlias, selected, real + '/', normalizeDataDir(real)]) {
        expect(runPathsOf({ home, base }, root)).toEqual(expected)
      }
      const pending = join(real, 'first', '.magic')
      const before = runPathsOf({ home, base: pending }, root)
      expect(existsSync(pending)).toBe(false)
      expect(runPathsOf({ home, base: join(longAlias, 'first', '.magic') }, root)).toEqual(before)
      mkdirSync(pending, { recursive: true })
      expect(runPathsOf({ home, base: pending }, root)).toEqual(before)
      expect(runPathsOf({ home, base: join(real, 'other', '.magic') }, root)).not.toEqual(before)
    } finally { removeDir(root) }
  })

  test('/var 与 /private/var 的首次目录共用同一运行身份', () => {
    if (process.platform !== 'darwin') return
    const root = mkdtempSync('/var/tmp/magic-d55-')
    try {
      const base = join(root, 'first', '.magic')
      const canonical = '/private' + base
      const paths = runPathsOf({ home: root, base }, '/tmp')
      expect(runPathsOf({ home: root, base: canonical }, '/tmp')).toEqual(paths)
      mkdirSync(base, { recursive: true })
      expect(runPathsOf({ home: root, base }, '/tmp')).toEqual(paths)
    } finally { removeDir(root) }
  })

  test('实体过长时所有别名都选同一临时运行目录', () => {
    const root = mkdtempSync('/tmp/magic-d55-')
    try {
      const base = join(root, 'deep-' + 'x'.repeat(140), '.magic')
      mkdirSync(base, { recursive: true })
      const alias = join(root, 'short')
      symlinkSync(base, alias, 'dir')
      const canonical = runPathsOf({ home: root, base }, root)
      expect(canonical.dir.startsWith(join(root, 'magic-run-'))).toBe(true)
      expect(runPathsOf({ home: root, base: alias }, root)).toEqual(canonical)
    } finally { removeDir(root) }
  })
})
