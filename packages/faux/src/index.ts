/**
 * `@magic/faux` —— **测试层 · 非域**（技术方案 · 工程结构：测试替身独立成包）。
 *
 * 两件：
 * ① **Faux Provider** —— `ModelGateway` 的一个假实现：注入固定事件序列
 *    （正文 / 思考 / 工具调用 / 错误分档），**不依赖网络与 key**。
 * ② **共享测试替身** —— 铸造器桩与其余端口的轻桩，让各域测试不必各写一份。
 *
 * **为什么单列成包**（技术方案 · 工程结构）——Faux 若落进模型域，对话域测试就得
 * import 模型域，破「域 → 契约」。故本包**只依赖 `@magic/contracts`**：任何域的测试
 * 皆可安全取用，不产生域间依赖。
 *
 * ⚠️ **反向不成立**——本包是测试层：**任何域的生产代码都不得 import 本包**（守护拦截）。
 * 这里没有生产逻辑，只有假模型与桩。
 *
 * 用法（骨架见 `test/skeleton.test.ts`）：
 * ```ts
 * const stamper = makeTestStamper()
 * const gateway = createFauxGateway({
 *   stamper,
 *   turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'ls' } }] }, { text: '跑完了' }],
 * })
 * const { events, result } = await drainStream(gateway.stream(request))
 * ```
 */

// —— ① Faux Provider ——

export { createFauxGateway, FAUX_MODEL, FauxScriptExhaustedError } from './gateway.ts'
export type { FauxGateway, FauxGatewayOptions, FauxResult, FauxStream } from './gateway.ts'

export { argsJsonOf, toPieces } from './script.ts'
export type { FauxText, FauxToolCall, FauxTurn } from './script.ts'

// —— ② 共享测试替身 ——

export { DEFAULT_TEST_SESSION, FIXED_AT, makeTestStamper } from './stamper.ts'
export type { TestStamper, TestStamperOptions } from './stamper.ts'

// 各端口的轻桩——「最小可用 ＋ 可观察」；域测试直接取用，不必各写一份
export { makeFauxRecords } from './stubs/records.ts'
export type { FauxRecords, FauxRecordsOptions } from './stubs/records.ts'

export { makeFauxSandbox } from './stubs/sandbox.ts'
export type { FauxExecScript, FauxSandbox, FauxSandboxOptions } from './stubs/sandbox.ts'

export { makeFauxToolRuntime } from './stubs/tools.ts'
export type {
  FauxToolHandler,
  FauxToolHandlerResult,
  FauxToolRuntime,
  FauxToolRuntimeOptions,
} from './stubs/tools.ts'

export { makeFauxPermissionGate } from './stubs/permission.ts'
export type {
  FauxDecider,
  FauxPermissionGate,
  FauxPermissionGateOptions,
  FauxPermissionRequest,
} from './stubs/permission.ts'

export { makeFauxSink } from './stubs/sink.ts'
export type { FauxSink } from './stubs/sink.ts'

export { makeFauxWorkspace } from './stubs/workspace.ts'
export type { FauxWorkspace, FauxWorkspaceOptions } from './stubs/workspace.ts'

// —— 消费助手 ——

export { drainStream } from './drain.ts'
export type { DrainableStream } from './drain.ts'
