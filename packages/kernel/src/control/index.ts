/**
 * `control/` 公开面 —— 控制面（内核侧 · U08）。
 *
 * 单元之间只经此面交互（工作分解 · 并行规约 1）：内核侧（主循环 U04 · 权限 U07）取
 * `onCommand` / `publish`，外壳侧（U09 起）取 `send` / `subscribe`。
 *
 * 消息形态**不在此另立**——`Command` / `KernelEvent` 一律从 `../contracts/index.ts` 取
 * （控制面契约 · 已冻结）；本目录只落**通道**（同进程直连）与**可序列化守护**。
 */

export * from './channel.ts'
export * from './serializable.ts'
