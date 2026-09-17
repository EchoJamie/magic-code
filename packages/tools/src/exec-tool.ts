/**
 * `exec` —— 阶段 1 唯一实装的工具（工具集 v1 的其余六件归 U13）。
 *
 * 出处：技术方案 · 工具「阶段 1 集」——命令执行：**经沙箱 · 工作目录约束**；危险归类
 * **按命令解析**（按调用判定）；超时 / 输出上限为常量（超限截断；大块转存归调用方）。
 *
 * 四件事的分工（本文件只做前两件）：
 * ① **形态**——名称 / 描述 / 参数模式 / 危险归类。规格的静态三件**取自契约的
 *    `TOOLSET_V1` 冻结行**，本域不另抄一份（抄一份就有对不上的那天）；
 * ② **执行体**——把 `cmd` 交沙箱，把结果转成面向模型的文本；
 * ③ 危险判定（该不该问）——**归权限域**：本域只声明 `by-call`（按命令解析），
 *    机械分析在 `@magic/permission`。**不替它判、也不猜**；
 * ④ 大块转存 —— 归分发（机制层，对所有工具一视同仁）。
 *
 * **工作目录**：不传 `cwd`。沙箱的缺省就是工作区默认根——「工作目录约束」由此而来；
 * 模型要换目录就在命令里自己 `cd`（命令里的 `cd` 归权限域分析，不归本文件）。
 * 本阶段**不给模型 `cwd` 参数**：参数键只锚了 `cmd` 一个（技术方案 · 工具 · 参数键），
 * 未锚的键不发明（U13 若需要再谈）。
 */

import type { ExecResult } from '@magic/contracts'
import { TOOLSET_V1 } from '@magic/contracts'
import { OUTPUT_CANCELED_RUNNING, OUTPUT_EXEC_NO_CMD } from './messages.ts'
import type { ToolDefinition, ToolRunResult } from './registry.ts'

/**
 * 超时常量——缺省 120 秒。
 *
 * 为什么由本域显式给、不吃沙箱实现的缺省：这两个量是**工具的行为**（「跑一条命令最多等
 * 多久、最多看多少输出」），不是沙箱的私事。显式交出去，换一个沙箱实现也不会悄悄变口径
 * （远端沙箱接同一接口——技术方案 · 执行 · 隔离姿态）。
 */
export const EXEC_TIMEOUT_MS = 120_000

/**
 * 输出上限常量——每道流各 64 KiB（**每道流各自计**照 U05 口径）。
 *
 * 注意它**不是**大块转存的阈值（见 `blobs.ts` 头注）：上限管「命令能产出多少」——
 * 超了截断；阈值管「记录怎么存」——超了转存。两者互不代替。
 */
export const EXEC_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * 参数模式——**命令键锚定单一键 `cmd`**（技术方案 · 工具 · 参数键：已按候选键兜底者
 * 收窄为单一键）。`JsonSchema` 在契约里是「可序列化的不透明模式」（承载形态未定），
 * 故这里写一份朴素的 JSON Schema：送得出去、也读得懂，不赌任何库。
 */
export const EXEC_PARAMETERS = {
  type: 'object',
  properties: {
    cmd: {
      type: 'string',
      description: '要执行的命令（经 shell 解释；工作目录＝工作区默认根）',
    },
  },
  required: ['cmd'],
  additionalProperties: false,
} as const

/**
 * 取工具集 v1 的 `exec` 行——**规格的静态三件只此一处**（契约冻结表）。
 * 取不到即抛：那是契约被动了，不该在本域静默退化成一份手抄。
 */
function execRow(): { name: string; summary: string; danger: ToolDefinition['spec']['danger'] } {
  const row = TOOLSET_V1.find((candidate) => candidate.name === 'exec')
  if (row === undefined) {
    throw new Error('工具集 v1 表里没有 exec —— 契约的冻结行被动过了')
  }
  return row
}

/**
 * 把沙箱的判别式结果转成**面向模型的文本**。
 *
 * 形态是本实现选的（技术方案只定到「超限截断」「命令退出码」，没定排版），三条理由：
 * - **正文在前**——模型先看内容，再看元信息；
 * - **元信息带方括号**——一眼分辨「这是输出」还是「这是本域加的注」，不会被当成命令输出；
 * - **失败与成功同一形状**——`ok` 是独立字段，文本里不重复判断，只补齐「为什么非 0」。
 *
 * `ok` 的口径：**命令跑到头且 exit 0** 才算成功。exit 非 0 = 命令失败；
 * 被信号收掉（137）= 命令失败；沙箱级失败（`ok:false`）= 没跑成。三者都不是「成功」——
 * 回填一个 ok:true 会让模型以为事情办成了。
 */
function composeOutcome(result: ExecResult, signal: AbortSignal | undefined): ToolRunResult {
  if (!result.ok) {
    return { ok: false, output: `exec 未能执行（${result.reason}）：${result.message}` }
  }

  const blocks: string[] = []
  if (result.stdout !== '') blocks.push(result.stdout)
  if (result.stderr !== '') blocks.push(`[stderr]\n${result.stderr}`)
  if (result.truncated === true) {
    blocks.push(`[输出已截断（上限 ${EXEC_MAX_OUTPUT_BYTES} 字节）]`)
  }

  // 取消事实由**调用方自持的 signal** 判定（U05 口径：三个 reason 都是「沙箱坏了」，
  // 取消不是——不挤进 reason，故在这里据 signal 归位）。命令已经产出的输出照常带回。
  //
  // 这一支**不带 `[exit N]`**：退出码是信号的产物（137），抬头的「已取消」已经把事实
  // 说全了——再摆一个退出码只会让模型以为「命令跑完了、失败在 137」。两支互斥之下，
  // 正文里的元信息始终只说模型推不出来的那一件。
  if (signal?.aborted === true) {
    const body = blocks.join('\n')
    return {
      ok: false,
      output: body === '' ? OUTPUT_CANCELED_RUNNING : `${OUTPUT_CANCELED_RUNNING}\n${body}`,
    }
  }

  if (result.exit !== 0) blocks.push(`[exit ${result.exit}]`)

  return { ok: result.exit === 0, output: blocks.join('\n') }
}

/** 造 `exec` 的工具定义。 */
export function defineExecTool(): ToolDefinition {
  const row = execRow()

  return {
    spec: { name: row.name, summary: row.summary, parameters: EXEC_PARAMETERS, danger: row.danger },

    async run(args, ctx): Promise<ToolRunResult> {
      const cmd = args.cmd
      if (typeof cmd !== 'string' || cmd.trim() === '') {
        return { ok: false, output: OUTPUT_EXEC_NO_CMD }
      }

      const result = await ctx.sandbox.exec(cmd, {
        timeoutMs: EXEC_TIMEOUT_MS,
        maxOutputBytes: EXEC_MAX_OUTPUT_BYTES,
        onOutput: ctx.onOutput,
        signal: ctx.signal,
      })

      return composeOutcome(result, ctx.signal)
    },
  }
}
