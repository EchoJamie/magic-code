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
 * **工作目录**：cwd 缺省为默认根；工具入口在裁决前解析真实目录，执行时核对目标。
 *
 * **超时那一把**（U69）——`timeoutMs` 是**唯一**一处「模型自己定系统量」的参数：它知道手上
 * 这件事是 `ls` 还是一次构建，别人替不了它（见 `EXEC_PARAMETERS` 里那一项的描述）。
 *
 * **后台那一形**（U70）——`background` 这个布尔位把这一条命令**交出去**：不占着这一轮，
 * 进程接着跑，回执给「id ＋ 输出文件路径」（设计 · 工具执行与权限 · 六格）。本文件只做
 * **发起那一格**：起 · 停归执行域（`BackgroundRuns`），「跑完回一条给模型」归装配那一层
 * （登记在进程真退出时发）——三条界线都在各自那一处写着，此处不重复判。
 *
 * ⚠️ **两把别一起给**：交出去的命令没有「等它多久」这一说，`background` 那一支**不读**
 * `timeoutMs` ⇒ 一起给就是**参数错**——不静默把模型给的那个上界丢掉
 * （见 `OUTPUT_EXEC_BACKGROUND_WITH_TIMEOUT` 的注）。
 */

import type { ExecResult, SudoPlan } from '@magic/contracts'
import { isAbsolute, join } from 'node:path'
import {
  backgroundStarted,
  backgroundStartFailed,
  OUTPUT_BACKGROUND_UNSUPPORTED,
  OUTPUT_CANCELED_RUNNING,
  execMovedToBackground,
  execTimedOutOutput,
  OUTPUT_EXEC_BACKGROUND_WITH_TIMEOUT,
  OUTPUT_EXEC_BAD_TIMEOUT,
  execNoCommandOutput,
  OUTPUT_SUDO_CANCELED,
  OUTPUT_SUDO_NO_CHANNEL,
  sudoAuthFailedOutput,
} from './messages.ts'
import { defineTool } from './registry.ts'
import type { ToolDefinition, ToolRunContext, ToolRunResult } from './registry.ts'
import { refused, rowOf } from './toolkit.ts'

/**
 * 输出上限常量——每道流各 64 KiB（**每道流各自计**照 U05 口径）。
 *
 * ⚠️ **超时那一件没有对应的常量了**（U69 撤的）——那是**参数**，不是常量，见文件头注。
 *
 * 注意它**不是**大块转存的阈值（见 `blobs.ts` 头注）：上限管「命令能产出多少」——
 * 超了截断；阈值管「记录怎么存」——超了转存。两者互不代替。
 *
 * ⚠️ **这个数管「留多少」，不管「留哪一头」**——越限时留哪一头归沙箱（U93：**头尾都留**，
 * 中段省掉并在省略处写明，见 `execution/src/exec.ts` 的 `drain`）。要动这个数**另议**。
 */
export const EXEC_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * 参数模式——`JsonSchema` 在契约里是「可序列化的不透明模式」（承载形态未定），
 * 故这里写一份朴素的 JSON Schema：送得出去、也读得懂，不赌任何库。
 * 键名照契约「参数键」锚定：`command` 是**唯一必填**的那把（命令写在哪儿只有一处），
 * 其余三把都可省。
 *
 * **为什么是 `command` 而不是 `cmd`**：主流 shell 工具都用 `command`（Claude Code、Codex、
 * Gemini CLI、SWE-agent），模型被训练成写它；而 `cmd` 是全表唯一的缩写，工具集里其余键
 * 全是直白名词（path / pattern / content / old / new）。一次错键的代价是一整轮
 * （重写调用 ＋ 错误进上下文 ＋ 重新规划），远比键名本身那一个 token 贵。
 *
 * `description` 是给人看的：审批时屏上显示它、记录里也留一行——模型顺手把意图写成一句话，
 * 替审批者省掉「这串命令要干什么」的推断。
 */
