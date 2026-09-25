/**
 * U13 · 搜索与列目录工具 —— `grep` · `glob` · `ls`（工具集 v1）。
 *
 * 判据（任务书 · 退出条件）：**逐工具用例——六个工具各走通一遍**；**危险归类正确**
 * （三件皆轻，照契约冻结行声明）。真文件系统那一趟在 `playground/` 的冒烟脚本里
 * （本包 `test/**` 只许取 `@magic/contracts` ＋ `@magic/faux`）。
 *
 * 本文件钉两件：**参数怎么摆到沙箱**（`mode` 判别式 / 起点 / 上限 / 取消）与
 * **结果怎么成文**（命中一行一条 · 空结果明说 · 取满上限不假装完整）。
 */

import { describe, expect, test } from 'bun:test'
import type { MatchHit } from '@magic/contracts'
import { TOOLSET_V1 } from '@magic/contracts'
import { makeFauxSandbox } from '@magic/faux'
import { SEARCH_MAX_RESULTS } from '../src/search-tools.ts'
import { makeToolDeps } from './helpers.ts'

function row(name: string): (typeof TOOLSET_V1)[number] {
  const found = TOOLSET_V1.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`契约里没有 ${name} 行`)
  return found
}

function hit(overrides: Partial<MatchHit> = {}): MatchHit {
  return { path: '/work/proj/src/a.ts', line: 3, column: 7, text: 'const a = 1', ...overrides }
}

// ══ grep ══════════════════════════════════════════════════════════════

describe('U13 · grep', () => {
  test('走通：mode=grep ＋ 起点 ＋ 上限交给沙箱，命中成「路径:行号: 原文」', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({ hits: [hit(), hit({ path: '/work/proj/b.md', line: 9, text: '# a' })] }),
    })

    const result = await runtime.invoke(
      { id: 'c1', name: 'grep', args: { pattern: 'const', path: 'src' } },
      {},
    )

    expect(sandbox.matches).toHaveLength(1)
    expect(sandbox.matches[0]?.pattern).toBe('const')
    expect(sandbox.matches[0]?.opts.mode).toBe('grep')
    expect(sandbox.matches[0]?.opts.path).toBe('src')
    expect(sandbox.matches[0]?.opts.maxResults).toBe(SEARCH_MAX_RESULTS)

    expect(result.ok).toBe(true)
    expect(result.output).toBe('/work/proj/src/a.ts:3: const a = 1\n/work/proj/b.md:9: # a')
  })

  test('起点缺省＝工作区根（不传 path 键，不猜「.」）', async () => {
    const { runtime, sandbox } = makeToolDeps()

    await runtime.invoke({ id: 'c1', name: 'grep', args: { pattern: 'x' } }, {})

    expect(sandbox.matches[0]?.opts.path).toBeUndefined()
  })

  test('取消面透传（长搜索可被 Ctrl-C 收掉）', async () => {
    const { runtime, sandbox } = makeToolDeps()
    const controller = new AbortController()

    await runtime.invoke(
      { id: 'c1', name: 'grep', args: { pattern: 'x' } },
      { signal: controller.signal },
    )

    expect(sandbox.matches[0]?.opts.signal).toBe(controller.signal)
  })

  test('无命中 → 明说（空输出会被当成失败）', async () => {
    const { runtime } = makeToolDeps({ sandbox: makeFauxSandbox({ hits: [] }) })

    const result = await runtime.invoke({ id: 'c1', name: 'grep', args: { pattern: 'x' } }, {})

    expect(result.ok).toBe(true)
    expect(result.output).toBe('[无命中]')
  })

  test('取满上限 → **不假装完整**（明说可能还有更多）', async () => {
    const many = Array.from({ length: SEARCH_MAX_RESULTS }, (_, index) => hit({ line: index + 1 }))
    const { runtime } = makeToolDeps({ sandbox: makeFauxSandbox({ hits: many }) })

    const result = await runtime.invoke({ id: 'c1', name: 'grep', args: { pattern: 'x' } }, {})

    expect(result.output.endsWith(`[命中达到上限 ${SEARCH_MAX_RESULTS}——可能还有更多]`)).toBe(true)
  })

  test('沙箱失败（正则无效 / 起点不存在）→ ok:false ＋ 原委', async () => {
    const failing = {
      ...makeFauxSandbox(),
      match: () => Promise.reject(new Error('正则无效（alpha(）：Invalid regular expression')),
    }
    const { runtime } = makeToolDeps({ sandbox: failing })

    const result = await runtime.invoke({ id: 'c1', name: 'grep', args: { pattern: 'alpha(' } }, {})

    expect(result.ok).toBe(false)
    expect(result.output).toBe('搜索失败：正则无效（alpha(）：Invalid regular expression')
  })

  test('参数错误：pattern 与 path 各有说法，都不碰沙箱', async () => {
    const { runtime, sandbox } = makeToolDeps()

    const noPattern = await runtime.invoke({ id: 'c1', name: 'grep', args: { path: 'src' } }, {})
    expect(noPattern.output).toBe('参数错误：pattern 须为非空字符串')

    const badPath = await runtime.invoke(
      { id: 'c2', name: 'grep', args: { pattern: 'x', path: '' } },
      {},
    )
    expect(badPath.output).toBe('参数错误：path 须为非空字符串')

    expect(sandbox.matches).toEqual([])
  })

  test('危险归类＝轻（照契约冻结行声明）', async () => {
    const { runtime } = makeToolDeps()
    const spec = runtime.definitions().find((definition) => definition.name === 'grep')

    expect(spec?.summary).toBe(row('grep').summary)
    expect(spec?.danger).toEqual({ level: 'light' })
  })
})

