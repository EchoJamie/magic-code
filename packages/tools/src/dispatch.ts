/**
 * 分发 —— 机制的第二件：**请求 → 闸门 → 执行 → 回填**。
 *
 * 出处：技术方案 · 领域划分（工具域规则）「**闸门在执行路径内、不可绕过**；机制在内、
 * 工具集在外（可插拔）；分发即『请求 → 闸门 → 执行 → 回填』」。
 *
 * 一条链路，四步各留其痕：
 * ① **请求**——铸 `tool.call` 并发出。这一步**无条件**：模型请求过什么是事实，
 *    且链引用（`callRef`）就在这里拿到，后面三步都靠它；
 * ② **闸门**——`decide(call, ctx, callRef)`。**批准才可能执行**——没有第二条路能走到
 *    执行体（这是「不可绕过」的全部内容：不是文档里的承诺，而是代码里唯一的入口）；
 * ③ **执行**——注册表查定义、交沙箱。执行体**不碰**闸门与事件面（职责单一）；
 * ④ **回填**——终值定记录侧形态（大块转存经记录域），发 `tool.result`，再返回给调用方。
 *
 * 返回的那一份就是契约 `ToolResult` 的三件（`ok` / `output` ／ `content` / `callRef`），
 * **本域不自造补充**：`content` 与 `tool.result` 事件的 `output` **同物**（同一个值），
 * `callRef` 与传给闸门的 `callRef` **同一次调用的同一个 id**——两处都由这里一次算出。
 *
 * 三处判断，各有理由（都写在下面对应位置）：
 * - **每个调用都问闸门**——包括未注册的工具名与解析不出的参数。不给「这些不必问」的
 *   分支，就少一条能被误用的岔路；权限域的机械分析本就把「表外 / 解析不出」归入从严
 *   （U07 判据 5），那条路正是为它们留的。代价是偶尔问一次跑不了的调用——比漏问安全。
 * - **入口即中止则连问都不问**——用户刚按了 Ctrl-C，再弹一个「要不要跑 rm -rf」是骚扰，
 *   答复也只会落到一个已经结束的轮上。与沙箱「已中止的信号不启动进程」同一姿势。
 * - **闸门在途被中止则不再等**（U07 备案把这一环交给本域：`invoke` 的 `signal` 竞速）。
 *
 * **外部工具的身份在这儿附上**（U38）：注册表查到定义之后，定义里写着的 `external`
 * （服务器 ＋ 工具名）随调用交给闸门——**权限域只认这一份来源**，模型参数里的自报不作数。
 * 这也是「请求 → 闸门」之间唯一被加过料的一件，且加的是**注册表的事实**，不是猜测。
 */

import type { OutputDelta, RecordId, ToolCall, ToolResult, ToolRuntime } from '@magic/contracts'
import { toContent } from './blobs.ts'
import { toolCallEvent, toolOutputDeltaEvent, toolResultEvent } from './events.ts'
import {
  crashedOutput,
  OUTPUT_CANCELED_BEFORE_RUN,
  OUTPUT_INVALID_ARGS,
  OUTPUT_REJECTED,
  unknownToolOutput,
} from './messages.ts'
import { createRegistry } from './registry.ts'
import type { ToolDefinition, ToolRegistry, ToolRunResult } from './registry.ts'
import type { ToolInvokeOptions, ToolRuntimeOptions } from './runtime.ts'
import { refused, reasonOf } from './toolkit.ts'
import { defineToolsetV1 } from './toolset.ts'

/** 竞速的哨兵——与任何裁决值都不同型，收窄时不会与 `Decision` 撞。 */
const ABORTED = Symbol('aborted')

/**
 * 让一个 Promise 与信号竞速：信号先到即以 `ABORTED` 落定（**不抛**——调用方要的是
 * 「不等了」，不是「出错了」）。
 *
 * 用途专一：**在途裁决**。闸门的 `decide` 是「等一个人答复」，可能等很久；
 * 而 U07 的 `PermissionGate` **没有取消面**（在途裁决表由它自己持有），故只能在这里
 * 竞速——中止后那次询问在权限域那边仍悬着，这是首站的已知限度（阶段 2 恢复期处置
 * 「未答复裁决＝按拒绝落账」，见技术方案 · 恢复 ④）。
 */
async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
  if (signal === undefined) return promise
  if (signal.aborted) return ABORTED

  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * 造一个工具域实例。
 *
 * 默认工具集＝**工具集 v1（七件）**——`options.tools` 是**追加**出口（自定义 / 未来的 MCP
 * 集从这里进来，不替换默认集）。阶段 1 的默认集只有 `exec`；其余六件随工具集 v1（U13）到站。
 */
