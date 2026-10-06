import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundFinish, EventKind, KernelEvent, ToolCall } from '@magic/contracts'
import { createBackgroundRuns, createSandbox, createWorkspaceService } from '@magic/execution'
import { createGrantLedger, createPermissionGate } from '@magic/permission'
import { makeFauxRecords, makeFauxSink, makeTestStamper } from '@magic/faux'
import { createToolRuntime } from '@magic/tools'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture(allowAll = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'magic-one-gate-')))
  temporary.push(home)
  const root = join(home, 'workspace')
  const outside = join(home, 'outside')
  mkdirSync(root); mkdirSync(outside)
  const workspace = createWorkspaceService({ roots: [root] })
  const sink = makeFauxSink(), stamper = makeTestStamper({ session: 'permission-test' })
  const h = {
    sink, stamper,
    eventsOf: <K extends EventKind>(kind: K) => sink.events.filter((event): event is Extract<KernelEvent, { kind: K }> => event.kind === kind),
    countOf: (kind: EventKind) => sink.events.filter((event) => event.kind === kind).length,
  }
  const grants = createGrantLedger({ workspace: root })
  const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants, allowAll })
  const sandbox = createSandbox({ workspace })
  const background = createBackgroundRuns({ dir: join(home, 'output'), workspace })
  const finished: BackgroundFinish[] = []
  const runtime = createToolRuntime({
    workspace, sandbox, gate, sink: h.sink, stamper: h.stamper, blobs: makeFauxRecords().blobs, trashAvailable: false,
    background: { ...background, start: (cmd, opts) => background.start(cmd, { ...opts, onFinish: (finish) => finished.push(finish) }) },
  })
  const request = async (index = 0) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = h.eventsOf('tool.decision.request')[index]
      if (found !== undefined) return found
      await Bun.sleep(1)
    }
    throw new Error('等不到权限请求')
  }
  return { root, outside, h, grants, gate, runtime, request, finished, background }
}
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: 'test-call', name, args })

