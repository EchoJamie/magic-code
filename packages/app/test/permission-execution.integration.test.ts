import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
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
})