export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  /**
   * 追加集的那一份——**数组＝构造期定死，函数＝每次现取**（见 `ToolRuntimeOptions.tools`）。
   *
   * 注册表因此**按次现造**：件数是个位到几十，造一张 Map 的代价远低于「工具表悄悄停在
   * 装配那一刻」的代价。**注册即校验**照旧在（每一次造表都过那两道：无名即拒、重名即拒）。
   */
  const sourceOf = (): readonly ToolDefinition[] =>
    typeof options.tools === 'function' ? options.tools() : options.tools ?? []
  const registryOf = (): ToolRegistry => createRegistry([...defineToolsetV1(), ...sourceOf()])

  // 构造期先校一遍：**坏表不该活到调用期**（内置集与构造那一刻的
  // 追加集有问题，就在这里当场响，而不是等第一轮模型请求）
  registryOf()

  /**
   * 闸门要的根视图——**纯数据**，由本域给出（契约：不传端口进端口）。
   * 每次调用现取：多根（U18）之后 `roots()` 会变，缓存下来就会悄悄落后。
   *
   * **两张表都给**（U22 · 技术方案 · 权限「权限域的根表要与执行域同源」）——只给规范形
   * 那一张时，模型照用户手写的 `/tmp/proj/src` 给路径会被闸门判成根外 ⇒ **每次读都弹卡**，
   * 而沙箱那一侧**认**（它自己判两张）。同源＝这一处照执行域的两张表一起递。
   */
  const contextOf = (): {
    roots: readonly string[]
    declaredRoots: readonly string[]
    defaultRoot: string
  } => ({
    roots: options.workspace.roots(),
    declaredRoots: options.workspace.declaredRoots(),
    defaultRoot: options.workspace.defaultRoot(),
  })

  /** ③ 执行——交执行体；执行体抛了也归失败（不炸调用方）。 */
  const execute = async (
    call: ToolCall,
    definition: ToolDefinition | undefined,
    opts: ToolInvokeOptions,
    onOutput: (delta: OutputDelta) => void,
  ): Promise<ToolRunResult> => {
    if (call.invalid === true) return refused(OUTPUT_INVALID_ARGS)
    if (definition === undefined) return refused(unknownToolOutput(call.name))

    try {
      return await definition.run(call.args, {
        sandbox: options.sandbox,
        signal: opts.signal,
        onOutput,
      })
    } catch (error) {
      return refused(crashedOutput(reasonOf(error)))
    }
  }

  /** ② 闸门 ＋ ③ 执行——批准之前，执行这一步根本不存在。 */
  const settle = async (
    call: ToolCall,
    definition: ToolDefinition | undefined,
    callRef: RecordId,
    opts: ToolInvokeOptions,
    onOutput: (delta: OutputDelta) => void,
  ): Promise<ToolRunResult> => {
    // 入口即中止——不问、不跑（理由见文件头注）
    if (opts.signal?.aborted === true) return refused(OUTPUT_CANCELED_BEFORE_RUN)

    // **问之前先附上注册表给的身份**（U38）——外部工具的真实来源只认这一处：
    // 定义里写着它属于哪条服务器，模型参数里的自报一概不作数（见契约 `ToolCall.external`）。
    // 查表在询问之前做，是这一步唯一挪动过的东西：查表**没有副作用**，而闸门要的正是它。
    const asked: ToolCall =
      definition?.external === undefined ? call : { ...call, external: definition.external }

    const decision = await raceAbort(options.gate.decide(asked, contextOf(), callRef), opts.signal)
    if (decision === ABORTED) return refused(OUTPUT_CANCELED_BEFORE_RUN)
    if (decision === 'reject') return refused(OUTPUT_REJECTED)

    return execute(call, definition, opts, onOutput)
  }

  return {
    // **现取**（见 `registryOf`）——工具表随连接实况走，不停在装配那一刻
    definitions: () => registryOf().definitions,

    async invoke(call: ToolCall, opts: ToolInvokeOptions): Promise<ToolResult> {
      // ① 请求——链引用的来处（信封归产出方铸：派生的 id 当场就要用）
      const callEvent = toolCallEvent(options.stamper, call)
      options.sink.emit(callEvent)
      const callRef = callEvent.id

      /** 流式转接——**先记事件、再转调用方**：调用方的回调抛了也不该丢记录。 */
      const onOutput = (delta: OutputDelta): void => {
        options.sink.emit(toolOutputDeltaEvent(options.stamper, callRef, delta))
        opts.onOutput?.(delta)
      }

      const registry = registryOf()
      const outcome = await settle(call, registry.get(call.name), callRef, opts, onOutput)

      // ④ 回填——终值定形（大块转存经记录域），先落事件、再交调用方
      const content = await toContent(outcome.output, options.blobs)
      options.sink.emit(toolResultEvent(options.stamper, callRef, outcome.ok, content))

      return { ok: outcome.ok, output: outcome.output, callRef, content }
    },
  }
}
