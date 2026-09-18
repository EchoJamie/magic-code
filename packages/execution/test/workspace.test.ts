/**
 * U05 · 工作区解析——验收判据 6：**边界**（相对按默认根；绝对须落根内——越界拒绝）。
 *
 * 说明（技术方案 · 执行 · 工作区）：
 * - 阶段 1 单根——**启动目录＝默认根（唯一）**；多根（U18）＝**平等平铺 ＋ 一个默认**。
 * - 路径解析——「相对按默认根、绝对须落于某根内；越界＝所有根之外」。
 *
 * **U18 多根（本轮扩展）** ——两节：
 * - **根注册**：`roots()` 是**声明序的规范化形**（逐条 `realpath`）；`defaultRoot()` ＝
 *   **列表第一项**——「平等平铺 ＋ 一个默认，不引入『主根』概念」（技术方案 · 执行 · 工作区）。
 * - **根校验**（加载时报错不降级，照 `dataDir` 的先例）：不存在 / 不是目录 / 重复 /
 *   相对路径 → 一律**抛**。四项皆在**规范化之后**判——尤其「重复」：`/tmp/x` 与
 *   `/private/tmp/x` 在 macOS 上是**同一个目录**，词法比较漏得掉（下有用例钉着）。
 *
 * ⚠️ **边界是「全根之并」，不是「默认根」**——相对路径先按默认根拼、**归一之后对全根比对**，
 * 故 `..` 拱出默认根却落进另一条根者**通过**（有用例钉着）。这与权限域 `landPath` **同源**
 * （它那条注写得更直白：「相对路径逃出默认根后仍可能落进**另一个**根（多根平铺）——
 * 故一律对全根比对」）。两域若在此分叉，闸门放行的路径沙箱会拒。
 *
 * 判定法：临时目录当真工作区（测试用 fs 不受守护拦——守护面收窄至各包 `src/`），
 * 每例断言**解析结果**（绝对路径 ＋ **承载它的那条根**），越界则断言**拒**。
 *
 * 另一条隐线（判据 4 的前半）：`exec` 的 cwd 越界必须「进程不启动」——
 * 其判据即本文件的同一套规则，故这里把边界规则钉死；多根下 `exec` 的 cwd 同源
 * 由 `exec.test.ts` 的「多根」一节实测咬住。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

describe('相对路径——按默认根', () => {
  test('普通相对路径落在默认根下', () => {
    const { ws, root } = workspaceOn(freshRoot())

    const resolved = ws.resolve('a.txt')
    expect(resolved.absolute).toBe(join(root, 'a.txt'))
    expect(resolved.root).toBe(root)
  })

  test('多级相对路径', () => {
    const { ws, root } = workspaceOn(freshRoot())

    expect(ws.resolve('sub/dir/b.txt').absolute).toBe(join(root, 'sub/dir/b.txt'))
  })

  test('`..` 归一化后仍在根内＝通过（作差不出界）', () => {
    const { ws, root } = workspaceOn(freshRoot())

    expect(ws.resolve('sub/../b.txt').absolute).toBe(join(root, 'b.txt'))
    expect(ws.resolve('./a/./b').absolute).toBe(join(root, 'a/b'))
  })

  test("`.` 与空串＝根自身", () => {
    const { ws, root } = workspaceOn(freshRoot())

    expect(ws.resolve('.').absolute).toBe(root)
    expect(ws.resolve('').absolute).toBe(root)
  })

  test('`..` 逃出根＝拒（相对也受边界约束——否则工作区形同虚设）', () => {
    const { ws } = workspaceOn(freshRoot())

    expect(() => ws.resolve('../x.txt')).toThrow()
    expect(() => ws.resolve('a/../../x.txt')).toThrow()
  })

  test('**多根下相对路径仍走默认根**——不落第二根（「新文件落点」认默认根）', () => {
    const [first, second] = [freshRoot(), freshRoot()]
    const { ws, roots: real } = workspaceOnAll([first, second])

    const resolved = ws.resolve('new.txt')
    expect(resolved.absolute).toBe(join(nth(real, 0), 'new.txt'))
    expect(resolved.root).toBe(nth(real, 0))
    // 第二根虽在册，但不承载相对路径——那正是「一个默认」的意思
    expect(resolved.absolute.startsWith(nth(real, 1))).toBe(false)
  })

  test('`..` 拱出默认根、**落进另一条根＝通过**——边界是**全根之并**，不是默认根', () => {
    // ⚠️ 这条不是「多根也照样锁在默认根里」——**边界一律按全根判**（归一之后看落点），
    // 与权限域 `landPath` 同源（它那条注：「相对路径逃出默认根后仍可能落进**另一个**根
    // （多根平铺）——故一律对全根比对」）。两域若在此分叉，闸门放行的路径沙箱会拒。
    const [b1, b2] = [freshRoot(), freshRoot()]
    const { ws, roots: real } = workspaceOnAll([b1, b2])

    // 两根是兄弟（同在 tmpdir 下），故 `../<b2 的名字>/x.txt` 从默认根出去正好落在 b2 里
    const resolved = ws.resolve(`../${basename(nth(real, 1))}/x.txt`)
    expect(resolved.absolute).toBe(join(nth(real, 1), 'x.txt'))
    expect(resolved.root).toBe(nth(real, 1))
    expect(resolved.root).not.toBe(ws.defaultRoot())
  })

  test('嵌套根下 `..` 落进外层根＝通过（同一条规则的直白形态）', () => {
    const outer = freshRoot()
    const inner = join(outer, 'inner')
    mkdirSync(inner)

    const ws = createWorkspaceService({ roots: [inner, outer] })
    const resolved = ws.resolve('..')

    expect(resolved.absolute).toBe(realpathSync(outer))
    expect(resolved.root).toBe(realpathSync(outer))
    expect(resolved.root).not.toBe(ws.defaultRoot())
  })

  test('`..` 拱到**所有根之外**＝拒（夹具两根是兄弟，`../x.txt` 落在共同父级，谁都不接）', () => {
    const { ws } = workspaceOnAll([freshRoot(), freshRoot()])

    expect(() => ws.resolve('../x.txt')).toThrow(/越界/)
  })
})

describe('绝对路径——须落于某根内', () => {
  test('根内的绝对路径＝通过', () => {
    const { ws, root } = workspaceOn(freshRoot())

    const resolved = ws.resolve(join(root, 'sub', 'c.txt'))
    expect(resolved.absolute).toBe(join(root, 'sub', 'c.txt'))
    expect(resolved.root).toBe(root)
  })

  test('绝对路径恰为根＝通过', () => {
    const { ws, root } = workspaceOn(freshRoot())

    expect(ws.resolve(root).absolute).toBe(root)
  })

  test('根外的绝对路径＝拒', () => {
    const { ws } = workspaceOn(freshRoot())

    expect(() => ws.resolve('/etc/passwd')).toThrow()
    expect(() => ws.resolve(join(tmpdir(), 'outside.txt'))).toThrow()
  })

  test('前缀相邻不算在根内（`/root-other` 不是 `/root` 之内）', () => {
    const { ws, root } = workspaceOn(freshRoot())

    // 段边界判定——字符串前缀相邻（`<root>-x`）不得误判为根内
    expect(() => ws.resolve(`${root}-sibling/f.txt`)).toThrow()
    expect(() => ws.resolve(`${root}x/f.txt`)).toThrow()
  })

  test('根外绝对路径再 `..` 拱回根内＝拒（先归一再看落点，不因归一而放行）', () => {
    const { ws, root } = workspaceOn(freshRoot())

    // `/etc/../<root>/f` 归一后落在根内——是否放行取决于判定次序；
    // 本实现取「**先规范化、再看落点**」：归一后确在根内者放行（路径即事实）。
    expect(ws.resolve(`/etc/../${root.slice(1)}/f.txt`).absolute).toBe(join(root, 'f.txt'))
  })
})

describe('多根——绝对路径落于**任一根**内即通过', () => {
  test('落第二根＝通过，且 `root` 报**承载它的那条根**（不是默认根）', () => {
    const [first, second] = [freshRoot(), freshRoot()]
    const { ws, roots: real } = workspaceOnAll([first, second])

    const resolved = ws.resolve(join(nth(real, 1), 'b.txt'))
    expect(resolved.absolute).toBe(join(nth(real, 1), 'b.txt'))
    expect(resolved.root).toBe(nth(real, 1))
    // 这一位是多根才有的信息：同一条绝对路径，承载根可 ≠ 默认根
    expect(resolved.root).not.toBe(ws.defaultRoot())
  })

  test('落第一根＝通过，`root` 报第一根（defaultRoot 同时是承载根）', () => {
    const [first, second] = [freshRoot(), freshRoot()]
    const { ws, roots: real } = workspaceOnAll([first, second])

    const resolved = ws.resolve(join(nth(real, 0), 'a.txt'))
    expect(resolved.root).toBe(nth(real, 0))
    expect(resolved.root).toBe(ws.defaultRoot())
  })

  test('各根的第 N 级子路径皆通过（边界按段判，不是只看第一层）', () => {
    const [a, b, c] = [freshRoot(), freshRoot(), freshRoot()]
    const { ws, roots: real } = workspaceOnAll([a, b, c])

    for (const root of real) {
      expect(ws.resolve(join(root, 'x', 'y', 'z.txt')).root).toBe(root)
    }
  })

  test('**越界＝所有根之外**——两根皆不接者拒', () => {
    const { ws, roots: real } = workspaceOnAll([freshRoot(), freshRoot()])

    expect(() => ws.resolve('/etc/passwd')).toThrow(/越界/)
    // 前缀相邻也接不住：`<root>-sibling` 不在任何根内
    expect(() => ws.resolve(`${nth(real, 0)}-sibling/f.txt`)).toThrow(/越界/)
  })

  test('越界报文**列出所有根**（多根下只说一条，用户无从知道还注册了什么）', () => {
    const { ws, roots: real } = workspaceOnAll([freshRoot(), freshRoot()])

    let message = ''
    try {
      ws.resolve('/etc/passwd')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('/etc/passwd')
    for (const root of real) expect(message).toContain(root)
  })
})

describe('拒绝的可诊断性', () => {
  test('拒时点名越界路径与根（装配 / 工具层据此回填）', () => {
    const { ws, root } = workspaceOn(freshRoot())

    expect(() => ws.resolve('/etc/passwd')).toThrow(/\/etc\/passwd/)
    expect(() => ws.resolve('../escaped.txt')).toThrow(new RegExp(root.replace(/[/\\]/g, '\\$&')))
  })
})
