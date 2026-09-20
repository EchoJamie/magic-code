/**
 * 界面验收工具（U40）——**这一个入口对两种使用者**。
 *
 * | 谁 | 拿什么 | 干什么 |
 * | --- | --- | --- |
 * | 自动测试 | `createUiSession`／`runScenario`／`SCENARIOS` | 起隔离实例、敲键、等条件、判、收摊 |
 * | 助手 | `createControl`／`prepareControlDir`／`sendRequest` | 常驻进程里逐行 JSON 使唤同一个实例 |
 *
 * 薄命令行入口在 `packages/app/scripts/ui.ts`（只解析参数、调这里的件，不复制逻辑）。
 * 现场产物与查看页见 `artifacts.ts` / `viewer.ts`。
 */

export { createUiSession, UiWaitTimeout, UI_KEYS, REPO_ROOT, DEFAULT_ARTIFACTS_ROOT, rawBytesOf } from './driver.ts'
export type {
  Capture,
  CloseReport,
  SessionFacts,
  UiKey,
  UiSession,
  UiSessionOptions,
  WaitCondition,
  WaitOptions,
  WaitResult,
} from './driver.ts'

export { SCENARIOS, ScenarioFailure, runScenario, scenarioNames, recordOf } from './scenarios.ts'
export type {
  CheckOutcome,
  Scenario,
  ScenarioContext,
  ScenarioName,
  ScenarioOptions,
  ScenarioResult,
} from './scenarios.ts'

export { createControl, prepareControlDir, openFifoStream, appendReply, sendRequest, listControlDir } from './control.ts'
export type { Control, ControlDir, ControlOptions, ControlReply, ControlRequest } from './control.ts'

export { startFixture } from './fixture.ts'
export type { Fixture, FixtureRequest, FixtureTurn } from './fixture.ts'

export { writeViewer } from './viewer.ts'
export { createSandbox } from './sandbox.ts'
export type { Sandbox } from './sandbox.ts'
