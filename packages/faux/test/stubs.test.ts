/**
 * 端口轻桩 —— **最小可用 ＋ 可观察**（任务书：让各域测试不必各写一份）。
 *
 * 桩的两条底线：
 * ① **满足端口签名**（域代码拿去即用，不必改类型）；
 * ② **行为别发明**——只在真实现会记账 / 会流转的地方记账、流转（写后能读、问了能答）；
 *    其余一律最简（读不到＝空、没配＝默认）。
 *
 * 观察面（`calls` / `entries` / `requests`…）是桩的**主要价值**——测试靠它断言
 * 「谁在什么时候做了什么」，不必再造一层 spy。
 */

import { describe, expect, test } from 'bun:test'
import type {
  EventSink,
  KernelEvent,
  PermissionGate,
  RecordsService,
  Sandbox,
  ToolCall,
  ToolRuntime,
  ToolSpec,
} from '@magic/contracts'
import {
  makeFauxPermissionGate,
  makeFauxRecords,
  makeFauxSandbox,
  makeFauxSink,
  makeFauxToolRuntime,
  makeTestStamper,
} from '../src/index.ts'

/** 一个合法的工具调用——桩大多不关心内容，给个可读的。 */
const CALL: ToolCall = { id: 'call_1', name: 'exec', args: { cmd: 'ls' } }

// ═══════════════════════════════════════════════════════════════════════
// 记录域
// ═══════════════════════════════════════════════════════════════════════

