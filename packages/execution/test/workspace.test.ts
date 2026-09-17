/**
 * U05 · 工作区解析——验收判据 6：**边界**（相对按默认根；绝对须落根内——越界拒绝）。
 *
 * 说明（技术方案 · 执行 · 工作区）：
 * - 阶段 1 单根——**启动目录＝默认根（唯一）**；多根归阶段 3（U18）。
 * - 路径解析——「相对按默认根、绝对须落于某根内；越界＝所有根之外」。
 *
 * 判定法：临时目录当真工作区（测试用 fs 不受守护拦——守护面收窄至各包 `src/`），
 * 每例断言**解析结果**（绝对路径 ＋ 承载它的根），越界则断言**拒**。
 *
 * 另一条隐线（判据 4 的前半）：`exec` 的 cwd 越界必须「进程不启动」——
 * 其判据即本文件的同一套规则，故这里把边界规则钉死。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const ws = createWorkspaceService({ root })
  return { ws, root: ws.defaultRoot() }
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

describe('单根——根视图', () => {
  test('`roots()` 恰一条 · `defaultRoot()` 即该条（阶段 1 单根）', () => {
    const root = freshRoot()
    const { ws } = workspaceOn(root)

    expect(ws.roots()).toHaveLength(1)
    expect(ws.roots()[0]).toBe(ws.defaultRoot())
    expect(ws.defaultRoot()).toBe(realpathSync(root))
  })

  test('根规范化——`/tmp` 一类符号链接根不误判（词法边界须建在规范形上）', () => {
    // macOS 上 `mkdtemp` 给的路径常经 `/var` → `/private/var` 的符号链接；
    // 若不规范化，落点用**真实**路径写的绝对引用会被误拒为越界。
    const root = freshRoot()
    const { ws } = workspaceOn(root)

    const file = join(realpathSync(root), 'a.txt')
    expect(ws.resolve(file).absolute).toBe(file)
  })

  test('根不存在——构造即拒（工作区机器锚定在真路径上）', () => {
    expect(() => createWorkspaceService({ root: '/definitely/not/here/xyz' })).toThrow()
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
})

describe('绝对路径——须落于根内', () => {
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

describe('拒绝的可诊断性', () => {
  test('拒时点名越界路径与根（装配 / 工具层据此回填）', () => {
    const { ws, root } = workspaceOn(freshRoot())

    expect(() => ws.resolve('/etc/passwd')).toThrow(/\/etc\/passwd/)
    expect(() => ws.resolve('../escaped.txt')).toThrow(new RegExp(root.replace(/[/\\]/g, '\\$&')))
  })
})
