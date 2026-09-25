/**
 * 本包用例的共用夹具——一束替身（全部取自 `@magic/faux`）。
 *
 * 依赖纪律按面分（`test/scaffold.test.ts`）：`src/**` 只许 `@magic/contracts`，
 * **`test/**` 额外许可测试替身包**。工具域要的**五个端口桩正好都在 faux 里**：
 * 沙箱 · 权限 · 工作区 · 扇出 · 铸造器（＋记录域的 blob 面）。
 *
 * 第 1 轮曾自持一个工作区小桩（当时 faux 没有 `WorkspaceService`）——第 2 轮补锚
 * faux 补了 `makeFauxWorkspace`，自持件随之删掉：**这才是 faux 存在的意义**
 * （别再各写一份，两份迟早对不上）。
 */

import type { BackgroundRuns, BlobStore, OutputDelta, WorkspaceService } from '@magic/contracts'
import type {
  FauxDecider,
  FauxExecScript,
  FauxPermissionGate,
  FauxRecords,
  FauxSandbox,
  FauxSink,
  TestStamper,
} from '@magic/faux'
import {
  makeFauxPermissionGate,
  makeFauxRecords,
  makeFauxSandbox,
  makeFauxSink,
  makeFauxWorkspace,
  makeTestStamper,
} from '@magic/faux'
import type { ToolDefinition } from '../src/index.ts'
import type { ToolRuntime } from '@magic/contracts'
import { createToolRuntime } from '../src/index.ts'

/** 工作区根——权限与沙箱两处同源的锚（契约：越界判据两处须一致）。 */
export const ROOT = '/work/proj'

/** 会话 id——本包用例只一个会话。 */
export const SESSION = 's1'

export type ToolDepsOptions = {
  /** 命令 → 沙箱结果（查表或按调用算）；缺省「成功 · 空输出」。 */
  readonly exec?: FauxExecScript
  /** 闸门姿势；缺省 `'approve'`（问了立答）。`'manual'` ＝ 问了不答（在途裁决用例）。 */
  readonly decider?: FauxDecider | 'manual'
  /** 追加注册的工具（默认集＝工具集 v1 七件，这里是**追加**）。 */
  readonly tools?: readonly ToolDefinition[]
  /** 覆盖转存面（转存失败用例）。 */
  readonly blobs?: BlobStore
  /**
   * 覆盖沙箱——给「替身也给不出的形态」用（如 `read` 报截断：`FauxSandboxOptions`
   * 没有那一档，而截断是 `edit` 的**数据安全件**，非测不可）。
   */
  readonly sandbox?: FauxSandbox
  /**
   * 后台运行登记（U70）——`exec` 的后台那一形要的那一件。
   *
   * 缺省**不给**：这一位不给＝这一形用不了（`background` 当场回一句「这次装配没接」），
   * 而那正是「旧装配一字不动」要保的姿势——多数用例只管前台，不必为此拖一个桩进来。
   */
  readonly background?: BackgroundRuns
}

/** 一束现成的替身——多数用例照这样拼。铸造器**一束一份**（信封同源）。 */
export type ToolDeps = {
  readonly stamper: TestStamper
  readonly sandbox: FauxSandbox
  readonly gate: FauxPermissionGate
  readonly sink: FauxSink
  readonly records: FauxRecords
  readonly workspace: WorkspaceService
  readonly runtime: ToolRuntime
}

/** 造一束替身 —— 真装配（U11）里这一束由装配根拼。 */
export function makeToolDeps(options: ToolDepsOptions = {}): ToolDeps {
  const stamper = makeTestStamper({ session: SESSION })
  const sandbox =
    options.sandbox ?? makeFauxSandbox(options.exec === undefined ? {} : { exec: options.exec })
  const gate =
    options.decider === 'manual'
      ? makeFauxPermissionGate()
      : makeFauxPermissionGate({ auto: options.decider ?? 'approve' })
  const sink = makeFauxSink()
  const records = makeFauxRecords()
  const workspace = makeFauxWorkspace({ root: ROOT })

  const runtime = createToolRuntime({
    sandbox,
    workspace,
    gate,
    sink,
    stamper,
    blobs: options.blobs ?? records.blobs,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.background === undefined ? {} : { background: options.background }),
  })

  return { stamper, sandbox, gate, sink, records, workspace, runtime }
}

/** 一个 `exec` 调用（用例里反复要）。 */
export function execCall(
  cmd: string,
  id = 'call_1',
): { id: string; name: 'exec'; args: Record<string, unknown> } {
  return { id, name: 'exec', args: { cmd } }
}

/**
 * 一个 `exec` 调用，**参数自己给全**（U69 的超时那一档要用）。
 *
 * 与 `execCall` 分开而不是加个第三参：`execCall(cmd)` 那一形是「只给命令」的写法，
 * 超时是**另一个问题**（等多久），混进同一个签名里，谁都得回头看参数位置。
 */
export function execCallWith(
  args: Record<string, unknown>,
  id = 'call_1',
): { id: string; name: 'exec'; args: Record<string, unknown> } {
  return { id, name: 'exec', args }
}

/**
 * 等一个条件成立——**让出几次**（不是「睡够时间」）。人工门的用例绕不开它：
 * 「中止在途裁决」得先等闸门真问起来。与 `@magic/faux` 骨架里的同名助手同法。
 */
export async function waitFor<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const found = probe()
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`等不到：${what}`)
}

/** 收集 `onOutput` 增量（端口面的消费助手）。 */
export function collector(): {
  readonly deltas: readonly OutputDelta[]
  readonly push: (delta: OutputDelta) => void
} {
  const deltas: OutputDelta[] = []
  return {
    get deltas(): readonly OutputDelta[] {
      return deltas
    },
    push: (d) => deltas.push(d),
  }
}
