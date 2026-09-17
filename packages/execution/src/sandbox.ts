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

import type {
  ExecOptions,
  ExecResult,
  ListEntry,
  MatchHit,
  MatchOptions,
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
import { DEFAULT_MAX_READ_BYTES, listDir, readText, writeText } from './files.ts'
import { matchIn } from './match.ts'

/** 装配期构造入参（技术方案 · 领域划分 · 装配视图 2：执行域——工作区根注册）。 */
export type SandboxOptions = {
  /** 工作区端口——沙箱的 cwd 约束由它给出（同域两端口，边界规则**同源**）。 */
  readonly workspace: WorkspaceService
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
   * 归位一个路径——**唯一的入口**：相对按默认根、绝对须落根内，越界即抛（`resolve`）。
   * 四个文件 / 匹配原语共用；`exec` 另有一份（它要把这个抛折成 `reason`，见下）。
   */
  const inRoot = (path: string): string => workspace.resolve(path).absolute

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
      })
    },

    async read(path: string): Promise<ReadResult> {
      return readText(inRoot(path), DEFAULT_MAX_READ_BYTES)
    },

    async write(path: string, data: WriteData): Promise<void> {
      return writeText(inRoot(path), data)
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
