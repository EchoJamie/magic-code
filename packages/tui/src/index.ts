/**
 * `@magic/tui` —— 外壳（显示组件自持）。
 *
 * **只认控制面**——经 `ControlTransport`（外壳侧一端，**装配注入**）发命令 / 订阅事件；
 * 不认知任何域、不 import 具体实现（技术方案 · 边界纪律）。
 * 渲染按 `KernelEvent` 的 `kind` **自动收窄**（判别联合视图——无须强转）。
 *
 * 许可外部库：Ink（显示组件自建——技术方案 · 选型）。
 *
 * 三层：
 * 1. **视图**（`view.ts`）——事件 → 一屏的**纯归约**（显示逻辑全在这层）；
 * 2. **会话壳**（`shell.ts`）——控制面接线：订阅事件 / 发三类命令；
 * 3. **一屏**（`components/`）——Ink 组件；`runTui` 挂上终端。
 *
 * 归属：TUI 骨架见 工作分解 · U09；显示打磨归 U20 · 受控渲染与性能归 U21。
 */

// —— 启动 ——

export { runTui } from './run.ts'
export type { RunTuiOptions, TuiHandle } from './run.ts'

// —— 会话壳（控制面接线）——

export { createShell } from './shell.ts'
export type { Shell } from './shell.ts'

// —— 视图与归约 ——

export { appendEcho, appendSessionList, createView, reduce, sessionLabel } from './view.ts'
export type {
  PendingDecision,
  SessionRow,
  ShellStatus,
  ShellView,
  ToolOutcome,
  ToolStream,
  ToolVerdict,
  TranscriptItem,
} from './view.ts'

// —— 一屏（`AppView` 纯呈现 · `TuiApp` 活壳）——

export { AppView, TuiApp } from './components/app.ts'
export type { AppViewProps, TuiAppProps } from './components/app.ts'
