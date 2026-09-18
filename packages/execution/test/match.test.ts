/**
 * U13 · 沙箱匹配原语 —— `match`（grep / glob **共用一条底** · 真文件系统 · 临时目录）。
 *
 * 出处：技术方案 · 执行「原语形态（决策级）」——`match(pattern, opts)`（grep / glob 共用底）；
 * 技术方案 · 工具集 v1——`grep`（内容搜索 · 正则 · **输出截断**）/ `glob`（文件名匹配）。
 *
 * 形态（U13 落，见契约 `MatchOptions`）：`mode` 是判别式；`path` 是搜索起点（缺省＝默认根）；
 * `maxResults` 是**命中数上限**（取满即可能还有更多）；`signal` 取消＝**返回已收到的**（不抛）。
 *
 * 两条实现级裁量（随回报备案）：
 * - **不跟符号链接目录**（`readdir` 的类型位对链接不报目录）——绕环，也是薄隔离的既有姿态；
 * - **跳过 `.git` / `node_modules`**——搜索这两个目录几乎从不是本意，代价却是整棵树。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MatchHit, Sandbox } from '@magic/contracts'
import { createSandbox, createWorkspaceService } from '../src/index.ts'

// —— 夹具 ——

const roots: string[] = []

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'magic-match-'))
  roots.push(root)
  return root
}

function sandboxOn(root: string): { box: Sandbox; root: string } {
  const workspace = createWorkspaceService({ roots: [root] })
  return { box: createSandbox({ workspace }), root: workspace.defaultRoot() }
}

function freshSandbox(): { box: Sandbox; root: string } {
  return sandboxOn(freshRoot())
}

function seed(root: string, relative: string, content: string): string {
  const absolute = join(root, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

/** 一棵小树——grep / glob 共用的现场。 */
function seedTree(root: string): void {
  seed(root, 'a.ts', 'const alpha = 1\n// TODO: 改这里\nconst beta = 2\n')
  seed(root, 'src/b.ts', 'const gamma = 3\n// todo: 小写不该被默认命中\n')
  seed(root, 'src/nested/c.ts', 'export const alpha = 9\n')
  seed(root, 'docs/readme.md', 'alpha 出现在文档里\n')
}

/** 命中路径的相对形（断言里比相对路径，免得把临时目录前缀抄进期望值）。 */
function relativeTo(root: string, hits: readonly MatchHit[]): string[] {
  return hits.map((hit) => hit.path.slice(root.length + 1)).sort()
}

process.on('exit', () => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判定
    }
  }
})

type _FaceMatchesPort = ReturnType<typeof createSandbox> extends Sandbox ? true : never
const _faceProbe: _FaceMatchesPort = true
void _faceProbe

// ══ grep（mode: 'grep'）═══════════════════════════════════════════════

