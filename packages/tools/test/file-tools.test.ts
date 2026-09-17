/**
 * U13 · 文件类工具 —— `read` · `write` · `edit`（工具集 v1）。
 *
 * 判据（任务书 · 退出条件）：**逐工具用例——六个工具各走通一遍**（真文件系统在
 * `playground/` 的冒烟脚本里：本包 `test/**` 只许取 `@magic/contracts` ＋ `@magic/faux`）；
 * **`edit` 要覆盖唯一定位 · 失配即报**。
 *
 * 本文件钉的是**本域该做什么**：参数怎么摆、结果怎么成文、失败怎么回填。
 * 「与真沙箱接得上」由冒烟那一趟补（U06 的先例：替身钉不住接缝）。
 */

import { describe, expect, test } from 'bun:test'
import type { ReadResult } from '@magic/contracts'
import { TOOLSET_V1 } from '@magic/contracts'
import { makeFauxSandbox } from '@magic/faux'
import { BLOB_THRESHOLD_BYTES } from '../src/blobs.ts'
import { makeToolDeps } from './helpers.ts'

/** 取工具集 v1 的冻结行（断言「声明」时对照用）。 */
function row(name: string): (typeof TOOLSET_V1)[number] {
  const found = TOOLSET_V1.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`契约里没有 ${name} 行`)
  return found
}

// ══ read ══════════════════════════════════════════════════════════════

describe('U13 · read', () => {
  test('走通：调沙箱 read(path)，内容原样回给模型', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({ files: { 'src/a.ts': 'export const a = 1\n' } }),
    })

    const result = await runtime.invoke({ id: 'c1', name: 'read', args: { path: 'src/a.ts' } }, {})

    expect(sandbox.reads).toEqual(['src/a.ts'])
    expect(result.ok).toBe(true)
    expect(result.output).toBe('export const a = 1\n')
  })

  test('空文件明说（空输出会被当成失败）', async () => {
    const { runtime } = makeToolDeps({ sandbox: makeFauxSandbox({ files: { 'empty.txt': '' } }) })

    const result = await runtime.invoke({ id: 'c1', name: 'read', args: { path: 'empty.txt' } }, {})

    expect(result.ok).toBe(true)
    expect(result.output).toBe('[文件为空]')
  })

  test('截断如实报：内容 ＋ 截断注（注自成一行）', async () => {
    const truncated = {
      ...makeFauxSandbox(),
      read: (): Promise<ReadResult> => Promise.resolve({ content: 'abc', truncated: true }),
    }
    const { runtime } = makeToolDeps({ sandbox: truncated })

    const result = await runtime.invoke({ id: 'c1', name: 'read', args: { path: 'big.txt' } }, {})

    expect(result.output).toBe('abc\n[已截断——文件超长，只读到前一段]')
  })

  test('沙箱失败（越界 / 不存在）→ ok:false ＋ 原委照带（工具不自造口径）', async () => {
    const failing = {
      ...makeFauxSandbox(),
      read: () => Promise.reject(new Error('读取失败（/etc/hosts）：文件不存在')),
    }
    const { runtime, sink } = makeToolDeps({ sandbox: failing })

    const result = await runtime.invoke({ id: 'c1', name: 'read', args: { path: '/etc/hosts' } }, {})

    expect(result.ok).toBe(false)
    expect(result.output).toBe('读取失败：读取失败（/etc/hosts）：文件不存在')
    // 失败照样收链（请求 → 结果）——链不断，模型看得到「这一次没成」
    expect(sink.events.map((event) => event.kind)).toEqual(['tool.call', 'tool.result'])
  })

  test('参数错误：缺键 / 非串 / 空串——一律不碰沙箱（键名不被猜中）', async () => {
    const { runtime, sandbox } = makeToolDeps()

    for (const args of [{}, { path: 42 }, { path: '' }, { file: 'a.txt' }]) {
      const result = await runtime.invoke({ id: 'c1', name: 'read', args }, {})
      expect(result.ok).toBe(false)
      expect(result.output).toBe('参数错误：path 须为非空字符串')
    }

    expect(sandbox.reads).toEqual([])
  })

  test('危险归类＝轻（照契约冻结行声明，本域不判）', async () => {
    const { runtime } = makeToolDeps()
    const spec = runtime.definitions().find((definition) => definition.name === 'read')

    expect(spec?.summary).toBe(row('read').summary)
    expect(spec?.danger).toEqual({ level: 'light' })
  })
})

