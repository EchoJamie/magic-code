/**
 * `exec` —— 命令执行（阶段 1 唯一实装的工具；工具集 v1 到站后与六件文件 / 搜索工具并列，
 * 见 `toolset.ts`）。
 *
 * 出处：技术方案 · 工具「阶段 1 集」——命令执行：**经沙箱 · 工作目录约束**；危险归类
 * **按命令解析**（按调用判定）；输出上限为常量（超限截断；大块转存归调用方）。
 *
 * ⚠️ **超时不是常量、是参数**（U69，用户 2026-09-25 定）——原先这里钉着
 * `EXEC_TIMEOUT_MS = 120_000`，条条命令都拿它掐。撤掉的理由：「这条命令该等多久」
 * **只有发起那件事的模型知道**（它知道自己在跑 `ls` 还是在跑一次构建）——由它按手上的事给，
 * **不填＝一直等**。理由与代价见设计 ·工具执行与权限「超时」那两条。
 * 输出上限**照旧是常量**（`EXEC_MAX_OUTPUT_BYTES`）：那个量管的是「一次能看多少」，
 * 有全局答案；超时管的是「等多久」，没有。
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
 * **不给模型 `cwd` 参数**：未锚的键不发明（技术方案 · 工具 · 参数键；U13 若需要再谈）。
 *
 * **参数键＝两把**（U69 起）：`cmd`（命令，必填）与 `timeoutMs`（等多久，可省）。
 * 后者是**唯一**一处「模型自己定系统量」的参数——它知道手上这件事是 `ls` 还是一次构建，
 * 别人替不了它（见 `EXEC_PARAMETERS` 里那一项的描述与上面那段注）。
 */

import type { ExecResult } from '@magic/contracts'
import {
  OUTPUT_CANCELED_RUNNING,
  OUTPUT_EXEC_BAD_TIMEOUT,
  OUTPUT_EXEC_NO_CMD,
  execTimedOutOutput,
} from './messages.ts'
import type { ToolDefinition, ToolRunResult } from './registry.ts'
import { rowOf } from './toolkit.ts'

/**
 * 输出上限常量——每道流各 64 KiB（**每道流各自计**照 U05 口径）。
 *
 * ⚠️ **超时那一件没有对应的常量了**（U69 撤的）——那是**参数**，不是常量，见文件头注。
 *
 * 注意它**不是**大块转存的阈值（见 `blobs.ts` 头注）：上限管「命令能产出多少」——
 * 超了截断；阈值管「记录怎么存」——超了转存。两者互不代替。
 */
export const EXEC_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * 参数模式——`JsonSchema` 在契约里是「可序列化的不透明模式」（承载形态未定），
 * 故这里写一份朴素的 JSON Schema：送得出去、也读得懂，不赌任何库。
 * 键名照契约「参数键」锚定：`cmd` 是**收窄为单一键**的那把（不再有候选集），
 * `timeoutMs` 是 U69 按设计（工具执行与权限 · 超时）新立的一把。
 *
 * ⚠️ **本表归 U69 拥有**——U70（`exec` 的后台那一形）之后集成时**在这一处加它自己那一项**，
 * 别两单各改一遍（两个都改＝两个都以为自己是对的，合成时谁也说不清哪份是准的）。
 */