// ══ glob ══════════════════════════════════════════════════════════════

describe('U13 · glob', () => {
  test('走通：mode=glob，命中只有路径（无行号）', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({
        hits: [{ path: '/work/proj/src/a.ts' }, { path: '/work/proj/src/b.ts' }],
      }),
    })

    const result = await runtime.invoke(
      { id: 'c1', name: 'glob', args: { pattern: '**/*.ts' } },
      {},
    )

    expect(sandbox.matches[0]?.pattern).toBe('**/*.ts')
    expect(sandbox.matches[0]?.opts.mode).toBe('glob')

    expect(result.ok).toBe(true)
    expect(result.output).toBe('/work/proj/src/a.ts\n/work/proj/src/b.ts')
  })

  test('无命中 → 明说', async () => {
    const { runtime } = makeToolDeps({ sandbox: makeFauxSandbox({ hits: [] }) })

    const result = await runtime.invoke({ id: 'c1', name: 'glob', args: { pattern: '**/*.rs' } }, {})

    expect(result.output).toBe('[无命中]')
  })

  test('参数错误：pattern 取不到', async () => {
    const { runtime, sandbox } = makeToolDeps()

    const result = await runtime.invoke({ id: 'c1', name: 'glob', args: {} }, {})

    expect(result.output).toBe('参数错误：pattern 须为非空字符串')
    expect(sandbox.matches).toEqual([])
  })

  test('危险归类＝轻', async () => {
    const { runtime } = makeToolDeps()
    const spec = runtime.definitions().find((definition) => definition.name === 'glob')

    expect(spec?.summary).toBe(row('glob').summary)
    expect(spec?.danger).toEqual({ level: 'light' })
  })
})

// ══ ls ════════════════════════════════════════════════════════════════

describe('U13 · ls', () => {
  test('走通：目录带尾斜杠、文件带字节数', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({
        dirs: {
          src: [
            { name: 'a.ts', kind: 'file', size: 12 },
            { name: 'nested', kind: 'directory' },
          ],
        },
      }),
    })

    const result = await runtime.invoke({ id: 'c1', name: 'ls', args: { path: 'src' } }, {})

    expect(sandbox.lists).toEqual(['src'])
    expect(result.ok).toBe(true)
    expect(result.output).toBe('a.ts  (12 字节)\nnested/')
  })

  test('起点缺省＝工作区根（沙箱按「.」相对默认根解析）', async () => {
    const { runtime, sandbox } = makeToolDeps()

    await runtime.invoke({ id: 'c1', name: 'ls', args: {} }, {})

    expect(sandbox.lists).toEqual(['.'])
  })

  test('空目录 → 明说', async () => {
    const { runtime } = makeToolDeps({ sandbox: makeFauxSandbox({ dirs: { vacant: [] } }) })

    const result = await runtime.invoke({ id: 'c1', name: 'ls', args: { path: 'vacant' } }, {})

    expect(result.ok).toBe(true)
    expect(result.output).toBe('[空目录]')
  })

  test('沙箱失败（目录不存在 / 是文件）→ ok:false ＋ 沙箱那句**逐字**回填（列目录归文件类）', async () => {
    // `ls` 与 `grep` / `glob` 同在这个文件里，但**归文件类**（U83 · D41 只碰读 / 写 /
    // 列目录 / 编辑）：沙箱那句 `列目录失败（path）：目录不存在` 已是一整句 ⇒ 原样回填。
    // ⚠️ 上面搜索那两支**不在本单的边界内**，它们的措辞一个字不动。
    const reason = '列目录失败（/w/no-such）：目录不存在'
    const failing = {
      ...makeFauxSandbox(),
      list: () => Promise.reject(new Error(reason)),
    }
    const { runtime } = makeToolDeps({ sandbox: failing })

    const result = await runtime.invoke({ id: 'c1', name: 'ls', args: { path: 'no-such' } }, {})

    expect(result.ok).toBe(false)
    expect(result.output).toBe(reason)
    expect(result.output.split('列目录失败').length - 1).toBe(1)
  })

  test('参数错误：path 给了却不成形（不静默当缺省）', async () => {
    const { runtime, sandbox } = makeToolDeps()

    const result = await runtime.invoke({ id: 'c1', name: 'ls', args: { path: 7 } }, {})

    expect(result.output).toBe('参数错误：path 须为非空字符串')
    expect(sandbox.lists).toEqual([])
  })

  test('危险归类＝轻', async () => {
    const { runtime } = makeToolDeps()
    const spec = runtime.definitions().find((definition) => definition.name === 'ls')

    expect(spec?.summary).toBe(row('ls').summary)
    expect(spec?.danger).toEqual({ level: 'light' })
  })
})
