/**
 * 沙箱原语 —— **执行契约**（形态级 · 已冻结）。
 *
 * 出处：技术方案 · 执行：工作区与沙箱（「沙箱接口（首站原语）」「原语形态（决策级）」）。
 * **内核不直碰文件系统**——一切经沙箱；豁免＝内核自用存储（技术方案 · 代码治理 · 边界纪律）。
 * 这是远端替换（第三站）的必要条件：首站本地实现（进程级），远端实现接同一接口。
 *
 * 本文件是**转写**：只落技术方案已冻结之形态，不加设计。
 * 阶段 1 实装 `exec`；余随工具集 v1（阶段 2）。
 */

import type { BlobRef } from './records.ts'

// —— exec（阶段 1 实装）——

/** `exec` 返回——**错误＝返回值**（不抛）：`exit` 非 0 即失败。 */
export type ExecResult = {
  readonly exit: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * `exec` 选项——cwd 约束 · 超时 / 输出上限（超限截断、大块落 blob）。
 * 阈值为实现级常量（技术方案 · 工具 · 阶段 1 集）。
 *
 * TODO(规划侧)：技术方案只写「超时 / 输出上限为常量」，未定字段名与单位；占位如下。
 */
export type ExecOptions = {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

// —— 其余原语（随工具集 v1 · 阶段 2）——

/**
 * 原语返回——**错误＝返回值**（不抛）。
 *
 * TODO(规划侧)：技术方案只写「错误＝返回值」，未定返回形态；占位为判别式 Result。
 * `exec` 不在其列——它的返回形态已由技术方案直接给出（见 `ExecResult`）。
 */
export type SandboxResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SandboxError }

/**
 * 沙箱错误。
 *
 * TODO(规划侧)：错误分类（越界 / 超时 / 权限 / 系统）未定；占位为消息 + 可选码。
 */
export type SandboxError = {
  readonly message: string
  readonly code?: string
}

/**
 * `read` 返回——读文件（超长截断）。
 *
 * TODO(规划侧)：截断标记与「超长转 blob」的规则未定；占位如下。
 */
export type ReadResult = {
  readonly content: string
  readonly truncated?: boolean
}

/**
 * `write` 入参内容——文本，或转存 blob。
 *
 * TODO(规划侧)：形态未定；占位对齐 `Content` 的两选一。
 */
export type WriteData = { readonly text: string } | { readonly blob: BlobRef }

/**
 * `list` 条目。
 *
 * TODO(规划侧)：条目形态（名 / 类型 / 尺寸）未定；占位仅名。
 */
export type ListEntry = {
  readonly name: string
}

/**
 * `match` 命中。
 *
 * TODO(规划侧)：命中形态（路径 / 行号 / 片段）未定；占位仅路径。
 */
export type MatchHit = {
  readonly path: string
}

/**
 * `match` 选项（grep / glob 共用底）。
 *
 * TODO(规划侧)：字段未定；占位为不透明负载。
 */
export type MatchOptions = Readonly<Record<string, unknown>>

/**
 * 沙箱接口——执行命令 · 读 · 写 · 列 · 匹配。
 * 路径解析——**相对按默认根、绝对须落于某根内**；越界＝所有根之外。
 * 阶段 1：启动目录＝默认根（唯一）；阶段 3：多根注册（配置文件持有，平等平铺）。
 */
export interface Sandbox {
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>
  read(path: string): Promise<SandboxResult<ReadResult>>
  write(path: string, data: WriteData): Promise<SandboxResult<void>>
  list(path: string): Promise<SandboxResult<ListEntry[]>>
  match(pattern: string, opts?: MatchOptions): Promise<SandboxResult<MatchHit[]>>
}