export const EXEC_PARAMETERS = {
  type: 'object',
  properties: {
    cmd: {
      type: 'string',
      description: '要执行的命令（经 shell 解释；工作目录＝工作区默认根）',
    },
    /**
     * 超时——**管的是「等它多久」**，不是「它能跑多久」：到点命令已跑出的输出照样带回。
     *
     * `['number', 'null']` 是**有意的**：`null` 就是「不设上界」那个写法，写进模式里，
     * 模型才看得见「一直等」是一条**正当的**选择，而不是「忘了填」。`required` 不含它
     * ——不填与 `null` 同义（见 `readTimeout`）。不用 `0`：读起来像「立刻超时」。
     */
    timeoutMs: {
      type: ['number', 'null'],
      // 描述是**给模型读的说明书**（同 `file-tools.ts` 那一节的口径：它就是「这个键怎么用」），
      // 故与其余七件的描述同一副行文——**不夹 Markdown 记号**（星号会原样落到模型那边）。
      description:
        '最多等这条命令多久（毫秒）。到点就按进程组掐断：命令跑过了，已产出的输出照样带回，' +
        '不是「没执行」。不填＝一直等（不设上界）；要显式表达「一直等」就写 null。' +
        '长活（构建、装依赖、下载）别填或填大些；短命令（ls / git status 这类）填个几千毫秒，' +
        '免得一条挂死的命令把这一轮永远拖住。给 0 或负数不算「不设」，是参数错误。',
    },
  },
  required: ['cmd'],
  additionalProperties: false,
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
 * 被信号收掉（137）= 命令失败；**超时**（跑过了、被掐断）= 失败；没跑成（cwd 越界 ·
 * 启动失败）= 失败。**条条都不是「成功」**——回填一个 ok:true 会让模型以为事情办成了。
 *
 * ⚠️ 但**「失败」不止一种**：`ok:false` 只说明「这一趟没有一次成功的执行」，
 * 它**不区分**「跑了但没成」与「压根没跑」——那件事由 `reason` 说，措辞遂分两支
 * （见下面的注释）。把两者合成一句话，就是 D39 那个坑。
 */
function composeOutcome(result: ExecResult, signal: AbortSignal | undefined): ToolRunResult {
  // **没跑成**只有两例（cwd 越界 · 启动失败）——进程压根没起来，故没有输出、也没有耗时可言。
  // 超时**不在其列**：它跑了、被掐断了（见下），与这两例不是一回事（「命令跑过的结果与
  // 调用不成立分开」）——原先它跟着这一支走，于是被说成「未能执行」，D39 就是这儿来的。
  if (!result.ok && result.reason !== 'timeout') {
    return { ok: false, output: `exec 未能执行（${result.reason}）：${result.message}` }
  }

  // 正文**两支组装同一份**：跑过的命令，无论收尾是「跑完」还是「被掐断」，
  // 它已经说出来的话都照原样带上（`ok:true` 与超时两支的 `stdout` / `stderr` 同形同口径）。
  const blocks: string[] = []
  if (result.stdout !== '') blocks.push(result.stdout)
  if (result.stderr !== '') blocks.push(`[stderr]\n${result.stderr}`)
  if (result.truncated === true) {
    blocks.push(`[输出已截断（上限 ${EXEC_MAX_OUTPUT_BYTES} 字节）]`)
  }
  const body = blocks.join('\n')

  // 超时——**与取消同一口径**：抬头说「跑过了、被掐断」，已有输出照常带回。
  //
  // 这一支**排在取消之前**，两条互斥由**构造**保证：`reason:'timeout'` 只可能来自沙箱那条
  // 自持计时器，而取消那一路沙箱报的是 `ok:true · exit 137`（永远走不到这里）。于是
  // **同一次 `Ctrl+C` 又赶上到点**时，说出来的也只会是其中一句，不会两句打架。
  //
  // 不用沙箱那句 `message`（「命令超时（Nms）未完成——已终止」）：它与抬头**同一件事**，
  // 再说一遍就是重复；抬头要的那个数直接取自结果里**真报了的那条上界**。
  // 这一支同样**不带 `[exit N]`**——退出码（137）是收命的产物，不是命令自己跑出来的结果。
  if (!result.ok) {
    const head = execTimedOutOutput(result.timeoutMs)
    return { ok: false, output: body === '' ? head : `${head}\n${body}` }
  }

  // 取消事实由**调用方自持的 signal** 判定（U05 口径：三个 reason 都是「沙箱坏了」，
  // 取消不是——不挤进 reason，故在这里据 signal 归位）。命令已经产出的输出照常带回。
  //
  // 这一支**不带 `[exit N]`**：退出码是信号的产物（137），抬头的「已取消」已经把事实
  // 说全了——再摆一个退出码只会让模型以为「命令跑完了、失败在 137」。两支互斥之下，
  // 正文里的元信息始终只说模型推不出来的那一件。
  if (signal?.aborted === true) {
    return {
      ok: false,
      output: body === '' ? OUTPUT_CANCELED_RUNNING : `${OUTPUT_CANCELED_RUNNING}\n${body}`,
    }
  }

  if (result.exit !== 0) blocks.push(`[exit ${result.exit}]`)

  return { ok: result.exit === 0, output: blocks.join('\n') }
}

/**
 * 超时参数取用——**模型给的外部输入**，故验在边界（与 `cmd` 同一处）。
 *
 * 三档（与 `sandbox.ts` 那侧的归一同一个口径，但那一侧宽容、这一侧要**报错**）：
 * 不填 / `null` ＝ 不设上界；正有限数 ＝ 等它这么久；**其余一律参数错**。
 * 这一侧**不宽容**是对的：模型写错了，它应当收到一句能照着改的话，
 * 而不是让它以为「反正沙箱会兜住」——兜出来的那一种语义（无上界）也不是它想要的那个。
 */
function readTimeout(value: unknown): { readonly ms: number | null } | { readonly bad: true } {
  if (value === undefined || value === null) return { ms: null }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { bad: true }
  return { ms: value }
}

/** 造 `exec` 的工具定义。 */
export function defineExecTool(): ToolDefinition {
  const row = rowOf('exec')

  return {
    spec: { name: row.name, summary: row.summary, parameters: EXEC_PARAMETERS, danger: row.danger },

    async run(args, ctx): Promise<ToolRunResult> {
      const cmd = args.cmd
      if (typeof cmd !== 'string' || cmd.trim() === '') {
        return { ok: false, output: OUTPUT_EXEC_NO_CMD }
      }

      const timeout = readTimeout(args.timeoutMs)
      if ('bad' in timeout) return { ok: false, output: OUTPUT_EXEC_BAD_TIMEOUT }

      const result = await ctx.sandbox.exec(cmd, {
        // **不填就是 null**——不是「让沙箱自己看着办」：沙箱那一侧缺省也是无上界，
        // 但把话说明白，读的人不必再翻一层才知道这一趟到底设没设上界。
        timeoutMs: timeout.ms,
        maxOutputBytes: EXEC_MAX_OUTPUT_BYTES,
        onOutput: ctx.onOutput,
        signal: ctx.signal,
      })

      return composeOutcome(result, ctx.signal)
    },
  }
}