export const EXEC_PARAMETERS = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description:
        '要执行的命令（经 shell 解释）。默认在当前会话目录下执行；命令里的 cd 会更新会话目录，' +
        '下一条命令接着在那里跑。命令里的 export 只影响本条。',
    },
    description: {
      type: 'string',
      maxLength: 160,
      description: '这条命令要做什么，一句话（工具行上显示给用户看，也进执行记录）；不参与执行。',
    },
    cwd: {
      type: 'string',
      minLength: 1,
      pattern: '\\S',
      description: '只在这一条要换目录时给：相对默认目录，绝对路径也可。不填就在会话目录下跑。',
    },
    /**
     * 超时——**管的是「等它多久」**，不是「它能跑多久」：到点命令已跑出的输出照样带回。
     *
     * `['number', 'null']` 是**有意的**：`null` 就是「不设上界」那个写法，写进模式里，
     * 模型才看得见「一直等」是一条**正当的**选择，而不是「忘了填」。`required` 不含它
     * ——**不填就是默认上界 120000**（见 `readTimeout`），`null` 才是「一直等」。
     * 不用 `0`：读起来像「立刻超时」。
     */
    timeoutMs: {
      type: ['number', 'null'],
      exclusiveMinimum: 0,
      // 描述是**给模型读的说明书**（同 `file-tools.ts` 那一节的口径：它就是「这个键怎么用」），
      // 故与其余七件的描述同一副行文——**不夹 Markdown 记号**（星号会原样落到模型那边）。
      description:
        '最多等这条命令多久（毫秒）。不填＝120000（两分钟）：到点命令还没结束，就把它转成后台运行' +
        '（回执给你后台编号与输出文件，结束后会通知你），不是「没执行」，也不是「杀掉了」。' +
        '要它一直等到自己结束就写 null。长活（构建、装依赖、下载）填大一些，或用 background:true。' +
        '给 0 或负数不算「不设」，是参数错误。',
    },
  },
  required: ['command'],
  additionalProperties: false,
} as const

/**
 * **`exec` 的这一形另外那一位**（U70）——后台那一形的发起（六格的第一格）。
 *
 * ## 为什么是**叠加**，不是往 `EXEC_PARAMETERS` 里添一笔
 *
 * `EXEC_PARAMETERS` 这一个对象**归 U69 拥有**（它在那儿添超时那一项）——两单各改一遍
 * 同一个对象，迟早在那处撞车。故本单元只**在自己这一层叠上自己那一项**：命令那个键
 * 仍是 `EXEC_PARAMETERS` 里的 `command`（这一轮已从 `cmd` 改名），`background` 是这一形自己的开关。
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
        '需跨后续工具调用持续运行的 dev server / watch 使用 background:true；命令本身保持前台，不加 nohup 或末尾 &。' +
        '立刻回 id 与输出路径，仅表示已受理；另用有明确超时的健康检查确认启动。日志按需要用 read、tail、grep 或 sed 读取。' +
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
 * 被信号收掉（137）= 命令失败；**超时**（跑过了、被掐断）= 失败；没跑成（目标改变 ·
 * 启动失败）= 失败。**条条都不是「成功」**——回填一个 ok:true 会让模型以为事情办成了。
 *
 * ⚠️ 但**「失败」不止一种**：`ok:false` 只说明「这一趟没有一次成功的执行」，
 * 它**不区分**「跑了但没成」与「压根没跑」——那件事由 `reason` 说，措辞遂分两支
 * （见下面的注释）。把两者合成一句话，就是 D39 那个坑。
 */