describe('真实权限 → 工具 → 文件执行：一次决断', () => {
  test('根内读取自动裁决一次；根外批准后读取，拒绝不读，一次批准不记宽授权', async () => {
    const f = fixture()
    writeFileSync(join(f.root, 'inside'), 'inside')
    const path = join(f.outside, 'a')
    writeFileSync(path, 'outside')
    expect((await f.runtime.invoke(call('read', { path: 'inside' }), {})).output).toBe('inside')
    const first = f.runtime.invoke(call('read', { path }), {})
    const req = await f.request()
    expect(req.data.material).toContain(path)
    expect(req.data.material).toContain('只读该文件')
    expect(f.h.countOf('tool.result')).toBe(1)
    f.gate.resolve(req.id, 'approve', { remember: true })
    expect((await first).output).toBe('outside')
    expect(f.grants.rules()).toHaveLength(0)
    const again = f.runtime.invoke(call('read', { path }), {})
    f.gate.resolve((await f.request(1)).id, 'reject')
    expect((await again).ok).toBe(false)
    expect(f.h.countOf('tool.decision')).toBe(3)
  })

  test.each(['write', 'edit'])('%s 根外批准后真实写入；拒绝保持文件内容', async (name) => {
    const f = fixture()
    const path = join(f.outside, 'a')
    writeFileSync(path, 'before')
    const args = name === 'write' ? { path, content: 'after' } : { path, old: 'before', new: 'after' }
    const run = f.runtime.invoke(call(name, args), {})
    const req = await f.request()
    expect(readFileSync(path, 'utf8')).toBe('before')
    f.gate.resolve(req.id, 'approve')
    expect((await run).ok).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('after')
    const rejected = f.runtime.invoke(call('write', { path, content: 'bad' }), {})
    f.gate.resolve((await f.request(1)).id, 'reject')
    expect((await rejected).ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('after')
    expect(f.h.countOf('tool.decision')).toBe(2)
  })

  test.each(['ls', 'grep', 'glob'])('%s 根外目录先问一次，批准后原搜索继续且不跟子链接', async (name) => {
    const f = fixture()
    writeFileSync(join(f.outside, 'a.txt'), 'needle')
    symlinkSync(f.root, join(f.outside, 'link'))
    writeFileSync(join(f.root, 'secret.txt'), 'needle-secret')
    const run = f.runtime.invoke(call(name, { path: f.outside, pattern: name === 'glob' ? '**/*.txt' : 'needle' }), {})
    f.gate.resolve((await f.request()).id, 'approve')
    const result = await run
    expect(result.ok).toBe(true)
    expect(result.output).toContain('a.txt')
    expect(result.output).not.toContain('secret.txt')
    expect(f.h.countOf('tool.decision')).toBe(1)
  })

  test('根外 cwd 只问一次，批准后命令从所批目录启动', async () => {
    const f = fixture()
    const run = f.runtime.invoke(call('exec', { cwd: f.outside, cmd: 'pwd' }), {})
    expect((await f.request()).data.material).toContain(f.outside)
    f.gate.resolve((await f.request()).id, 'approve')
    expect((await run).output.trim()).toBe(f.outside)
    expect(f.h.countOf('tool.decision')).toBe(1)
  })

  test('后台 cwd 也只裁决一次，批准后实际运行；换目标或拒绝都不启动', async () => {
    const f = fixture()
    const run = f.runtime.invoke(call('exec', { cwd: f.outside, cmd: 'pwd', background: true }), {})
    f.gate.resolve((await f.request()).id, 'approve')
    expect((await run).ok).toBe(true)
    for (let attempt = 0; attempt < 100 && f.finished.length === 0; attempt += 1) await Bun.sleep(5)
    expect(f.finished).toHaveLength(1)
    expect(readFileSync(f.finished[0]!.outputPath, 'utf8').trim()).toBe(f.outside)
    const changed = f.runtime.invoke(call('exec', { cwd: f.outside, cmd: 'printf bad > marker', background: true }), {})
    const req = await f.request(1)
    renameSync(f.outside, `${f.outside}-old`); symlinkSync(f.root, f.outside)
    f.gate.resolve(req.id, 'approve')
    expect((await changed).ok).toBe(false)
    expect(f.background.running()).toHaveLength(0)
    expect(() => readFileSync(join(f.root, 'marker'))).toThrow()
    expect(f.h.countOf('tool.decision')).toBe(2)
  })

  test('一次只读批准不覆盖相邻文件或同路径写入', async () => {
    const f = fixture()
    const path = join(f.outside, 'a'), sibling = join(f.outside, 'b')
    writeFileSync(path, 'a'); writeFileSync(sibling, 'b')
    const read = f.runtime.invoke(call('read', { path }), {})
    f.gate.resolve((await f.request()).id, 'approve')
    expect((await read).output).toBe('a')
    const next = f.runtime.invoke(call('read', { path: sibling }), {})
    f.gate.resolve((await f.request(1)).id, 'reject')
    expect((await next).ok).toBe(false)
    const write = f.runtime.invoke(call('write', { path, content: 'bad' }), {})
    f.gate.resolve((await f.request(2)).id, 'reject')
    expect((await write).ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('a')
    expect(f.h.countOf('tool.decision')).toBe(3)
  })

  test('根内链接指向根外须问；审批期间换原链接仍只读所批真实目标', async () => {
    const f = fixture()
    const first = join(f.outside, 'a'), second = join(f.outside, 'b'), alias = join(f.root, 'link')
    writeFileSync(first, 'approved'); writeFileSync(second, 'unreviewed'); symlinkSync(first, alias)
    const run = f.runtime.invoke(call('read', { path: alias }), {})
    expect((await f.request()).data.material).toContain(first)
    unlinkSync(alias); symlinkSync(second, alias)
    f.gate.resolve((await f.request()).id, 'approve')
    const result = await run
    expect(result.output).toBe('approved')
    expect(result.read?.path).toBe(first)
  })

  test.each(['read', 'write', 'edit'])('批准的真实文件被替换成链接时 %s 不接触未审文件、不二次询问', async (name) => {
    const f = fixture()
    const target = join(f.outside, 'a'), other = join(f.outside, 'b')
    writeFileSync(target, 'before'); writeFileSync(other, 'secret')
    const run = f.runtime.invoke(call(name, { path: target, content: 'bad', old: 'secret', new: 'bad' }), {})
    const req = await f.request()
    unlinkSync(target); symlinkSync(other, target)
    f.gate.resolve(req.id, 'approve')
    const result = await run
    expect(result.ok).toBe(false)
    expect(result.output).toContain('目标已改变')
    expect(readFileSync(other, 'utf8')).toBe('secret')
    expect(f.h.countOf('tool.decision.request')).toBe(1)
    expect(f.h.countOf('tool.decision')).toBe(1)
  })

  test('批准后父目录换成链接，搜索与命令不得从新目标执行', async () => {
    const f = fixture()
    const run = f.runtime.invoke(call('exec', { cwd: f.outside, cmd: 'printf bad > marker' }), {})
    const req = await f.request()
    renameSync(f.outside, `${f.outside}-old`); symlinkSync(f.root, f.outside)
    f.gate.resolve(req.id, 'approve')
    expect((await run).ok).toBe(false)
    expect(() => readFileSync(join(f.root, 'marker'))).toThrow()
    expect(f.h.countOf('tool.decision')).toBe(1)
  })

  test('悬空链接的新建写，审批显示真实落点且写入该落点', async () => {
    const f = fixture()
    const target = join(f.outside, 'new'), alias = join(f.root, 'link')
    symlinkSync(target, alias)
    const run = f.runtime.invoke(call('write', { path: alias, content: 'created' }), {})
    expect((await f.request()).data.material).toContain(target)
    f.gate.resolve((await f.request()).id, 'approve')
    expect((await run).ok).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('created')
  })

  test('取消待审批后迟到批准不执行、不记授权、不追加裁决', async () => {
    const f = fixture()
    const controller = new AbortController()
    const path = join(f.outside, 'new')
    const run = f.runtime.invoke(call('write', { path, content: 'bad' }), { signal: controller.signal })
    const req = await f.request()
    controller.abort()
    expect((await run).ok).toBe(false)
    f.gate.resolve(req.id, 'approve', { remember: true })
    expect(() => readFileSync(path)).toThrow()
    expect(f.grants.rules()).toHaveLength(0)
    expect(f.h.countOf('tool.decision')).toBe(1)
  })

  test('审批期间参数变动与重复答复不换执行目标', async () => {
    const f = fixture()
    const path = join(f.outside, 'a'), other = join(f.outside, 'b')
    const args = { path, content: 'approved' }
    const run = f.runtime.invoke(call('write', args), {})
    const req = await f.request()
    args.path = other; args.content = 'bad'
    f.gate.resolve(req.id, 'approve'); f.gate.resolve(req.id, 'approve')
    expect((await run).ok).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('approved')
    expect(() => readFileSync(other)).toThrow()
    expect(f.h.countOf('tool.decision')).toBe(1)
  })

  test('全放行仍不能越过直接禁止', async () => {
    const f = fixture(true)
    writeFileSync(join(f.root, 'keep'), 'keep')
    expect((await f.runtime.invoke(call('exec', { cmd: 'rm keep' }), {})).ok).toBe(false)
    expect(readFileSync(join(f.root, 'keep'), 'utf8')).toBe('keep')
    expect(f.h.countOf('tool.decision.request')).toBe(0)
    expect(f.h.countOf('tool.decision')).toBe(1)
  })
})
