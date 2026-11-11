/** 工作区注册校验与真实目标解析；路径准入归权限闸门。 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { WorkspaceService } from '@magic/contracts'
import { createWorkspaceService } from '../src/index.ts'

// —— 夹具 ——

/** 造一个真临时目录充当工作区根（调用方负责清理）。 */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'magic-ws-'))
}

const roots: string[] = []

function freshRoot(): string {
  const root = makeRoot()
  roots.push(root)
  return root
}

/** 造一个单根工作区；返回**规范化后**的根（`defaultRoot()`）。 */
function workspaceOn(root: string): { ws: WorkspaceService; root: string } {
  const ws = createWorkspaceService({ roots: [root] })
  return { ws, root: ws.defaultRoot() }
}

/** 造一个多根工作区；返回工作区与**规范化后**的各根（同声明序）。 */
function workspaceOnAll(raw: readonly string[]): { ws: WorkspaceService; roots: readonly string[] } {
  const ws = createWorkspaceService({ roots: raw })
  return { ws, roots: ws.roots() }
}

/**
 * 取规范化后的第 n 条根——`noUncheckedIndexedAccess` 下索引位带 `undefined`；
 * 根的**条数**是夹具自己造的，用例里断言它比每处写一次 `as string` 更诚实。
 */
function nth(roots: readonly string[], index: number): string {
  const root = roots[index]
  if (root === undefined) throw new Error(`第 ${index + 1} 条根缺席——夹具出问题了`)
  return root
}

// 收尾——测试进程退出前清掉临时目录（失败时也清）
process.on('exit', () => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判定
    }
  }
})

// —— 类型层探针（tsc 校验；`bun test` 只剥类型，不做检查）——
// 实现面必须**结构上**就是契约端口，装配据以注入（技术方案 · 领域划分 · 依赖规则 1）。
type _FaceMatchesPort = ReturnType<typeof createWorkspaceService> extends WorkspaceService
  ? true
  : never
const _faceProbe: _FaceMatchesPort = true
void _faceProbe

// ══ 用例 ══════════════════════════════════════════════════════════════

describe('根注册——列表与默认根', () => {
  test('单根是**特例**：`roots()` 恰一条 · `defaultRoot()` 即该条', () => {
    const root = freshRoot()
    const { ws } = workspaceOn(root)

    expect(ws.roots()).toHaveLength(1)
    expect(ws.roots()[0]).toBe(ws.defaultRoot())
    expect(ws.defaultRoot()).toBe(realpathSync(root))
  })

  test('**默认根＝列表第一项**（平等平铺 ＋ 一个默认，不引入「主根」概念）', () => {
    const [first, second] = [freshRoot(), freshRoot()]
    const { ws, roots: real } = workspaceOnAll([first, second])

    expect(real).toHaveLength(2)
    expect(ws.defaultRoot()).toBe(nth(real, 0))
    expect(ws.defaultRoot()).not.toBe(nth(real, 1))
  })

  test('`roots()` 保**声明序**——顺序即语义（第一项承载默认根）', () => {
    const [a, b, c] = [freshRoot(), freshRoot(), freshRoot()]
    const { ws } = workspaceOnAll([b, c, a])

    // 直写声明原值的规范化形——**别拿 `roots()` 跟它自己做断言**（那除长度外恒真）
    expect(ws.roots()).toEqual([realpathSync(b), realpathSync(c), realpathSync(a)])
  })

  test('根规范化——`/tmp` 一类符号链接根不误判（词法边界须建在规范形上）', () => {
    // macOS 上 `mkdtemp` 给的路径常经 `/var` → `/private/var` 的符号链接；
    // 若不规范化，落点用**真实**路径写的绝对引用会被误拒为越界。
    const root = freshRoot()
    const { ws } = workspaceOn(root)

    const file = join(realpathSync(root), 'a.txt')
    expect(ws.resolve(file).absolute).toBe(file)
  })

  test('多根——每条各取 `realpath`（声明原值不作数，注册根是规范形）', () => {
    const [a, b] = [freshRoot(), freshRoot()]
    const { roots: real } = workspaceOnAll([a, b])

    expect(real).toEqual([realpathSync(a), realpathSync(b)])
  })
})