// ══ write ═════════════════════════════════════════════════════════════

describe('U13 · write', () => {
  test('走通：调沙箱 write(path, {text})，回执带字节数（按字节不是字符）', async () => {
    const { runtime, sandbox } = makeToolDeps()

    const result = await runtime.invoke(
      { id: 'c1', name: 'write', args: { path: 'out.txt', content: '内容\n' } },
      {},
    )

    expect(sandbox.writes).toEqual([{ path: 'out.txt', data: { text: '内容\n' } }])
    expect(result.ok).toBe(true)
    expect(result.output).toBe('已写入 out.txt（7 字节）') // 3 + 3 + 1
  })

  test('空串内容合法——写一个空文件（判据是「是不是串」，不是「非空」）', async () => {
    const { runtime, sandbox } = makeToolDeps()

    const result = await runtime.invoke(
      { id: 'c1', name: 'write', args: { path: 'blank.txt', content: '' } },
      {},
    )

    expect(result.ok).toBe(true)
    expect(sandbox.writes).toEqual([{ path: 'blank.txt', data: { text: '' } }])
  })

  test('沙箱失败（如上级目录不存在）→ ok:false ＋ 原委', async () => {
    const failing = {
      ...makeFauxSandbox(),
      write: () => Promise.reject(new Error('写入失败（/w/no-dir/x.txt）：上级目录不存在——先建目录')),
    }
    const { runtime } = makeToolDeps({ sandbox: failing })

    const result = await runtime.invoke(
      { id: 'c1', name: 'write', args: { path: 'no-dir/x.txt', content: 'X' } },
      {},
    )

    expect(result.ok).toBe(false)
    expect(result.output).toContain('写入失败：')
    expect(result.output).toContain('上级目录不存在')
  })

  test('参数错误：path 与 content 各有说法，都不碰沙箱', async () => {
    const { runtime, sandbox } = makeToolDeps()

    const noPath = await runtime.invoke({ id: 'c1', name: 'write', args: { content: 'x' } }, {})
    expect(noPath.output).toBe('参数错误：path 须为非空字符串')

    const noContent = await runtime.invoke(
      { id: 'c2', name: 'write', args: { path: 'a.txt' } },
      {},
    )
    expect(noContent.output).toBe('参数错误：content 须为字符串')

    const badContent = await runtime.invoke(
      { id: 'c3', name: 'write', args: { path: 'a.txt', content: 1 } },
      {},
    )
    expect(badContent.output).toBe('参数错误：content 须为字符串')

    expect(sandbox.writes).toEqual([])
  })

  test('危险归类＝按调用判定（新建＝轻；覆盖＝必闸）——本域只声明，判定归权限域', async () => {
    const { runtime } = makeToolDeps()
    const spec = runtime.definitions().find((definition) => definition.name === 'write')

    expect(spec?.summary).toBe(row('write').summary)
    expect(spec?.danger).toEqual({ level: 'by-call', note: '新建＝轻；覆盖＝必闸' })
  })
})

// ══ edit ══════════════════════════════════════════════════════════════

