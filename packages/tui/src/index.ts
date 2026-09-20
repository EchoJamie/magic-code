/**
 * `@magic/tui` —— 外壳（**显示组件自持** · 缺陷轮 II 重画）。
 *
 * **只认控制面**——经 `ControlTransport`（外壳侧一端，装配注入）发命令 / 订阅事件；
 * 不认知任何域、不 import 具体实现（技术方案 · 边界纪律）。
 * 渲染按 `KernelEvent` 的 `kind` **自动收窄**（判别联合视图——无须强转）。
 *
 * 出处：`界面原型.html`（已定稿）——十四屏场景 · 组件规格 · 状态行规格 · 交互逻辑。
 * 许可外部库：Ink（显示组件自建——技术方案 · 选型）。
 *
 * 四层：
 * 1. **视图模型**（`view.ts`）——事件 → 一屏的**纯归约** ＋ 接管 / 草稿 / 折叠的规矩；
 * 2. **会话壳**（`shell.ts`）——控制面接线 ＋ **键位语义**（slash 两种走法 · 接管 · 重建）；
 * 3. **一屏**（`components/`）——Ink 组件；`runTui` 挂上终端（**全屏 ＋ 备用屏**）；
 * 4. **启动**（`run.ts`）——尺寸变化重算 · 启动流转 · 重建（缺陷 D1）。
 *
 * 固定命令三条（`/model` · `/session` · `/help`）；不认得的斜杠文字**如实说一句**，
 * 其余一律人话（不发命令给内核、也不当交代发给模型）。
 *
 * 归属：骨架见 工作分解 · U09；会话面见 U16；重画见 缺陷轮 II；滚动与性能归后续。
 */

// —— 启动 ——

export { runTui } from './run.ts'
export type { RunTuiOptions, TuiHandle } from './run.ts'

// —— 会话壳（控制面接线 ＋ 键位语义）——

export { createShell } from './shell.ts'
export type { Shell, ShellEffect, ShellKey, ShellOptions } from './shell.ts'

// —— diff（工具输出的已知形态之一：改了什么 · U20）——

export { diffRowsOf, looksLikeDiff, replaceDiff } from './diff.ts'
export type { DiffKind, DiffRow } from './diff.ts'

// —— 启动字标（品牌视觉 · TUI Banner）——
//
// 三份文本资源 ＋ 按列数选版的规则。**默认用块字版**；ASCII 那份留着、**没有路径切过去**
// （「块字符不自动检测」——终端不告诉你字体信息，见 `banner.ts` 头注）。

export {
  BANNER_ASCII,
  BANNER_COMPACT,
  BANNER_COMPACT_MIN,
  BANNER_MAGIC_WIDTH,
  BANNER_WIDE,
  BANNER_WIDE_MIN,
  bannerOf,
} from './banner.ts'

// —— 视图与归约 ——

export {
  COMMANDS,
  HINT_IDLE,
  appendEcho,
  appendOutput,
  appendReceipt,
  closePicker,
  createView,
  hasRunningTool,
  isSessionRow,
  matchCommands,
  movePicker,
  openPicker,
  picked,
  rebuild,
  reduce,
  settle,
  stateLabel,
  takeOver,
  textOfLines,
  undock,
  withBanner,
  withContextWindow,
  withDecisionStatus,
} from './view.ts'
export type {
  CommandSpec,
  CompletionState,
  Dock,
  LogRow,
  PendingDecision,
  Picker,
  PickerRow,
  ShellStatus,
  ShellView,
  Stashed,
  StatusState,
  ToolRunState,
} from './view.ts'

// —— 一屏（`AppView` 纯呈现 · `TuiApp` 活壳）——

export { AppView, TuiApp, dockHeightOf, isEmpty, toShellKeys } from './components/app.ts'
export type { AppViewProps, TuiAppProps } from './components/app.ts'

// —— 显示部件（快照与自持组件用）——

export { LogRowView, logLines, needsSpacer, needsSpacerAfter, rowLines } from './components/log.ts'
export type { LogLine, LogRowProps, Segment } from './components/log.ts'
export { DecisionCard } from './components/decision.ts'
export { Composer, placeholderOf } from './components/composer.ts'
export type { ComposerTone } from './components/composer.ts'
export { PickerList } from './components/picker.ts'
export { StatusLine } from './components/status.ts'
export {
  PALETTE,
  displayWidth,
  durationLabel,
  tokenLabel,
  truncate,
  usageLabel,
  windowLabel,
  wrap,
} from './components/lines.ts'
