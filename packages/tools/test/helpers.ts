/**
 * 本包用例的共用夹具——一束替身 ＋ 一个工作区小桩。
 *
 * 替身取自 `@magic/faux`（依赖纪律：`src/**` 只许 `@magic/contracts`，**`test/**` 额外许可
 * 测试替身包**——见 `test/scaffold.test.ts` 的分面规则）。工具域要的四个端口正好都有：
 * 沙箱 · 权限 · 扇出 · 铸造器 ＋ 记录域的 blob 面。
 *
 * 唯一的自造件是**工作区小桩**：`@magic/faux` 的五个桩里**没有 `WorkspaceService`**
 * （U12 未造，见回报「待决」），而工具域要从它取「根视图」交给闸门
 * （契约 · `PermissionContext` 是纯数据——端口不进端口）。
 */

import type { BlobStore, OutputDelta, WorkspaceService } from '@magic/contracts'
import type { FauxDecider, FauxExecScript } from '@magic/faux'
import {
  makeFauxPermissionGate,
  makeFauxRecords,
  makeFauxSandbox,
  makeFauxSink,
  makeTestStamper,
} from '@magic/faux'
import { createToolRuntime } from '../src/index.ts'
import type { ToolDefinition, ToolRuntime } from '../src/index.ts'

/** 工作区根——权限与沙箱两处同源的锚（契约：越界判据两处须一致）。 */
export const ROOT = '/work/proj'

/** 会话 id——本包用例只一个会话。 */
export const SESSION = 's1'

/**
 * 工作区小桩——本阶段工具域**只取它的根视图**（`roots` / `defaultRoot`）。
 *
 * `resolve` 照执行域口径「越界即拒：**抛**」实现，只为接口完整；本阶段工具域不经此路
 * （`exec` 不传 `cwd`，工作目录约束由沙箱按默认根落）。到 U13 有文件类工具时再谈。
 */
export function makeTestWorkspace(root: string = ROOT): WorkspaceService {
  return {
    roots: () => [root],
    defaultRoot: () => root,
    resolve: (path: string) => {
      if (path.startsWith('/') || path.startsWith('..')) {
        throw new Error(`工作区越界：${path}（落在根 ${root} 之外）`)
      }
      return { absolute: `${root}/${path}`, root }
    },
  }
}

export type ToolDepsOptions = {
  /** 命令 → 沙箱结果（查表或按调用算）；缺省「成功 · 空输出」。 */
  readonly exec?: FauxExecScript
  /** 闸门姿势；缺省 `'approve'`（问了立答）。`'manual'` ＝ 问了不答（在途裁决用例）。 */
  readonly decider?: FauxDecider | 'manual'
  /** 追加注册的工具（默认集只有 `exec`）。 */
  readonly tools?: readonly ToolDefinition[]
  /** 覆盖转存面（转存失败用例）。 */
  readonly blobs?: BlobStore
}

/** 一束现成的替身——多数用例照这样拼。铸造器**一束一份**（信封同源）。 */
export type ToolDeps = {
  readonly stamper: ReturnType<typeof makeTestStamper>
  readonly sandbox: ReturnType<typeof makeFauxSandbox>
  readonly gate: ReturnType<typeof makeFauxPermissionGate>
  readonly sink: ReturnType<typeof makeFauxSink>
  readonly records: ReturnType<typeof makeFauxRecords>
  readonly workspace: WorkspaceService
  readonly runtime: ToolRuntime
}

/** 造一束替身 —— 真装配（U11）里这一束由装配根拼。 */
export function makeToolDeps(options: ToolDepsOptions = {}): ToolDeps {
  const stamper = makeTestStamper({ session: SESSION })
  const sandbox = makeFauxSandbox(options.exec === undefined ? {} : { exec: options.exec })
  const gate =
    options.decider === 'manual'
      ? makeFauxPermissionGate()
      : makeFauxPermissionGate({ auto: options.decider ?? 'approve' })
  const sink = makeFauxSink()
  const records = makeFauxRecords()
  const workspace = makeTestWorkspace()

  const runtime = createToolRuntime({
    sandbox,
    workspace,
    gate,
    sink,
    stamper,
    blobs: options.blobs ?? records.blobs,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  })

  return { stamper, sandbox, gate, sink, records, workspace, runtime }
}

/** 一个 `exec` 调用（用例里反复要）。 */
export function execCall(cmd: string, id = 'call_1'): { id: string; name: string; args: { cmd: string } } {
  return { id, name: 'exec', args: { cmd } }
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
  return { get deltas(): readonly OutputDelta[] { return deltas }, push: (d) => deltas.push(d) }
}
