/**
 * `Sandbox` —— 沙箱端口实现（技术方案 · 领域划分：工具域 → 执行域）。
 *
 * **阶段 1 只实装 `exec`**；`read` / `write` / `list` / `match` 留桩——那是**工具集 v1
 * （阶段 2 · U13）**的事，本单元不做（技术方案 · 执行 · 原语形态末句）。
 *
 * 两件分工：
 * - 本文件＝**路径与工作区**——cwd 解析经 `WorkspaceService`，越界**在进程启动之前**
 *   就归位为 `reason: 'out-of-bounds'`（判据 4 第二例：越界＝进程不启动）；
 * - `exec.ts`＝**进程**——启动 · 流 · 超时 · 取消。
 *
 * `maxOutputBytes` 的取舍（实现级自由度——「命令执行的超时 / 输出上限」由实现裁量）：
 * **每道流各自计**。理由：判据与消费都按「这道流被截了没有」读，`truncated` 因而
 * 一眼可判；合并计则要两流相加才知道超没超，且谁多谁少说不清。代价是总内存可达 2× 上限，
 * 对首站（单机自用 · 上限由调用方给）可接受。
 */

import type { ExecOptions, ExecResult, Sandbox, WorkspaceService } from '@magic/contracts'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  runCommand,
} from './exec.ts'

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

  const unimplemented = (primitive: string): never => {
    throw new Error(`沙箱原语 \`${primitive}\` 阶段 1 未实装——归工具集 v1（U13）`)
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
      })
    },

    read: () => unimplemented('read'),
    write: () => unimplemented('write'),
    list: () => unimplemented('list'),
    match: () => unimplemented('match'),
  }
}