function composeOutcome(result: ExecResult, cwd: string | undefined): ToolRunResult {
  if (!result.ok && result.reason === 'spawn') return refused(`exec 未能执行（spawn）：${result.message}`)
  const blocks: string[] = []
  let status: string
  if (result.ok) status = `退出 ${result.exit}`
  else if (result.reason === 'timeout' && result.background !== undefined) {
    // 到点没跑完 ≠ 这条命令该被删掉：它接着跑，模型拿到编号与输出文件
    status = `未结束，已转后台 ${result.background.id}`
    blocks.push(execMovedToBackground(result.background.id, result.background.outputPath, result.timeoutMs))
  } else if (result.reason === 'timeout') {
    status = '超时，已按进程组收掉'
    blocks.push(result.cleanup?.confirmed !== false ? execTimedOutOutput(result.timeoutMs) : result.message)
  } else if (result.reason === 'canceled' && result.cleanup.confirmed) {
    status = '已取消'
    blocks.push(OUTPUT_CANCELED_RUNNING)
  } else {
    status = '未完成'
    blocks.push(result.message)
  }
  if (!result.ok && result.outputIncomplete) blocks.push('输出未收全；以下仅为已读取内容')
  if (result.stdout !== '') blocks.push(result.stdout)
  if (result.stderr !== '') blocks.push(`[stderr]\n${result.stderr}`)
  // 事实行（每次都有）：退出状态 ＋ **命令结束时真正所在的目录**——不必猜「我刚才在哪跑」。
  // **跑完的放最前面**（像终端的提示符）：正文一行不少地跟在后面，屏上那行摘要取的也是
  // 正文的末行。**没跑完的放最后**：那一趟首先要看的是「为什么」（超时 / 被拒 / 被取消），
  // 事实行是补充。
  // 目录取沙箱从 shell 退出钩子报回的那一个（`result.cwd`）；取不到才退回调用方给的。
  const actual = result.ok && result.cwd !== undefined ? result.cwd : cwd
  const fact = actual === undefined ? `[${status}]` : `[${status} · ${actual}]`
  const body = blocks.join('\n')
  const done = result.ok && result.exit === 0
  if (done) return { ok: true, output: body === '' ? fact : `${fact}\n${body}` }
  return { ok: false, output: body === '' ? fact : `${body}${body.endsWith('\n') ? '' : '\n'}${fact}` }
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
async function startBackground(cmd: string, ctx: ToolRunContext, cwd: string | undefined): Promise<ToolRunResult> {
  const runs = ctx.background
  if (runs === undefined) return refused(OUTPUT_BACKGROUND_UNSUPPORTED)

  const started = await runs.start(cmd, { cwd })
  if (!started.ok) return refused(backgroundStartFailed(started.reason))

  // `ok: true`——**交出去这件事做成了**（命令后来跑成什么样是另一件事，由那一声回执说）。
  // 这里报 false 会让模型以为「没跑」，而它其实正在跑。
  return { ok: true, output: backgroundStarted(started.id, started.outputPath) }
}

/**
 * 超时参数取用——**模型给的外部输入**，故验在边界（与 `cmd` 同一处）。
 *
 * 三档（与 `sandbox.ts` 那侧的归一同一个口径，但那一侧宽容、这一侧要**报错**）：
 * 不填 / `null` ＝ 不设上界；正有限数 ＝ 等它这么久；**其余一律参数错**。
 * 这一侧**不宽容**是对的：模型写错了，它应当收到一句能照着改的话，
 * 而不是让它以为「反正沙箱会兜住」——兜出来的那一种语义（无上界）也不是它想要的那个。
 */
function readTimeout(value: unknown): { readonly ms: number | null; readonly given: boolean } | { readonly bad: true } {
  if (value === undefined) return { ms: DEFAULT_TIMEOUT_MS, given: false }
  if (value === null) return { ms: null, given: true }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { bad: true }
  return { ms: value, given: true }
}

/** 缺省上界——两分钟（与 Claude Code 的 Bash 同一个数）。 */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * **sudo 专用认证**（U129）——密码只交给认证端口，工具域从不持有它。
 *
 * 认证通过才返回 `ok`；取消与失败各说各的，**都不启动原命令**、也不自动重试。
 */
async function authenticateSudo(
  plan: SudoPlan,
  ctx: ToolRunContext,
  cwd: string | undefined,
): Promise<ToolRunResult | 'ok'> {
  const auth = ctx.sudoAuth
  if (auth === undefined) return refused(OUTPUT_SUDO_NO_CHANNEL)
  try {
    const result = await auth.authenticate({
      command: plan.command,
      ...(cwd === undefined ? {} : { cwd }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    if (result.ok) return 'ok'
    return refused(result.reason === 'cancelled' ? OUTPUT_SUDO_CANCELED : sudoAuthFailedOutput(result.detail))
  } catch (error) {
    return refused(sudoAuthFailedOutput(error instanceof Error ? error.message : String(error)))
  }
}

/**
 * 后台起始目录——相对 `cwd` 以**会话目录**为基准（与前台同一条尺子）。
 *
 * 后台的 `start` 拿不到会话状态（它不属于沙箱实例），故在这里先化成绝对路径。
 */
function startCwdOf(cwd: string | undefined, ctx: ToolRunContext): string | undefined {
  if (cwd === undefined || isAbsolute(cwd)) return cwd
  const session = ctx.sandbox.sessionCwd?.()
  return session === undefined ? cwd : join(session, cwd)
}

/** 造 `exec` 的工具定义。 */
export function defineExecTool(): ToolDefinition {
  const row = rowOf('exec')
  return defineTool({
    spec: { name: row.name, summary: row.summary, parameters: EXEC_PARAMETERS_WITH_BACKGROUND, danger: row.danger },
    prepare(args) {
      const command = args.command
      if (typeof command !== 'string' || command.trim() === '') throw new Error(execNoCommandOutput(Object.keys(args)))
      const description = args.description
      if (description !== undefined && typeof description !== 'string') throw new Error('参数错误：description 须为字符串')
      const timeout = readTimeout(args.timeoutMs)
      if ('bad' in timeout) throw new Error(OUTPUT_EXEC_BAD_TIMEOUT)
      const cwd = args.cwd
      if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '')) throw new Error('参数错误：cwd 须为非空字符串')
      const background = args.background
      if (background !== undefined && typeof background !== 'boolean') throw new Error('参数错误：background 须为布尔值')
      // 只拦**显式**给了上界又要求后台的一对；不填超时现在有缺省值，不该因此判错
      if (background === true && timeout.given && timeout.ms !== null) throw new Error(OUTPUT_EXEC_BACKGROUND_WITH_TIMEOUT)
      return { command, description, cwd, background, timeoutMs: background === true ? null : timeout.ms }
    },
    async run(args, ctx): Promise<ToolRunResult> {
      // **会话目录**——模型没给 cwd 就用沙箱记着的那个（命令里的 cd 会更新它）。
      // 于是「我在哪」不是每条都要模型判断的参数，而是执行环境自己的状态。
      const cwd = args.cwd ?? ctx.sandbox.sessionCwd?.()
      // sudo 先认证、再执行；认证没通过时原命令一个字节都不碰（U129）。
      // 实际交给沙箱的是 `plan.run`（`sudo` 后已插入 `-n`），不是模型原句。
      const plan = ctx.sudo
      if (plan !== undefined) {
        const authenticated = await authenticateSudo(plan, ctx, cwd)
        if (authenticated !== 'ok') return authenticated
      }
      const command = plan === undefined ? args.command : plan.run

      if (args.background === true) return startBackground(command, ctx, startCwdOf(cwd, ctx))
      // 契约上 `adopt` 是**可选**的一格：宿主只实现了 `start` 时不带它，超时照旧按进程组收掉
      // （不能凭「有 background 对象」就假定它会接管——那是宿主侧才看得见的能力）。
      const adopter = typeof ctx.background?.adopt === 'function' ? ctx.background : undefined
      const result = await ctx.sandbox.exec(command, {
        cwd: args.cwd, timeoutMs: args.timeoutMs, maxOutputBytes: EXEC_MAX_OUTPUT_BYTES,
        // 到点还没跑完 ⇒ 交出去接着跑（没接后台能力时沙箱按 kill 处置，行为与旧版一致）
        onTimeout: adopter === undefined ? 'kill' : 'background',
        ...(adopter === undefined ? {} : { adopt: run => adopter.adopt!(run) }),
        onOutput: ctx.onOutput, signal: ctx.signal,
      })
      const outcome = composeOutcome(result, cwd)
      // **会话目录变了**才报给外壳（显式 cwd 是一次性覆盖，不改会话目录）
      return args.cwd === undefined && result.ok && result.cwd !== undefined
        ? { ...outcome, cwd: result.cwd }
        : outcome
    },
  })
}
