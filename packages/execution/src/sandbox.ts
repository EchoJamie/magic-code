/**
 * `Sandbox` —— 沙箱端口实现（技术方案 · 领域划分：工具域 → 执行域）。
 *
 * **五原语齐**（阶段 1 实装 `exec`；`read` / `write` / `list` / `match` 四件归工具集 v1
 * ＝U13，本单元补齐——技术方案 · 执行 · 原语形态末句）。
 *
 * 三件分工（各管一摊，互不越界）：
 * - 本文件＝**路径与工作区**——一切路径经 `WorkspaceService.resolve` 归位：`exec` 的 cwd
 *   越界**在进程启动之前**归 `reason: 'out-of-bounds'`（判据 4 第二例：越界＝进程不启动）；
 *   余四原语**让 `resolve` 的抛照原样上去**（它们没有判别式位置——见 `files.ts` 头注）。
 * - `exec.ts` ＝ **进程**——启动 · 流 · 超时 · 取消。
 * - `files.ts` / `match.ts` ＝ **文件与匹配**——进来时已绝对、已落根内。
 *
 * `maxOutputBytes` 的取舍（实现级自由度——「命令执行的超时 / 输出上限」由实现裁量）：
 * **每道流各自计**。理由：判据与消费都按「这道流被截了没有」读，`truncated` 因而
 * 一眼可判；合并计则要两流相加才知道超没超，且谁多谁少说不清。代价是总内存可达 2× 上限，
 * 对首站（单机自用 · 上限由调用方给）可接受。
 */

import { resolve as resolvePath } from 'node:path'
import type {
  ExecOptions,
  ExecResult,
  ListEntry,
  MatchHit,
  MatchOptions,
  ProcessLedger,
  ReadResult,
  Sandbox,
  WorkspaceService,
  WriteData,
} from '@magic/contracts'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  runCommand,
} from './exec.ts'
import { DEFAULT_MAX_READ_BYTES, listDir, readText, writeInto } from './files.ts'
import { matchIn } from './match.ts'
import { isInside } from './workspace.ts'

/** 装配期构造入参（技术方案 · 领域划分 · 装配视图 2：执行域——工作区根注册）。 */
export type SandboxOptions = {
  /** 工作区端口——沙箱的 cwd 约束由它给出（同域两端口，边界规则**同源**）。 */
  readonly workspace: WorkspaceService
  /**
   * **归属账**（U50）——每一条命令起来的那一组记它一笔（见 `CommandOptions.ledger`）。
   *
   * 由装配造一本、**两处共用**（这里与 MCP 的 stdio 传输）：一个进程里「哪些进程是我们
   * 起的」只该有一本账；两处各造一本，收尾时就得两处都问，而漏问的那一处正是要防的事。
   */
  readonly ledger?: ProcessLedger | undefined
  /**
   * **内核自己的只读落点**（U70）——除各根之外，`read` 另认得的一处。
   *
   * 当前只有一个：**后台命令的输出目录**（`exec` 的后台那一形，落在工作区之外）。
   * 设计明写那一格的送达方式——「**取输出：用既有的 `read` 读那个文件**」，
   * 且**不许新造「取输出」的工具**。既有的 `read` 原语归位路径时只认各根，于是那一格
   * 在设计上成立、在代码里落不下去 ⇒ 边界得在这儿让开一条**只读**的口子。
   *
   * ## 三条分寸
   *
   * - **只读**——只有 `read` 认它；`write` / `list` / `match` 一个都不认（能从这儿读到，
   *   不等于能对它执行工具——同 `Materials` 那句「只读来源不扩大执行范围」）；
   * - **不是第二条根**——不参与相对路径解析、不进 `WorkspaceService.roots()`
   *   （故闸门那一侧照旧把它看成「根外」，一行都不改：权限闸门不动）；
   * - **词法判定**——与工作区那条边界同一把尺子（`isInside`），不额外承诺挡住符号链接。
   */
  readonly readOnlyDirs?: readonly string[] | undefined
}

/**
 * 取正有限数，否则回落缺省——`NaN` / 0 / 负数都不该悄悄变成「立刻超时」或「全都截掉」；
 * 缺省永远是**实数上限**（不是「无上限」）。
 */
function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 造一个沙箱实例（阶段 1：进程级薄隔离——工作目录约束；权限闸门在工具域）。 */
export function createSandbox(options: SandboxOptions): Sandbox {
  const { workspace } = options

  /**
   * 内核自己那处只读落点的**规范形**——解析一次定下（`resolvePath` 只做词法归一，
   * 与工作区那条落点判据同一把尺子；目录还不存在也照算得出）。
   */
  const extraReads: readonly string[] = (options.readOnlyDirs ?? []).map((one) => resolvePath(one))

  /**
   * 归位一个路径——**唯一的入口**：相对按默认根、绝对须落根内，越界即抛（`resolve`）。
   * 四个文件 / 匹配原语共用；`exec` 另有一份（它要把这个抛折成 `reason`，见下）。
   */
  const inRoot = (path: string): string => workspace.resolve(path).absolute

  /**
   * 归位一个**读**路径——根内照旧，另加**内核自己那处只读落点**（见 `SandboxOptions`）。
   *
   * 两处都落不下时**照旧抛越界**（报文与只用 `inRoot` 时逐字相同——那才是既有行为的
   * 「一字不动」：没有这一处配置的装配，这个函数与 `inRoot` 是同一件事）。
   */
  const readable = (path: string): string => {
    if (extraReads.length > 0) {
      const absolute = resolvePath(workspace.defaultRoot(), path)
      if (extraReads.some((dir) => isInside(absolute, dir))) return absolute
    }

    return inRoot(path)
  }

  return {
    async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
      let cwd: string

      try {
        // 缺省＝默认根（启动目录）；给出者按工作区规则解析——越界即拒
        cwd = opts.cwd === undefined ? workspace.defaultRoot() : workspace.resolve(opts.cwd).absolute
      } catch (error) {
        return {
          ok: false,
          reason: 'out-of-bounds',
          message: error instanceof Error ? error.message : String(error),
        }
      }

      return runCommand(cmd, {
        cwd,
        timeoutMs: positiveOr(opts.timeoutMs, DEFAULT_TIMEOUT_MS),
        maxOutputBytes: positiveOr(opts.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
        onOutput: opts.onOutput,
        signal: opts.signal,
        ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
      })
    },

    async read(path: string, opts?: { maxBytes?: number }): Promise<ReadResult> {
      // 上限可被调用方放大（`edit` 的「读 → 改 → 写回」靠它）；非法值回落实现常量
      return readText(readable(path), positiveOr(opts?.maxBytes, DEFAULT_MAX_READ_BYTES))
    },

    async write(path: string, data: WriteData): Promise<void> {
      return writeInto(inRoot(path), data)
    },

    async list(path: string): Promise<readonly ListEntry[]> {
      return listDir(inRoot(path))
    },

    async match(pattern: string, opts: MatchOptions): Promise<readonly MatchHit[]> {
      // 起点缺省＝默认根（相对按默认根 —— 与 exec 的 cwd 缺省同一姿势）
      return matchIn(inRoot(opts.path ?? '.'), pattern, opts)
    },
  }
}