describe('makeFauxRecords', () => {
  test('满足 `RecordsService` 签名——可直接当端口用', () => {
    const records: RecordsService = makeFauxRecords()

    expect(typeof records.nextId).toBe('function')
    expect(typeof records.blobs.put).toBe('function')
  })

  test('nextId 单调——条目与事件**共用 id 空间**（真实现的口径）', () => {
    const records = makeFauxRecords()

    expect([records.nextId(), records.nextId(), records.nextId()]).toEqual([1, 2, 3])
  })

  test('appendEntry 分配 id 并留痕——回读时按写入序', async () => {
    const records = makeFauxRecords()

    const id = records.appendEntry({
      kind: 'user',
      content: { text: '你好' },
      at: 1_000,
    })

    expect(id).toBe(1)
    expect(records.entries.map((e) => e.id)).toEqual([1])

    const read: string[] = []
    for await (const entry of records.readEntries('s1')) {
      read.push('text' in entry.content ? entry.content.text : '')
    }
    expect(read).toEqual(['你好'])
  })

  test('readEntries 按 range 过滤——含端点（桩的口径：闭区间）', async () => {
    const records = makeFauxRecords()
    for (const text of ['一', '二', '三', '四']) {
      records.appendEntry({ kind: 'user', content: { text }, at: 0 })
    }

    const read: number[] = []
    for await (const entry of records.readEntries('s1', { from: 2, to: 3 })) read.push(entry.id)

    expect(read).toEqual([2, 3])
  })

  test('事件留痕 —— appendEvent 收整条（信封自带 session）', async () => {
    const records = makeFauxRecords()
    const stamper = makeTestStamper({ session: 's1' })

    records.appendEvent(stamper.stamp('turn.start', {}))

    const read: KernelEvent[] = []
    for await (const event of records.readEvents('s1')) read.push(event)
    expect(read.map((e) => e.kind)).toEqual(['turn.start'])
  })

  test('readEvents 按会话分束——别家的会话取不到', async () => {
    const records = makeFauxRecords()
    records.appendEvent(makeTestStamper({ session: 's1' }).stamp('turn.start', {}))
    records.appendEvent(makeTestStamper({ session: 's2' }).stamp('agent.start', {}))

    const read: KernelEvent[] = []
    for await (const event of records.readEvents('s1')) read.push(event)

    expect(read.map((e) => e.session)).toEqual(['s1'])
  })

  test('blobs 存取——写权唯一归记录域（引用不透明、内容原样回来）', async () => {
    const records = makeFauxRecords()

    const ref = await records.blobs.put('大块内容')
    const back = await records.blobs.get(ref)

    expect(new TextDecoder().decode(back)).toBe('大块内容')
    expect(records.blobRefs).toEqual([ref])
  })

  test('listSessions 可注入——多会话列表（U02 到站后换真实现）', async () => {
    const records = makeFauxRecords({
      sessions: [{ id: 's1', title: '首会话', at: 1_000 }],
    })

    expect(await records.listSessions()).toEqual([{ id: 's1', title: '首会话', at: 1_000 }])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 执行域（沙箱）
// ═══════════════════════════════════════════════════════════════════════

describe('makeFauxSandbox', () => {
  test('满足 `Sandbox` 签名——可直接当端口用', () => {
    const sandbox: Sandbox = makeFauxSandbox()

    expect(typeof sandbox.exec).toBe('function')
  })

  test('exec 缺省成功空输出——并记下每次调用（命令 ＋ 选项）', async () => {
    const sandbox = makeFauxSandbox()

    const result = await sandbox.exec('ls -la', { cwd: '/w' })

    expect(result).toEqual({ ok: true, exit: 0, stdout: '', stderr: '' })
    expect(sandbox.execs).toEqual([{ cmd: 'ls -la', opts: { cwd: '/w' } }])
  })

  test('exec 可按命令编程——一命令一响应（成功 / 失败三例各归 reason）', async () => {
    const sandbox = makeFauxSandbox({
      exec: {
        'ls': { ok: true, exit: 0, stdout: 'a.txt\n', stderr: '' },
        // 超时那一支**带上已产出的输出**（U69）——桩照契约的形态给，不给旧形那一份
        boom: { ok: false, reason: 'timeout', message: '超时', timeoutMs: 300, stdout: '半截', stderr: '' },
      },
    })

    expect(await sandbox.exec('ls', {})).toMatchObject({ stdout: 'a.txt\n' })
    expect(await sandbox.exec('boom', {})).toEqual({
      ok: false,
      reason: 'timeout',
      message: '超时',
      timeoutMs: 300,
      stdout: '半截',
      stderr: '',
    })
  })

  test('exec 未编的命令 → 缺省成功（空输出）——不猜、不拦', async () => {
    const sandbox = makeFauxSandbox({ exec: { ls: { ok: true, exit: 0, stdout: 'x', stderr: '' } } })

    expect(await sandbox.exec('没编过', {})).toEqual({ ok: true, exit: 0, stdout: '', stderr: '' })
  })

  test('exec 可给函数——按调用算（要看命令参数分派的用例）', async () => {
    const sandbox = makeFauxSandbox({
      exec: (cmd) => ({ ok: true, exit: cmd === 'true' ? 0 : 1, stdout: cmd, stderr: '' }),
    })

    expect(await sandbox.exec('false', {})).toMatchObject({ exit: 1, stdout: 'false' })
  })

  test('exec 支持流式回调——onOutput 逐段吐（转 `tool.output.delta` 的源头）', async () => {
    const sandbox = makeFauxSandbox({
      exec: (_cmd, opts) => {
        opts.onOutput?.({ channel: 'stdout', text: '第一段' })
        opts.onOutput?.({ channel: 'stdout', text: '第二段' })
        return { ok: true, exit: 0, stdout: '第一段第二段', stderr: '' }
      },
    })

    const chunks: string[] = []
    await sandbox.exec('x', { onOutput: (d) => chunks.push(d.text) })

    expect(chunks).toEqual(['第一段', '第二段'])
  })

  test('read 取预置内容——未预置＝空串（不报错）', async () => {
    const sandbox = makeFauxSandbox({ files: { '/w/a.txt': '内容' } })

    expect(await sandbox.read('/w/a.txt')).toEqual({ content: '内容' })
    expect(await sandbox.read('/w/没有.txt')).toEqual({ content: '' })
  })

  test('read 的 `opts` 记账——省与不省**都原样记**（`edit` 有没有放大上限看这里）', async () => {
    const sandbox = makeFauxSandbox({ files: { '/w/a.txt': '内容' } })

    await sandbox.read('/w/a.txt')
    await sandbox.read('/w/a.txt', { maxBytes: 1024 * 1024 })

    expect(sandbox.reads).toEqual([
      { path: '/w/a.txt', opts: undefined }, // 没给就是 `undefined`——不替调用方补缺省值
      { path: '/w/a.txt', opts: { maxBytes: 1024 * 1024 } },
    ])
  })

  test('write 后能读回来——写作即生效（沙箱该有的行为）', async () => {
    const sandbox = makeFauxSandbox()

    await sandbox.write('/w/new.txt', { text: '新内容' })

    expect(await sandbox.read('/w/new.txt')).toEqual({ content: '新内容' })
    expect(sandbox.writes).toHaveLength(1)
  })

  test('write 的**字节支**同样落地——两选一都能读回来（文本按 UTF-8 解）', async () => {
    const sandbox = makeFauxSandbox()

    await sandbox.write('/w/bin.txt', { bytes: new TextEncoder().encode('字节也写') })

    expect(await sandbox.read('/w/bin.txt')).toEqual({ content: '字节也写' })
    expect(sandbox.writes).toEqual([
      { path: '/w/bin.txt', data: { bytes: new Uint8Array([0xe5, 0xad, 0x97, 0xe8, 0x8a, 0x82, 0xe4, 0xb9, 0x9f, 0xe5, 0x86, 0x99]) } },
    ])
  })

  test('list 取预置目录——未预置＝空', async () => {
    const sandbox = makeFauxSandbox({ dirs: { '/w': [{ name: 'a.txt' }, { name: 'b' }] } })

    expect(await sandbox.list('/w')).toEqual([{ name: 'a.txt' }, { name: 'b' }])
    expect(await sandbox.list('/空')).toEqual([])
  })

  test('match 返回预置命中——并记下模式与选项（grep / glob 共用底）', async () => {
    const sandbox = makeFauxSandbox({ hits: [{ path: '/w/a.txt' }] })

    expect(await sandbox.match('内容', { mode: 'glob' })).toEqual([{ path: '/w/a.txt' }])
    expect(sandbox.matches).toEqual([{ pattern: '内容', opts: { mode: 'glob' } }])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 工具域
// ═══════════════════════════════════════════════════════════════════════

const EXEC_SPEC: ToolSpec = {
  name: 'exec',
  summary: '命令执行',
  parameters: {},
  danger: { level: 'by-call', note: '按命令解析' },
}

describe('makeFauxToolRuntime', () => {
  test('满足 `ToolRuntime` 签名——可直接当端口用', () => {
    const tools: ToolRuntime = makeFauxToolRuntime()

    expect(tools.definitions()).toEqual([])
  })

  test('definitions 出注册的工具规格——模型请求里要带上', () => {
    const tools = makeFauxToolRuntime({ definitions: [EXEC_SPEC] })

    expect(tools.definitions()).toEqual([EXEC_SPEC])
  })

  test('invoke 走注册的处理器——按工具名分派', async () => {
    const tools = makeFauxToolRuntime({
      definitions: [EXEC_SPEC],
      handlers: { exec: (call) => ({ ok: true, output: `跑了 ${String(call.args.cmd)}` }) },
    })

    const result = await tools.invoke(CALL, {})

    // `content`（记录侧内联）与 `callRef`（链引用）由桩补——handler 只管 ok / output
    expect(result).toEqual({
      ok: true,
      output: '跑了 ls',
      content: { text: '跑了 ls' },
      callRef: 1,
    })
    expect(tools.calls.map((c) => c.name)).toEqual(['exec'])
  })

  test('未注册的工具 → 失败结果（不抛）——回填「没这工具」比炸掉强', async () => {
    const tools = makeFauxToolRuntime({ definitions: [EXEC_SPEC] })

    const result = await tools.invoke({ id: 'c', name: '没有的', args: {} }, {})

    expect(result.ok).toBe(false)
    expect(result.output).toContain('没有的')
  })

  test('处理器可用 onOutput 流式回吐——经 opts 透传', async () => {
    const tools = makeFauxToolRuntime({
      handlers: {
        exec: (_call, opts) => {
          opts.onOutput?.({ channel: 'stdout', text: '半截' })
          return { ok: true, output: '半截' }
        },
      },
    })

    const chunks: string[] = []
    await tools.invoke(CALL, { onOutput: (d) => chunks.push(d.text) })

    expect(chunks).toEqual(['半截'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 权限域
// ═══════════════════════════════════════════════════════════════════════

/** 权限上下文——纯数据（根视图由调用方给，不传端口进端口）。 */
const CTX = { roots: ['/w'], declaredRoots: ['/w'], defaultRoot: '/w' }

/** 链引用——该次 `tool.call` 事件的 id（真装配里由工具域发；测试里给个可读的常量）。 */
const CALL_REF = 42

describe('makeFauxPermissionGate', () => {
  test('满足 `PermissionGate` 签名——可直接当端口用', () => {
    const gate: PermissionGate = makeFauxPermissionGate()

    expect(typeof gate.decide).toBe('function')
  })

  test('自动模式——立即答复（循环测试的便捷路径）', async () => {
    const gate = makeFauxPermissionGate({ auto: 'approve' })

    expect(await gate.decide(CALL, CTX, CALL_REF)).toBe('approve')
    expect(gate.requests.map((r) => r.call.name)).toEqual(['exec'])
  })

  test('人工模式——decide 挂起，直到 resolve 按请求 id 答复（**配对回路**）', async () => {
    const gate = makeFauxPermissionGate()
    let answered: string | undefined

    const pending = gate.decide(CALL, CTX, CALL_REF).then((d) => {
      answered = d
      return d
    })

    // 还没答复——挂起中
    await Promise.resolve()
    expect(answered).toBeUndefined()
    expect(gate.pending).toHaveLength(1)

    const requestId = gate.pending[0]
    if (requestId === undefined) throw new Error('没有在途询问')
    gate.resolve(requestId, 'reject')

    expect(await pending).toBe('reject')
    expect(answered).toBe('reject')
  })

  test('resolve 陌生 id → 静默忽略（迟到的答复不该炸掉循环）', () => {
    const gate = makeFauxPermissionGate()

    expect(() => gate.resolve(999, 'approve')).not.toThrow()
  })

  test('「总是允许」位**原样留痕**——给了就在、没给就不在（桩不替它记忆）', async () => {
    const gate = makeFauxPermissionGate()

    const first = gate.decide(CALL, CTX, CALL_REF)
    const firstId = gate.pending[0]
    if (firstId === undefined) throw new Error('没有在途询问')
    gate.resolve(firstId, 'approve', { remember: true })
    await first

    const second = gate.decide(CALL, CTX, CALL_REF)
    const secondId = gate.pending[0]
    if (secondId === undefined) throw new Error('没有在途询问')
    gate.resolve(secondId, 'approve') // 不给＝一次性
    await second

    expect(gate.answers).toEqual([
      { id: firstId, decision: 'approve', remember: true },
      // 键**不出现**——没给这一位（与线上消息同形；不是 `remember: false`）
      { id: secondId, decision: 'approve' },
    ])
    expect('remember' in (gate.answers[1] ?? {})).toBe(false)
  })

  test('裁决可逐个编程——按调用给不同答复（同轮多工具次序）', async () => {
    const gate = makeFauxPermissionGate({
      auto: (call) => (call.name === 'read' ? 'approve' : 'reject'),
    })

    expect(await gate.decide({ id: 'a', name: 'read', args: {} }, CTX, 1)).toBe('approve')
    expect(await gate.decide({ id: 'b', name: 'exec', args: {} }, CTX, 2)).toBe('reject')
  })

  test('链引用留痕——「请求 → 询问 → 裁决 → 结果」串链的依据可查', async () => {
    const gate = makeFauxPermissionGate({ auto: 'approve' })

    await gate.decide(CALL, CTX, 7)
    await gate.decide(CALL, CTX, 9)

    expect(gate.requests.map((r) => r.callRef)).toEqual([7, 9])
    expect(gate.requests.map((r) => r.ctx)).toEqual([CTX, CTX])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 端口形参面（防漏参的第二道）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 契约端口是硬约束（`tsc` 守）；这一节把**形参个数**也钉进 `bun test`——
 * 集成时栽过一次：`PermissionGate.decide` 补第三参（链引用必填），桩漏了，
 * 合并门当场拦下。类型层已经拦住，此处让**单跑测试**（watch / 只跑 `bun test`）
 * 也能现形——漏参不只是编译期的事。
 */
describe('端口形参面', () => {
  test('各桩的形参与契约端口同形——增删必填参数即红', () => {
    expect(makeFauxPermissionGate().decide.length).toBe(3) // call · ctx · callRef
    expect(makeFauxPermissionGate().resolve.length).toBe(3) // requestId · decision · opts?
    expect(makeFauxSandbox().read.length).toBe(2) // path · opts?（第 15 轮：`edit` 放大上限的口子）
    expect(makeFauxRecords().appendEntry.length).toBe(1) // entry
    expect(makeFauxRecords().readEntries.length).toBe(2) // sessionId · range?
    expect(makeFauxSandbox().exec.length).toBe(2) // cmd · opts
    expect(makeFauxToolRuntime().invoke.length).toBe(2) // call · opts
    expect(makeFauxSink().emit.length).toBe(1) // event
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 事件扇出
// ═══════════════════════════════════════════════════════════════════════

describe('makeFauxSink', () => {
  test('满足 `EventSink` 签名——可直接当端口用', () => {
    const sink: EventSink = makeFauxSink()

    expect(typeof sink.emit).toBe('function')
  })

  test('emit 留痕——按发出序（断言「谁在什么时候发了什么」）', () => {
    const sink = makeFauxSink()
    const stamper = makeTestStamper()

    sink.emit(stamper.stamp('agent.start', {}))
    sink.emit(stamper.stamp('turn.start', {}))

    expect(sink.events.map((e) => e.kind)).toEqual(['agent.start', 'turn.start'])
  })

  test('byKind 取子集——按 kind 收窄（消费侧惯用姿势）', () => {
    const sink = makeFauxSink()
    const stamper = makeTestStamper()

    sink.emit(stamper.stamp('turn.start', {}))
    sink.emit(stamper.stamp('turn.end', { reason: 'settled' }))
    sink.emit(stamper.stamp('turn.start', {}))

    const starts = sink.byKind('turn.start')
    expect(starts).toHaveLength(2)
    expect(starts[0]?.data).toEqual({})
  })
})
