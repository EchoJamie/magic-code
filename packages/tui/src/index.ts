/** TUI 公开契约：控制协议接线、启动与显示组件。内部功能模块由包内直接引用。 */

// —— 启动 ——

export { runTui } from './run.ts'
export type { RunFeed, ResumeFeed } from './shell.ts'
export type { RunTuiOptions, TuiHandle } from './run.ts'

// —— 会话壳（控制面接线 ＋ 键位语义）——

export { createShell, EXIT_ARM_MS } from './shell.ts'
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
  HINT_EXIT_ARMED,
  STOP_KEYS_HINT,
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
  noticeReceiptOf,
  openPicker,
  picked,
  rebuild,
  reduce,
  settle,
  stateLabel,
  takeOver,
  textOfLines,
  undock,
  unreadSummaryOf,
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

export { AppView, TuiApp, breathingOf, dockHeightOf, liveLayoutOf, toShellKeys } from './components/app.ts'
export type { AppViewProps, TuiAppProps } from './components/app.ts'

// —— 步骤清单（U34 · 排版与视口 ＋ 那一小块）——
//
// 排版那一层是**纯函数**（预算 · 折行 · 行视口 · 呼吸的数学）：账与屏同取一处，
// 外壳与渲染都只认它（见 `plan.ts` 头注）。

export {
  BREATH_MS,
  GLYPHS,
  MARK_WIDTH,
  PLAN_FOLDED,
  PLAN_INDENT,
  PLAN_KEEP_LINES,
  breathColor,
  breathOf,
  goalLines,
  planBlockOf,
  planBudgetOf,
  planMoreLabel,
  planMoreLine,
  planScrolled,
  planStyleOf,
  planWindow,
  stepLines,
} from './plan.ts'
export type { PlanBlock, PlanRow, PlanStyle, PlanWindow } from './plan.ts'
export { PlanList } from './components/plan.ts'
export type { PlanListProps } from './components/plan.ts'

// —— 显示部件（快照与自持组件用）——

export {
  LogRowView,
  logLines,
  needsSpacer,
  needsSpacerAfter,
  rowDrawn,
  rowLines,
  spacerEnd,
  spacerWalk,
} from './components/log.ts'
export type { LogLine, LogRowProps, Segment, SpacerWalk } from './components/log.ts'
export { DecisionCard } from './components/decision.ts'
export { Composer, placeholderOf } from './components/composer.ts'
export type { ComposerTone } from './components/composer.ts'
export { PickerList } from './components/picker.ts'
export { StatusLine, ALLOW_ALL_LABEL, statusLinePreview } from './components/status.ts'
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