describe("U13 · match(grep) —— 内容搜索", () => {
  test('命中：路径（绝对）· 行号（1 起）· 列号 · 该行原文', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    const hits = await box.match('TODO', { mode: 'grep' })

    expect(hits).toHaveLength(1)
    const hit = hits[0]!
    expect(hit.path).toBe(join(root, 'a.ts'))
    expect(hit.line).toBe(2)
    expect(hit.column).toBe(4)
    expect(hit.text).toBe('// TODO: 改这里')
  })

  test('同一文件多处命中 → 每条一行（逐行给，不并成一条）', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'many.txt', 'alpha\nnope\nalpha\n')

    const hits = await box.match('alpha', { mode: 'grep' })

    expect(hits.map((hit) => hit.line)).toEqual([1, 3])
    expect(hits.every((hit) => hit.path === join(root, 'many.txt'))).toBe(true)
  })

  test('递归到子目录（路径是根内绝对形式）', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    const hits = await box.match('alpha', { mode: 'grep' })

    expect(relativeTo(root, hits)).toEqual(['a.ts', 'docs/readme.md', 'src/nested/c.ts'])
    expect(hits.every((hit) => hit.path.startsWith(root))).toBe(true)
  })

  test('大小写按正则语义（默认不忽略大小写）', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    expect(relativeTo(root, await box.match('todo', { mode: 'grep' }))).toEqual(['src/b.ts'])
    expect(relativeTo(root, await box.match('todo', { mode: 'grep' }))).not.toContain('a.ts')
  })

  test('path 收窄搜索起点（相对按默认根）', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    const hits = await box.match('alpha', { mode: 'grep', path: 'src' })

    expect(relativeTo(root, hits)).toEqual(['src/nested/c.ts'])
  })

  test('无命中 → 空数组（不是失败）', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    expect(await box.match('不存在的字串', { mode: 'grep' })).toEqual([])
  })

  test('maxResults 截断：至多这么多条', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'long.txt', Array.from({ length: 50 }, (_, i) => `hit ${i}`).join('\n'))

    const hits = await box.match('hit', { mode: 'grep', maxResults: 5 })

    expect(hits).toHaveLength(5)
  })

  test('正则无效 → 抛，报文点出模式', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    await expect(box.match('alpha(', { mode: 'grep' })).rejects.toThrow(/正则无效/)
    await expect(box.match('alpha(', { mode: 'grep' })).rejects.toThrow(/alpha\(/)
  })

  test('跳过 .git 与 node_modules（列在其中的文件不被搜）', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)
    seed(root, '.git/objects/alpha', 'alpha 在版本库里\n')
    seed(root, 'node_modules/pkg/index.js', 'alpha 在依赖里\n')

    const hits = await box.match('alpha', { mode: 'grep' })

    expect(hits.every((hit) => !hit.path.includes('/.git/'))).toBe(true)
    expect(hits.every((hit) => !hit.path.includes('/node_modules/'))).toBe(true)
  })

  test('行尾 CRLF 的 \\r 不带进命中文本（模型看到的该行就是该行）', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'crlf.txt', 'alpha\r\nbeta\r\n')

    const hits = await box.match('alpha', { mode: 'grep' })

    expect(hits[0]?.text).toBe('alpha')
  })

  test('起点不存在 / 不是目录 → 抛（不明知是空目录还搜一遍）', async () => {
    const { box, root } = freshSandbox()
    seed(root, 'afile.txt', 'x')

    await expect(box.match('x', { mode: 'grep', path: 'no-such' })).rejects.toThrow(/目录不存在/)
    await expect(box.match('x', { mode: 'grep', path: 'afile.txt' })).rejects.toThrow(/不是目录/)
  })

  test('取消：中止在途 → 返回已收到的（不抛）且不超上限', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)
    const controller = new AbortController()
    controller.abort()

    const hits = await box.match('alpha', { mode: 'grep', signal: controller.signal })

    expect(hits.length).toBeLessThan(3) // 已中止：至多给到中止前那一点
  })

  test('越界 → 抛（起点与相对逃逸都拒）', async () => {
    const { box } = freshSandbox()

    await expect(box.match('x', { mode: 'grep', path: '/etc' })).rejects.toThrow(/工作区越界/)
    await expect(box.match('x', { mode: 'grep', path: '..' })).rejects.toThrow(/工作区越界/)
  })
})

// ══ glob（mode: 'glob'）═══════════════════════════════════════════════

describe("U13 · match(glob) —— 文件名匹配", () => {
  test('递归模式 **/*.ts → 各层都命中（只给路径，行号等缺席）', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    const hits = await box.match('**/*.ts', { mode: 'glob' })

    expect(relativeTo(root, hits)).toEqual(['a.ts', 'src/b.ts', 'src/nested/c.ts'])
    expect(hits.every((hit) => hit.line === undefined && hit.text === undefined)).toBe(true)
  })

  test('单段模式只匹配一层（glob 的常规语义，不默认递归）', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    expect(relativeTo(root, await box.match('*.ts', { mode: 'glob' }))).toEqual(['a.ts'])
  })

  test('只出文件、不出目录', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    const hits = await box.match('**/src', { mode: 'glob' })

    expect(hits).toEqual([])
  })

  test('path 收窄起点 + 无命中 → 空数组', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)

    expect(relativeTo(root, await box.match('**/*.md', { mode: 'glob', path: 'docs' }))).toEqual([
      'docs/readme.md',
    ])
    expect(await box.match('**/*.rs', { mode: 'glob' })).toEqual([])
  })

  test('maxResults 截断：至多这么多条', async () => {
    const { box, root } = freshSandbox()
    for (let i = 0; i < 20; i += 1) seed(root, `f${i}.txt`, 'x')

    expect(await box.match('**/*.txt', { mode: 'glob', maxResults: 3 })).toHaveLength(3)
  })

  test('跳过 .git 与 node_modules', async () => {
    const { box, root } = freshSandbox()
    seedTree(root)
    seed(root, 'node_modules/pkg/index.js', 'x')

    const hits = await box.match('**/*.js', { mode: 'glob' })

    expect(hits).toEqual([])
  })

  test('起点不存在 / 越界 → 抛', async () => {
    const { box } = freshSandbox()

    await expect(box.match('**/*.ts', { mode: 'glob', path: 'no-such' })).rejects.toThrow(
      /目录不存在/,
    )
    await expect(box.match('**/*.ts', { mode: 'glob', path: '/etc' })).rejects.toThrow(/工作区越界/)
  })
})
