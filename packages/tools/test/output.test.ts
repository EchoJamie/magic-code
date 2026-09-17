/**
 * U06 · 输出面 —— 流式 · 上限 · 大块转存 · 失败形态。
 *
 * 判据（任务书 · 退出条件）——
 * - **流式**：沙箱 `opts.onOutput` 的增量转 `tool.output.delta` 事件（**不落库**）；
 *   终值进 `tool.result`；
 * - **大块转存**：超阈值的输出经记录域转存 blob，**事件只留引用**；
 * - **超时 / 输出上限为常量**（超限截断）——常量由本域显式交沙箱，不吃沙箱实现的缺省。
 *
 * 文本形态是**实现级自选**（技术方案只定到「超限截断」「大块转存归调用方」）——故用例钉死
 * 本实现选定的形态，谁改谁红。三条：
 * - 命令跑了 → 输出＝正文 ＋（stderr 块）＋（截断块）＋（`[exit N]`，仅非 0）；
 * - 沙箱级失败 → 输出＝`exec 未能执行（reason）：message`；
 * - 转存／执行异常 → 回落内联 / 以失败回填，**不丢结果、不炸调用**。
 */

import { describe, expect, test } from 'bun:test'
import type { BlobStore } from '@magic/contracts'
import { EXEC_MAX_OUTPUT_BYTES, EXEC_TIMEOUT_MS } from '../src/exec-tool.ts'
import { BLOB_THRESHOLD_BYTES } from '../src/blobs.ts'
import { collector, execCall, makeToolDeps } from './helpers.ts'

describe('U06 · 流式与终值', () => {
  test('沙箱 onOutput 的增量转 tool.output.delta——逐条带链引用；终值进 tool.result', async () => {
    const seen = collector()
    const deps = makeToolDeps({
      exec: (_cmd, opts) => {
        opts.onOutput?.({ channel: 'stdout', text: 'A' })
        opts.onOutput?.({ channel: 'stderr', text: 'E' })
        opts.onOutput?.({ channel: 'stdout', text: 'B' })
        return { ok: true, exit: 0, stdout: 'AB', stderr: 'E' }
      },
    })

    const outcome = await deps.runtime.invoke(execCall('x'), { onOutput: seen.push })

    // 本域产出——增量转成事件（不落库的 kind）
    const deltas = deps.sink.byKind('tool.output.delta')
    expect(deltas.map((e) => ({ channel: e.data.channel, text: e.data.text }))).toEqual([
      { channel: 'stdout', text: 'A' },
      { channel: 'stderr', text: 'E' },
      { channel: 'stdout', text: 'B' },
    ])
    // 增量与终值同源：**每道流各自**拼起来＝该流的终值（U05 已由沙箱保证，
    // 这里钉「转事件时没走样」——按通道拼，不跨流混拼：两道流本就交错）
    const joined = (channel: string): string =>
      deltas
        .filter((e) => e.data.channel === channel)
        .map((e) => e.data.text)
        .join('')
    expect(joined('stdout')).toBe('AB')
    expect(joined('stderr')).toBe('E')
    // 每条都挂同一个链引用——渲染侧据以按调用分组
    expect(new Set(deltas.map((e) => e.data.call))).toEqual(new Set([outcome.callRef]))

    // 端口面的 onOutput 也拿到同一序列（调用方不必订阅扇出）
    expect(seen.deltas.map((d) => d.text)).toEqual(['A', 'E', 'B'])

    // 终值进 tool.result——只此一处，不在事件里重复
    expect(outcome.output).toBe('AB\n[stderr]\nE')
    expect(deps.sink.byKind('tool.result')[0]?.data.output).toEqual({ text: outcome.output })
  })

  test('超时 / 输出上限为常量——每次都显式交沙箱（不吃实现缺省）', async () => {
    const deps = makeToolDeps()

    await deps.runtime.invoke(execCall('ls'), {})

    expect(deps.sandbox.execs[0]?.opts.timeoutMs).toBe(EXEC_TIMEOUT_MS)
    expect(deps.sandbox.execs[0]?.opts.maxOutputBytes).toBe(EXEC_MAX_OUTPUT_BYTES)
  })

  test('截断 → 终值带截断标记（沙箱截到上限；本域照实转述，不假装完整）', async () => {
    const deps = makeToolDeps({
      exec: { x: { ok: true, exit: 0, stdout: 'AAAA', stderr: '', truncated: true } },
    })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.ok).toBe(true)
    expect(outcome.output).toBe(`AAAA\n[输出已截断（上限 ${EXEC_MAX_OUTPUT_BYTES} 字节）]`)
  })

  test('命令失败（exit 非 0）→ ok:false ＋ `[exit N]`——命令失败不是沙箱失败，但都是失败', async () => {
    const deps = makeToolDeps({ exec: { x: { ok: true, exit: 3, stdout: '', stderr: '' } } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('[exit 3]')
    expect(deps.sink.byKind('tool.result')[0]?.data.ok).toBe(false)
    // 命令跑了（不是沙箱级失败）——沙箱那一侧照旧是 ok:true
    expect(deps.sandbox.execs).toHaveLength(1)
  })

  test('成功命令的两道流各归各位（stderr 不混进正文）', async () => {
    const deps = makeToolDeps({
      exec: { x: { ok: true, exit: 0, stdout: 'out\n', stderr: 'err\n' } },
    })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.output).toBe('out\n\n[stderr]\nerr\n')
  })
})