describe('根校验——报错不降级（照 `dataDir` 的先例）', () => {
  test('不存在 → 拒（工作区机器锚定在真路径上）', () => {
    expect(() => createWorkspaceService({ roots: ['/definitely/not/here/xyz'] })).toThrow()
  })

  test('不是目录（是个文件）→ 拒', () => {
    const root = freshRoot()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'x')

    expect(() => createWorkspaceService({ roots: [file] })).toThrow(/不是目录/)
    // 文件混在合法根里同拒——一条不合格即整份配置不成立，不是「跳过那条」
    expect(() => createWorkspaceService({ roots: [root, file] })).toThrow(/不是目录/)
  })

  test('重复（同一条写两遍）→ 拒，且点名是第几条撞第几条', () => {
    const root = freshRoot()

    expect(() => createWorkspaceService({ roots: [root, root] })).toThrow(/重复/)
    expect(() => createWorkspaceService({ roots: [root, root] })).toThrow(/第 2 条.*第 1 条/)
  })

  test('重复在**规范化之后**判——两条写法不同、实为同一目录者同拒', () => {
    // macOS 上 `/tmp/x` 与 `/private/tmp/x` 是同一个目录；词法比较漏得掉，realpath 后判才严。
    const root = freshRoot()
    const link = join(freshRoot(), 'alias')
    symlinkSync(root, link)

    expect(realpathSync(link)).toBe(realpathSync(root)) // 前提成立才谈得上判重
    expect(() => createWorkspaceService({ roots: [root, link] })).toThrow(/重复/)
  })

  test('相对路径 → 拒（根是绝对路径）', () => {
    expect(() => createWorkspaceService({ roots: ['relative/path'] })).toThrow(/绝对路径/)
    expect(() => createWorkspaceService({ roots: ['./here'] })).toThrow(/绝对路径/)
    // 前导 `~` **不是**绝对路径——本域不展开它（展开归配置层，本轮未长该行为）
    expect(() => createWorkspaceService({ roots: ['~/work'] })).toThrow(/绝对路径/)
  })

  test('空列表 → 拒（工作区是「≥ 1 条」的联合作用域——零根无默认根可言）', () => {
    expect(() => createWorkspaceService({ roots: [] })).toThrow(/至少一条|空/)
  })

  test('拒时点名是第几条（多条根下，用户得知道改哪一行）', () => {
    const root = freshRoot()

    expect(() => createWorkspaceService({ roots: [root, 'nope'] })).toThrow(/第 2 条/)
  })
})

describe('目标解析只产出事实，权限由工具入口裁决', () => {
  test('相对路径按默认根归一；不存在目标带 null 身份', () => {
    const { ws, root } = workspaceOn(freshRoot())
    expect(ws.resolve('sub/../new').absolute).toBe(join(root, 'new'))
    expect(ws.resolve('new').identity).toBeNull()
    expect(ws.resolve('new').parentIdentity).toBeDefined()
    expect(ws.resolve('.').root).toBe(root)
    expect(ws.resolve('a/../../outside').root).toBeUndefined()
  })

  test('多根中的落点返回所属根，根外与相邻前缀不抛、不伪造所属根', () => {
    const { ws, roots: real } = workspaceOnAll([freshRoot(), freshRoot()])
    expect(ws.resolve(`../${basename(nth(real, 1))}/x`).root).toBe(nth(real, 1))
    expect(ws.resolve('/outside-file').root).toBeUndefined()
    expect(ws.resolve(`${nth(real, 0)}-sibling/x`).root).toBeUndefined()
    expect(ws.resolve('..').root).toBeUndefined()
  })

  test('根声明链接与文件链接都解析到真实落点；根内链接不能冒充根内目标', () => {
    const inside = freshRoot(), outside = freshRoot(), alias = join(freshRoot(), 'alias')
    symlinkSync(inside, alias)
    const { ws, root } = workspaceOn(alias)
    writeFileSync(join(outside, 'file'), 'content')
    symlinkSync(join(outside, 'file'), join(inside, 'link'))
    expect(ws.resolve(join(alias, 'new')).absolute).toBe(join(root, 'new'))
    const target = ws.resolve('link')
    expect(target.absolute).toBe(realpathSync(join(outside, 'file')))
    expect(target.root).toBeUndefined()
    expect(target.identity).toBeDefined()
  })

  test('悬空链接与尚不存在的后代按已有祖先解析', () => {
    const { ws, root } = workspaceOn(freshRoot())
    const outside = realpathSync(freshRoot())
    symlinkSync(join(outside, 'new'), join(root, 'dangling'))
    symlinkSync(outside, join(root, 'dir'))
    expect(ws.resolve('dangling').absolute).toBe(join(outside, 'new'))
    expect(ws.resolve('dir/missing/file').absolute).toBe(join(outside, 'missing/file'))
    expect(ws.resolve('dangling').root).toBeUndefined()
  })
})
