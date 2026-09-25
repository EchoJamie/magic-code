/**
 * `exec` —— 命令执行（阶段 1 唯一实装的工具；工具集 v1 到站后与六件文件 / 搜索工具并列，
 * 见 `toolset.ts`）。
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
 *
 * **后台那一形**（U70）——`background` 这个布尔位把这一条命令**交出去**：不占着这一轮，
 * 进程接着跑，回执给「id ＋ 输出文件路径」（设计 · 工具执行与权限 · 六格）。本文件只做
 * **发起那一格**：起 · 停归执行域（`BackgroundRuns`），「跑完回一条给模型」归装配那一层
 * （登记在进程真退出时发）——三条界线都在各自那一处写着，此处不重复判。
 */

import type { ExecResult } from '@magic/contracts'
import {
  backgroundStarted,
  backgroundStartFailed,
  OUTPUT_BACKGROUND_UNSUPPORTED,
  OUTPUT_CANCELED_RUNNING,
  OUTPUT_EXEC_NO_CMD,
} from './messages.ts'
import type { ToolDefinition, ToolRunContext, ToolRunResult } from './registry.ts'
import { refused, rowOf } from './toolkit.ts'

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
 * **`exec` 的这一形另外那一位**（U70）——后台那一形的发起（六格的第一格）。
 *
 * ## 为什么是**叠加**，不是往 `EXEC_PARAMETERS` 里添一笔
 *
 * `EXEC_PARAMETERS` 这一个对象**归 U69 拥有**（它在那儿添超时那一项）——两单各改一遍
 * 同一个对象，迟早在那处撞车。故本单元只**在自己这一层叠上自己那一项**：`cmd` 仍是
 * 契约锚定的那个键（技术方案 · 工具 · 参数键），`background` 是这一形自己的开关。
 *
 * ## 描述里要说清的三件
 *
 * 模型只有这一段话可读，而这一形的用法全在这一段里：
 * - **交出去就不占着这一轮**（命令接着跑，这一轮可以接着干别的）——这一形存在的理由；
 * - **立刻回「id ＋ 输出文件路径」**，看进展用 `read` 读那个文件；
 * - **跑完会有一条消息回来**（带那个路径）——故**不要轮着读它等结束**。
 *
 * 另有一句得说：**它没有超时**（别把这一形当「避免超时的绕法」使唤——要等结果的命令
 * 照旧前台跑）。
 */
const EXEC_PARAMETERS_WITH_BACKGROUND = {
  ...EXEC_PARAMETERS,
  properties: {
    ...EXEC_PARAMETERS.properties,
    background: {
      type: 'boolean',
      description:
        '交出去、不占着这一轮（dev server / watch / 长时间构建那一类）。' +
        '立刻回一个 id 与输出文件路径，命令接着跑；要看进展就用 read 读那个文件。' +
        '它跑完时会有一条消息带那个路径回来——不要轮着读它等结束。' +
        '这一形没有超时；要当场等结果的命令别用它。缺省＝跟前台一样。',
    },
  },
} as const

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

/**
 * **后台那一形**——把命令交给后台登记，当场把回执交回模型。
 *
 * 三件各归各位：
 * - **本文件**只转手（起在哪、停在哪儿归执行域；跑完怎么投一条消息回来归装配那一层）；
 * - **「跑完 ⇒ 回一条给模型」不在这儿**——那一声由登记在**进程真退出**时发（见
 *   `BackgroundRuns.start` 的 `onFinish`），这一跳**不等它**（等了就又不占着这一轮了）；
 * - ⚠️ **「输出安静了」不等于「它结束了」**：本文件**一个字都不据输出判结束**。
 *
 * 没接后台能力时**不静默退回前台**——那是改了这一条调用的意思（见 `OUTPUT_BACKGROUND_UNSUPPORTED`）。
 */
async function startBackground(cmd: string, ctx: ToolRunContext): Promise<ToolRunResult> {
  const runs = ctx.background
  if (runs === undefined) return refused(OUTPUT_BACKGROUND_UNSUPPORTED)

  const started = await runs.start(cmd)
  if (!started.ok) return refused(backgroundStartFailed(started.reason))

  // `ok: true`——**交出去这件事做成了**（命令后来跑成什么样是另一件事，由那一声回执说）。
  // 这里报 false 会让模型以为「没跑」，而它其实正在跑。
  return { ok: true, output: backgroundStarted(started.id, started.outputPath) }
}

/** 造 `exec` 的工具定义。 */
export function defineExecTool(): ToolDefinition {
  const row = rowOf('exec')

  return {
    spec: {
      name: row.name,
      summary: row.summary,
      parameters: EXEC_PARAMETERS_WITH_BACKGROUND,
      danger: row.danger,
    },

    async run(args, ctx): Promise<ToolRunResult> {
      const cmd = args.cmd
      if (typeof cmd !== 'string' || cmd.trim() === '') {
        return { ok: false, output: OUTPUT_EXEC_NO_CMD }
      }

      // **后台那一形**（U70）——交出去就回，不占着这一轮。
      //
      // 判据是 `=== true`：`background` 只在「要这一形」时给得成真；写成别的（字符串 /
      // 数字 / 缺席）一律按**前台**走 —— 前台是这一形之外的老路，一个字都不动。
      //
      // ⚠️ **闸门照走**：这一支在 `run` 里，而 `run` 只可能在闸门批准之后被调到
      // （分发：闸门在执行路径内、不可绕过）——后台**不是**绕过裁决的口子。
      if (args['background'] === true) {
        return startBackground(cmd, ctx)
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