describe('U06 · 沙箱级失败（错误＝返回值）', () => {
  test('超时 → ok:false，归在返回值里、不抛', async () => {
    const deps = makeToolDeps({
      exec: { x: { ok: false, reason: 'timeout', message: '命令超时（120000ms）未完成——已终止' } },
    })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('exec 未能执行（timeout）：命令超时（120000ms）未完成——已终止')
    expect(deps.sink.byKind('tool.result')[0]?.data.ok).toBe(false)
  })

  test('cwd 越界 / 启动失败 → 同样归返回值，reason 原样带出', async () => {
    for (const reason of ['out-of-bounds', 'spawn'] as const) {
      const deps = makeToolDeps({
        exec: { x: { ok: false, reason, message: `沙箱侧报文（${reason}）` } },
      })

      const outcome = await deps.runtime.invoke(execCall('x'), {})

      expect(outcome.ok).toBe(false)
      expect(outcome.output).toBe(`exec 未能执行（${reason}）：沙箱侧报文（${reason}）`)
    }
  })
})

describe('U06 · 大块转存（写权唯一归记录域）', () => {
  test('超阈值 → 经记录域转存 blob，事件只留引用；面向模型的文本仍是全文', async () => {
    const big = 'A'.repeat(BLOB_THRESHOLD_BYTES + 1)
    const deps = makeToolDeps({ exec: { x: { ok: true, exit: 0, stdout: big, stderr: '' } } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    // 转存确实经记录域的公开面
    expect(deps.records.blobRefs).toHaveLength(1)
    const ref = deps.records.blobRefs[0]
    if (ref === undefined) throw new Error('应已转存一个 blob')

    // 事件只留引用
    expect(deps.sink.byKind('tool.result')[0]?.data.output).toEqual({ blob: ref })
    expect(outcome.content).toEqual({ blob: ref })

    // 面向模型的文本照旧是全文——转存改的是「记录怎么存」，不是「模型看见什么」
    expect(outcome.output).toBe(big)

    // 存进去的确实是全文（逐字节）
    expect(new TextDecoder().decode(await deps.records.blobs.get(ref))).toBe(big)
  })

  test('阈值内 → 内联；恰好等于阈值不算超（判据取「大于」）', async () => {
    const exact = 'A'.repeat(BLOB_THRESHOLD_BYTES)
    const deps = makeToolDeps({ exec: { x: { ok: true, exit: 0, stdout: exact, stderr: '' } } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(deps.records.blobRefs).toHaveLength(0)
    expect(outcome.content).toEqual({ text: exact })
    expect(deps.sink.byKind('tool.result')[0]?.data.output).toEqual({ text: exact })
  })

  test('阈值按**字节**计（多字节字符不按字符数蒙混过关）', async () => {
    // 每个「中」字 3 字节 —— 字符数在阈值内、字节数已超
    const text = '中'.repeat(Math.floor(BLOB_THRESHOLD_BYTES / 3) + 1)
    const deps = makeToolDeps({ exec: { x: { ok: true, exit: 0, stdout: text, stderr: '' } } })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(text.length).toBeLessThanOrEqual(BLOB_THRESHOLD_BYTES)
    expect(deps.records.blobRefs).toHaveLength(1)
    const ref = deps.records.blobRefs[0]
    if (ref === undefined) throw new Error('应已转存一个 blob')
    expect(outcome.content).toEqual({ blob: ref })
  })

  test('转存失败 → 回落内联——不丢结果、不炸调用（数据在，只是这一笔记大了）', async () => {
    const big = 'A'.repeat(BLOB_THRESHOLD_BYTES + 1)
    const failing: BlobStore = {
      put: () => Promise.reject(new Error('盘满了')),
      get: () => Promise.resolve(new Uint8Array()),
    }
    const deps = makeToolDeps({ exec: { x: { ok: true, exit: 0, stdout: big, stderr: '' } }, blobs: failing })

    const outcome = await deps.runtime.invoke(execCall('x'), {})

    expect(outcome.ok).toBe(true)
    expect(outcome.output).toBe(big)
    expect(outcome.content).toEqual({ text: big })
    expect(deps.sink.byKind('tool.result')[0]?.data.output).toEqual({ text: big })
  })
})
