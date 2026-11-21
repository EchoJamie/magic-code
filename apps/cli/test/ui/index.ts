/**
 * 界面验收工具（U40）——**这一个入口对两种使用者**。
 *
 * | 谁 | 拿什么 | 干什么 |
 * | --- | --- | --- |
 * | 自动测试 | `createUiSession`／`runScenario` | 起隔离实例、敲键、等条件、判、收摊（退出走 `session.quit()`——U46 起要按两次） |
 * | 助手 | `createControl`（`scripts/ui.ts serve` 里逐行 JSON 使它） | 一个常驻进程里反复使唤同一个实例 |
 *
 * 薄命令行入口在 `apps/cli/scripts/ui.ts`（只解析参数、调这里的件，不复制逻辑）。
 * 现场产物与查看页见 `artifacts.ts` / `viewer.ts`。
 */

export { createUiSession, REPO_ROOT } from './driver.ts'
export { summarizeRun } from './artifacts.ts'
export type {
  Capture,
  UiSession,
} from './driver.ts'

// **被测对象那一侧的词汇表**（U51 第九条）——机制层不认识它，由调用方传进来
export { statusLineOf } from './anchors.ts'

export { runScenario, scenarioNames } from './scenarios.ts'
export type {
  ScenarioName,
} from './scenarios.ts'

export { createControl } from './control.ts'

// 「一趟脚本」那一等入口（U51 第一条）——给一个步骤文件，一条命令跑完、自己收尾
export { parseSteps, runSteps } from './steps.ts'
export type { StepOutcome } from './steps.ts'

// 「只驱动、只取帧」（U51 第二条）——同一趟故事，一条判据都不判
export { runScenarioFrames } from './frames-only.ts'

export { startFixture } from './fixture.ts'
export type { FixtureTurn } from './fixture.ts'

export { createSandbox } from './sandbox.ts'
export type { Sandbox } from './sandbox.ts'