describe('U13 · edit —— 唯一定位 · 失配即报', () => {
  const ORIGINAL = 'const a = 1\nconst b = 2\nconst c = 3\n'

  test('唯一定位：读 → 改 → 写回，只动那一处', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({ files: { 'a.ts': ORIGINAL } }),
    })

    const result = await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'a.ts', old: 'const b = 2', new: 'const b = 22' } },
      {},
    )

    expect(result.ok).toBe(true)
    expect(result.output).toBe('已替换 1 处（a.ts）')
    expect(sandbox.writes).toEqual([
      { path: 'a.ts', data: { text: 'const a = 1\nconst b = 22\nconst c = 3\n' } },
    ])
  })

  test('失配即报：old 不在文件里 → ok:false，**一个字都不写**', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({ files: { 'a.ts': ORIGINAL } }),
    })

    const result = await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'a.ts', old: 'const z = 9', new: 'x' } },
      {},
    )

    expect(result.ok).toBe(false)
    expect(result.output).toBe('未找到待替换文本——文件未改')
    expect(sandbox.writes).toEqual([])
  })

  test('多处出现 → ok:false（报出几处），**一个字都不写**', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({ files: { 'a.ts': 'const a = 1\nconst a = 1\nconst a = 1\n' } }),
    })

    const result = await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'a.ts', old: 'const a = 1', new: 'const a = 2' } },
      {},
    )

    expect(result.ok).toBe(false)
    expect(result.output).toBe('待替换文本出现多处——无法唯一定位，文件未改（出现 3 处）')
    expect(sandbox.writes).toEqual([])
  })

  test('文件超长（读到的只是前一段）→ **拒绝编辑**（否则写回即抹掉尾巴）', async () => {
    const truncated = {
      ...makeFauxSandbox(),
      read: () => Promise.resolve({ content: 'const a = 1\n', truncated: true }),
    }
    const { runtime, sandbox } = makeToolDeps({ sandbox: truncated })

    const result = await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'huge.ts', old: 'const a = 1', new: 'const a = 2' } },
      {},
    )

    expect(result.ok).toBe(false)
    expect(result.output).toBe('文件超长（读取被截断）——不做编辑，以免写回截断内容')
    expect(sandbox.writes).toEqual([])
  })

  test('替换串里的 $& / $\' 是字面量，不是替换模式（`String.replace` 的坑）', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({ files: { 'a.ts': 'const a = 1\n' } }),
    })

    await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'a.ts', old: '1', new: '$&$&' } },
      {},
    )

    expect(sandbox.writes).toEqual([{ path: 'a.ts', data: { text: 'const a = $&$&\n' } }])
  })

  test('new 为空串＝删除该段（合法）', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({ files: { 'a.ts': 'keep\n删掉这行\nkeep\n' } }),
    })

    const result = await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'a.ts', old: '删掉这行\n', new: '' } },
      {},
    )

    expect(result.ok).toBe(true)
    expect(sandbox.writes).toEqual([{ path: 'a.ts', data: { text: 'keep\nkeep\n' } }])
  })

  test('old 与 new 相同 → 无可改，不写一遍骗一次「已替换」', async () => {
    const { runtime, sandbox } = makeToolDeps({
      sandbox: makeFauxSandbox({ files: { 'a.ts': ORIGINAL } }),
    })

    const result = await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'a.ts', old: 'const a = 1', new: 'const a = 1' } },
      {},
    )

    expect(result.ok).toBe(false)
    expect(result.output).toBe('old 与 new 相同——无需修改')
    expect(sandbox.writes).toEqual([])
  })

  test('读不成（沙箱抛）→ ok:false ＋ 编辑失败的名分', async () => {
    const failing = {
      ...makeFauxSandbox(),
      read: () => Promise.reject(new Error('读取失败（a.ts）：文件不存在')),
    }
    const { runtime } = makeToolDeps({ sandbox: failing })

    const result = await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'a.ts', old: 'x', new: 'y' } },
      {},
    )

    expect(result.ok).toBe(false)
    expect(result.output).toBe('编辑失败：读取失败（a.ts）：文件不存在')
  })

  test('参数错误：old 空串 / new 非串，各有说法且不碰沙箱', async () => {
    const { runtime, sandbox } = makeToolDeps()

    const noOld = await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'a.ts', old: '', new: 'y' } },
      {},
    )
    expect(noOld.output).toBe('参数错误：old 须为非空字符串')

    const noNew = await runtime.invoke(
      { id: 'c2', name: 'edit', args: { path: 'a.ts', old: 'x' } },
      {},
    )
    expect(noNew.output).toBe('参数错误：new 须为字符串')

    expect(sandbox.reads).toEqual([])
    expect(sandbox.writes).toEqual([])
  })

  test('危险归类＝轻（diff 可审）', async () => {
    const { runtime } = makeToolDeps()
    const spec = runtime.definitions().find((definition) => definition.name === 'edit')

    expect(spec?.summary).toBe(row('edit').summary)
    expect(spec?.danger).toEqual({ level: 'light' })
  })

  test('大文件不因阈值而分叉：写回走沙箱，与转存阈值无关', async () => {
    const big = `head\n${'x'.repeat(BLOB_THRESHOLD_BYTES)}\ntail\n`
    const { runtime, sandbox } = makeToolDeps({ sandbox: makeFauxSandbox({ files: { 'big.txt': big } }) })

    const result = await runtime.invoke(
      { id: 'c1', name: 'edit', args: { path: 'big.txt', old: 'tail', new: 'TAIL' } },
      {},
    )

    expect(result.ok).toBe(true)
    const written = sandbox.writes[0]?.data
    expect(written !== undefined && 'text' in written && written.text.endsWith('TAIL\n')).toBe(true)
  })
})
