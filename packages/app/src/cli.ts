#!/usr/bin/env bun
/**
 * `magic` —— 命令行入口（可执行名，技术方案 · 工程结构）。
 *
 * 三件活，都不承载逻辑：
 * - **默认**——装配 → **起真外壳**（`@magic/tui`，U09）。装配根只做「接线 ＋ 起外壳」：
 *   **交互逻辑全在 `@magic/tui`**，本入口一行呈现都不写（装配视图第 5 步）。
 * - **`--script <文件>`**——装配 → 接**脚本化驱动**（`./shell.ts`）→ 按脚本放开输入 →
 *   打印持久类事件的 JSONL 轨迹（瞬时增量是渲染用的，塞进终端只会淹掉轨迹，故不印）。
 * - **`--check`**——装配一次并报一份自检（配置来处 · 供应商表 · 数据落点 · 工作区根 · 会话 ·
 *   模型），然后收尾。装配成不成，本身就是一次全链体检：网关构造缺 key 即抛、
 *   工作区根不存在即抛、数据目录不可写即抛——都在这一跑里现形。
 * - **`--provider <id>` / `--model <名>`**——开局选中哪个供应商 / 模型（U17 · 运行时切换的
 *   启动参数那一入口）；会话中途换模型走 `--script` 的 `{ "switch": … }` 步骤。
 */

import type { KernelEvent } from '@magic/contracts'
import { TOOLSET_V1 } from '@magic/contracts'
import type { ModelSelection, ModelSwitchRequest, ModelSwitchResult } from '@magic/model'
import type { RunTuiOptions } from '@magic/tui'
import { assemble } from './assembly.ts'
import type { Assembly } from './assembly.ts'
import { ConfigError, describeConfig } from './config.ts'
import { runShellScript } from './shell.ts'
import type { ShellScript } from './shell.ts'

const USAGE = `magic —— 软件工程智能体

用法：
  magic                        打开交互界面，用自然语言交代活
  magic --session <id>         接着一条已有的会话干
  magic --provider <id>        开局用哪个供应商（配置里 providers 的条目名）
  magic --model <名>           开局用哪个模型（也可以单独用，不带 --provider）
  magic -h, --help             显示这份帮助

接着上次的活，得说一声：不给 --session 就是新会话（直接敲 magic 也不会先建一条——
首条消息按下回车才开张）。--session 要的是 /session 列表里那串 id，且必须已经存在：
打错一个字母会报错退场，不会照 id 悄悄开一条空的（那样你会以为接上了，其实没有）。
接上之后先跑一次恢复（处置上次崩溃时没做完的那件事），恢复跑完才收你的输入。
开局没给 --provider / --model 就用配置里的缺省条目；中途换模型在界面里打 /model。

下面两条不是日常用法：
  magic --check                把配置、数据存哪、工作区、会话挨个查一遍，查完就退出
  magic --script <文件>        无人值守跑一段脚本，打印事件轨迹（JSONL）与摘要

脚本是一份 JSON：inputs 按序给交代（其中一步写成 {"switch": …} 就是中途换模型），
decisions 是替你给的答复。写法与实例见 README 的「脚本（--script）」一节。
脚本替你答复只是图个方便，不是产品行为——平时该定夺的仍是你。
`

type Args = {
  readonly help: boolean
  readonly check: boolean
  readonly script?: string | undefined
  /**
   * **显式接续**那条会话（`--session <id>`）——不给＝新会话（D4：启动不接续）。
   *
   * 它是**恢复入口**（`U25`）：给了 id ⇒ 装配开局装载它、`boot` 跑一次恢复
   * （处置在途、重建现场）。**由应用层受理**（`@magic/actions`）——受理在这里，
   * 编排在那儿，本文件只把 id 递过去。
   *
   * ⚠️ **给了它就得在库里**（U28）：`main` 里那一道校验（`records.hasSession`）——
   * 打错一个字母**报错退场**，不静默开一条空的（见 `main` 里那段注）。
   */
  readonly session?: string | undefined
  /** 开局的换模型请求（`--provider` / `--model` 的落地）——两件都没给即 `undefined`。 */
  readonly switch?: ModelSwitchRequest | undefined
}

function parseArgs(argv: readonly string[]): Args {
  let script: string | undefined
  let check = false
  let provider: string | undefined
  let model: string | undefined
  let session: string | undefined

  /** 取值——缺值 / 撞上另一个选项即报（`--provider --check` 这类笔误不该被当成名字）。 */
  const valueOf = (flag: string, index: number): string => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} 缺值（见 magic --help）`)
    }
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true, check: false }
    if (arg === '--check') {
      check = true
      continue
    }
    if (arg === '--script') {
      script = valueOf('--script', i)
      i += 1
      continue
    }
    if (arg === '--provider') {
      provider = valueOf('--provider', i)
      i += 1
      continue
    }
    if (arg === '--model') {
      model = valueOf('--model', i)
      i += 1
      continue
    }
    if (arg === '--session') {
      session = valueOf('--session', i)
      i += 1
      continue
    }
    throw new Error(`不认得的参数「${arg}」（见 magic --help）`)
  }

  return {
    help: false,
    check,
    script,
    session,
    ...(provider === undefined && model === undefined ? {} : { switch: { provider, model } }),
  }
}

/** 读脚本文件——`Bun.file` 是 fs 触达，本包（装配根）在守护的域外，用得起（见守护注）。 */
async function readScript(path: string): Promise<ShellScript> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`脚本文件不存在：${path}`)

  const parsed: unknown = JSON.parse(await file.text())
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`脚本须是对象：${path}`)

  const inputs = (parsed as { inputs?: unknown }).inputs
  if (!Array.isArray(inputs) || !inputs.every(isStep)) {
    throw new Error(
      `脚本的 inputs 须是数组，元素为字符串（交代）或 {"switch":{…}}（换模型）：${path}`,
    )
  }

  return parsed as ShellScript
}

/** 一步的形态判据——交代（字符串）或换模型（`{ switch: … }`）。 */
function isStep(value: unknown): boolean {
  if (typeof value === 'string') return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const step = (value as { switch?: unknown }).switch
  return typeof step === 'object' && step !== null && !Array.isArray(step)
}

async function countEntries(assembly: Assembly): Promise<number> {
  const session = assembly.session
  // 还没有会话（空手跑脚本）＝没有条目可数——不是 0 条，是**没这条会话**
  if (session === undefined) return 0

  let count = 0
  // 读不经会话实例（记录域的读面）——会话未定时也走这条路，两处同理
  for await (const _entry of assembly.records.readEntries(session)) count += 1

  return count
}

/**
 * 落地一次换模型——成功返回选中，失败返回 `undefined`（调用方退场）。
 *
 * 两条不成功的路都在这里说清楚：**没有注册表**（注入了替身网关）·
 * **切不动**（未知条目 / 空请求 / 缺 key——缘由由模型域给出，装配照转，不改写）。
 */
function applySwitch(assembly: Assembly, request: ModelSwitchRequest): ModelSelection | undefined {
  const models = assembly.models
  if (models === undefined) {
    console.error('这次装配没有供应商注册表（注入了替身网关）——换模型不适用')
    return undefined
  }

  const result = models.use(request)
  if (!result.ok) {
    console.error(`换模型不成功：${result.reason}`)
    return undefined
  }
  return result.selection
}

/** 装配自检——**报「在哪、是谁」，不报 key**（key 永不落日志）。 */
function report(assembly: Assembly): void {
  console.log('magic —— 装配自检')
  console.log(`  ${describeConfig(assembly.config)}`)
  console.log(`  供应商表　${describeProviders(assembly)}`)
  console.log(`  工作区根　${describeRoots(assembly)}`)
  // 会话（U27 · 随批小修 6）：**没有会话是常态**（D5：启动＝新会话，空手打开）——
  // 未处理的值不许直接印出来（此前这一行印的是字面 `undefined`，读的人只能猜是什么意思）
  console.log(`  会话　　　${assembly.session ?? '（还没有会话——首条消息按下回车才开张）'}`)
  console.log(`  数据落点　${assembly.paths.database}`)
  console.log(`             ${assembly.paths.blobs}/`)
  // 工具集——**从契约的冻结行现取**（技术方案 · 工具「工具集 v1」）：手抄一份就有对不上的那天
  //（本行曾写死「exec（阶段 1 唯一工具）」，工具集 v1 到站后它成了假话）
  console.log(
    `  工具集　　${TOOLSET_V1.map((row) => row.name).join(' / ')}` +
      `（${TOOLSET_V1.length} 件——经沙箱 · 途中过闸门）`,
  )
  // 权限规则（阶段 2）——**规则真的接进闸门了**吗、有没有被拒的条目，自检里说清楚
  console.log(`  权限规则　${describeRules(assembly)}`)
  // 项目规约（U32）——**哪儿有、有几份、有没有没进来的**（来源 / 范围 / 内容版本的按需诊断）
  console.log(`  项目规约　${describeProjectRules(assembly)}`)
  // 授权（U22）——`a` 点出来的那一类：**落在哪个文件、有几条、有没有陈旧的节**
  console.log(`  授权　　　${describeGrants(assembly)}`)
  console.log('  外壳　　　@magic/tui（U09 已到站）——无参启动即起它；本自检由 --check 触发')
}

/**
 * 供应商表那一行——「注册了几条、当前走哪条」。
 *
 * 注册表缺席（注入了替身网关）时明说，不留白：自检里的一行留白会让人以为是漏配。
 */
function describeProviders(assembly: Assembly): string {
  const models = assembly.models
  if (models === undefined) return '（本次装配注入了替身网关——没有注册表）'

  const entries = models.list()
  const table = entries.map((entry) => `${entry.id}（${entry.model}）`).join(' · ')
  const chosen = models.selection()
  const current =
    chosen === undefined
      ? `${models.defaultProviderId()}（缺省 · 模型名取自请求）`
      : `${chosen.provider}（${chosen.model}）`

  return `${entries.length} 条——${table} · 当前走 ${current}`
}

/**
 * 工作区根那一行（**多根** · 阶段 3）——**列表全列**，默认根标出来。
 *
 * 两条理由：**少列一条**用户就无从知道自己少注册了什么（自检的全部意义是「报在哪、是谁」）；
 * 而默认根不标出来，多根下「相对路径往哪落」就得靠猜——「平等平铺 ＋ 一个默认」里
 * 那个「默认」是**看得见**的一条，不是隐含约定。
 */
function describeRoots(assembly: Assembly): string {
  const roots = assembly.workspaceRoots
  const first = roots[0] as string // 注册面保证 ≥ 1 条
  const rest = roots.slice(1)
  // **来处**也要报——「为什么是这几条」正是用户要改配置时得先认得的那一格
  // （⚙️ 键在即接管：配置里写了就不并入启动目录；缺省才回落）
  const from = assembly.config.config.workspaceRoots === undefined
    ? '配置无 workspaceRoots · 缺省＝启动目录'
    : '来自配置 workspaceRoots'

  return rest.length === 0
    ? `${first}（默认根 · 单根 · ${from}）`
    : `${first}（默认根——相对路径与新文件落它） · 另注册 ${rest.length} 条：${rest.join(' · ')} · ${from}`
}

/**
 * 权限规则那一行——**被拒的条目要报出来**（解析从严：读不懂的不生效；不说＝用户对着一条
 * 不生效的规则发呆）。一条都没有时明说「无规则＝一律问」——那是阶段 1 的姿态，不是漏配。
 */
function describeRules(assembly: Assembly): string {
  const count = assembly.permissionRules.length
  const head = count === 0 ? '无（缺省＝一律问，阶段 1 姿态）' : `${count} 条（必闸禁区凌驾其上）`

  if (assembly.rejectedRules.length === 0) return head

  const reasons = assembly.rejectedRules
    .map((problem) => `第 ${problem.index + 1} 条：${problem.reason}`)
    .join('；')

  return `${head} · ⚠️ 被拒 ${assembly.rejectedRules.length} 条——${reasons}`
}

/**
 * 项目规约那一行（U32）——**报「哪儿有、有几份、有没有没进来的」**（来源 / 范围 / 内容版本的按需诊断）。
 *
 * 为什么口径是**各根一级**：自检是**开屏那一眼**，手上没有「这一轮在动哪儿」——目标是随
 * 使用长出来的（见契约 `ProjectRules.load`）。根一级（目录规约 ＋ 无条件规则）正是会话开局
 * 会送进上下文的那一批，报它才对得上「现在这样跑一跑，模型看得见什么」。
 *
 * **没进来的那几条一律列出来**（读不懂 / 被略过都要说）：规约是**一堆人各自在加**的散文件，
 * 「我写的那份到底生效没有」是这一行最该答的问题——静默吞掉它就等于让人对着空气使劲。
 *
 * **两类分开摆**（2026-09-20 裁）：`error`（坏了，要改）挂 ⚠️ 与条数；`choice`（原生顶掉同名的
 * 兼容规则、AGENTS 顶掉 CLAUDE）**不挂警报**——那是产品按设计做的选择，用户查得着就够了。
 * 混在一起数，会让每条兼容规则都变成一次假警报（启动那句回执也读的是同一份数据）。
 */
function describeProjectRules(assembly: Assembly): string {
  const load = assembly.readRules()
  const count = (kind: string): number => load.documents.filter((rule) => rule.kind === kind).length

  const roots = count('agents') + count('claude-md')
  const native = count('magic-rules')
  const compat = count('claude-rules')
  const extra = count('source')

  const head =
    load.documents.length === 0
      ? '无（放 AGENTS.md 或 .magic/rules/*.md 就来——根一级的这几份开局就会送到模型）'
      : `${load.documents.length} 份（目录规约 ${roots} · 原生规则 ${native} · 兼容规则 ${compat} · 补充来源 ${extra}）`

  const broken = load.problems.filter((problem) => problem.kind === 'error')
  const chosen = load.problems.filter((problem) => problem.kind === 'choice')
  const lines = [head]

  // **一条占两行**（路径一行、缘由一行），且**一条都不摞在一行里**：
  // 缘由里带着绝对路径与整句说明，摞起来一条就有一百四十来列——八十列的终端会从中间
  // 折断，而这一屏正是用户拿来对着改的地方，读不成行就等于没写。
  // 缩进照「数据落点」那一处的先例；缘由再往里让两格，让「说的是哪个文件」一眼分得开。
  const stated = (problems: typeof load.problems): string =>
    problems
      .map((problem) => `${CONTINUATION}· ${problem.path}\n${CONTINUATION}  ${problem.message}`)
      .join('\n')

  if (broken.length > 0) {
    lines.push(`${CONTINUATION}⚠️ 有 ${broken.length} 条没进来：`, stated(broken))
  }
  // 取舍那几条**照说、不报警**：想查「我写的那份为什么没在管」的人，看的就是这几行
  if (chosen.length > 0) {
    lines.push(`${CONTINUATION}另有 ${chosen.length} 条按规矩让位（原生优先 / 同目录两份取一）：`, stated(chosen))
  }

  return lines.join('\n')
}

/** 续行的缩进——与标签列对齐（照「数据落点」那一处的先例）。 */
const CONTINUATION = '             '

/**
 * 授权那一行（U22 · 技术方案 · 权限「授权的落点」）——**报三件**：本工作区有几条、
 * 文件在哪儿、有没有陈旧的节。
 *
 * 为什么要报**落点**：这个文件是**内核自持**的，且用户应当能一眼找到它、手改它、删它
 * （「安全相关的东西价值在一眼看全」）。故清单一列就是路径，不藏在别处。
 *
 * **陈旧的节**（路径已不在）单独说一句 —— 它们**不会被自动删**（`B11`：删用户数据不归内核），
 * 用户得知道有这么几节等着处置（撤销入口在 `/grants`）。
 */
function describeGrants(assembly: Assembly): string {
  const view = assembly.grantsView()
  const count = view.grants.length
  const head = count === 0 ? '无（批准时按 a 就是记一条）' : `${count} 条（本工作区）`

  const stale = view.stale.length === 0 ? '' : ` · ⚠️ 陈旧的节 ${view.stale.length} 个（路径已不在——/grants 里撤）`

  return `${head} · ${assembly.grantsPath}${stale}`
}

/**
 * **起外壳那一下的入参**——装配 → `runTui` 的全部接线就这一处。
 *
 * **导出是给用例锚的**（照 `scriptOptions` 的先例，缺陷 D16 那笔账）：状态行 ④ 的分母
 * （U20 留的位 · 本轮接的那一跳）落在**本文件的这一行**上，判据要是自己「照同样方式接一遍」
 * 就只咬住了装配那半边——**倒回这一行，用例照样绿**。故把这一处做成**可取件的接缝**：
 * 用例拿 `tuiOptions(assembly).contextWindow` 验，倒回 `contextWindow` 那一句当场红。
 *
 * 分母**从配置里读，不发命令**。⚠️ 别改成「开机发一次 `model.list`」：装配的 `listModels`
 * 会在没会话时 `session.new`（要开一张空壳才盖得出信封），与 D5「空手打开不占存储」相抵。
 * 条目没声明、内置表也不认得 ⇒ `null` ⇒ 屏上只报已用量——**不编**。
 */
export function tuiOptions(assembly: Assembly): RunTuiOptions {
  return {
    transport: assembly.shell,
    boot: () => assembly.boot(),
    contextWindow: assembly.contextWindow,
    // 窗长表（U30）：换模型之后外壳据它**当场**查新模型多长（内置表 ＋ 各条目自己的声明）。
    // 与上面那一格分工：那一格是**开机那一刻**的读数（外壳那时还不知道模型名，
    // 查不了表）；本表供**之后每一次切换**取材。
    windowTable: assembly.windowTable,
    // 工作区（U26）：列表按工作区分组要它认「别的项目」——与交给记录域的是**同一个值**
    // （`workspace.roots()`：realpath 后的规范形 · 声明序），一头锚进记录、一头用于认路。
    workspaceRoots: assembly.workspaceRoots,
    // 启动那几句（U22 · 审计第 13 条）：解析从严（读不懂的规则 / 授权**不生效**）原先
    // 只有 `--check` 会说，走 TUI 这条路**一声不响**。话由装配备好（`Assembly.notices`）、
    // 外壳落成记录区的一行回执——**空数组＝启动一句多余的话都不说**。
    receipts: assembly.notices,
  }
}

/**
 * 脚本驱动接的那几件——**导出是给用例锚的**（缺陷 D16 的判据要咬住本文件这一行接线，
 * 而不是只咬住装配那半边）。
 *
 * `onSwitch` **走装配那一条产出路径**（`assembly.switchModel`）：与命令面同一处产
 * `model.switched`（**落库**）——本文件不另存一份状态、也不直调注册表。
 */
export function scriptOptions(
  assembly: Assembly,
  onEvent: (event: KernelEvent) => void,
  /** 换成功时那一行人读的痕迹（真跑给 `console.log`；用例给空实现，别往测试输出里漏）。 */
  note: (line: string) => void = () => {},
): {
  readonly onEvent: (event: KernelEvent) => void
  readonly onSwitch: (request: ModelSwitchRequest) => ModelSwitchResult
  readonly boot: () => Promise<void>
} {
  return {
    onEvent,
    // **启动流转也接上**（U25）：给了 `--session` 就走恢复那一趟。不接的话
    // 「接续 + 恢复」这条链在无人值守里静默缺席——正是本单元要收掉的那种空白。
    boot: () => assembly.boot(),
    onSwitch: (request) => {
      const result = assembly.switchModel(request)
      if (result.ok) {
        note(`—— 换模型：走 ${result.selection.provider}（${result.selection.model}）`)
      }
      return result
    },
  }
}

async function runScript(assembly: Assembly, path: string): Promise<void> {
  const script = await readScript(path)

  const handle = await runShellScript(
    assembly.shell,
    script,
    scriptOptions(
      assembly,
      (event: KernelEvent) => {
        // 瞬时增量（model.delta / tool.output.delta）不印——它们是渲染用的
        if (event.kind === 'model.delta' || event.kind === 'tool.output.delta') return
        console.log(JSON.stringify(event))
      },
      (line) => console.log(line),
    ),
  )

  console.log(
    `—— 会话 ${assembly.session} · 事件 ${handle.events.length} 条 · ` +
      `条目 ${await countEntries(assembly)} 条 · 裁决 ${handle.decisions.length} 次 · ` +
      `换模型 ${handle.switches.length} 次`,
  )
  console.log(`   记录库 ${assembly.paths.database}（可直读全过程）`)
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  if (args.help) {
    console.log(USAGE)
    return 0
  }

  let assembly: Assembly
  try {
    // 启动目录——**只在配置没写 `workspaceRoots` 时**才当工作区根（键在即接管，U18）
    //
    // `--session` 从这儿进启动流转（U25 的恢复入口）：给了 id ⇒ 装配开局装载那条会话，
    // 随后外壳在「接好订阅之后、放开输入之前」调 `boot()` 跑一次恢复。
    assembly = assemble({ cwd: process.cwd(), session: args.session })
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`配置有问题：${error.message}`)
      return 1
    }
    throw error
  }

  try {
    // **`--session` 的那道校验**（U28 · 台账随批小修 8）：库里没有这条会话就**报错退场**。
    //
    // 由头：`--session s-typo` 照 id 装载一条**空的**——用户以为接上了，其实没有。
    // 判据＝**在不在库里**（会话是首写即建的，D5：库里没有＝**没有这条**，不是「它是空的」）。
    // 报法照**根校验的先例**（`--check` 那条一行话的通道）：说清是哪一条、该去哪儿拿 id。
    // 「报错不降级」指：**不许**照 id 造一条新的顶上去——那正是「以为接上了」的来处。
    //
    // ⚠️ 放在最前：开局选中（`--provider`）与自检都排它后面——**接不上就什么都不做**。
    if (args.session !== undefined && !assembly.records.hasSession(args.session)) {
      console.error(
        `没有这条会话：${args.session}——` +
          `--session 收的是会话 id（/session 列表里那串）；库里没有它，本次一步都没走`,
      )
      return 1
    }

    // 开局选中（`--provider` / `--model`）——**在放开输入之前**落地：开局那几轮就该走它，
    // 而不是第一轮走缺省、第二轮才换（那是「会话中途切换」，不是「开局指定」）
    if (args.switch !== undefined) {
      const selection = applySwitch(assembly, args.switch)
      if (selection === undefined) return 1
      console.log(`—— 本次走 ${selection.provider}（${selection.model}）`)
    }

    if (args.script !== undefined) {
      await runScript(assembly, args.script)
      return 0
    }

    if (args.check) {
      report(assembly)
      return 0
    }

    // 默认：起真外壳——装配只做「接线 ＋ 起外壳」，交互逻辑全在 @magic/tui。
    // `boot` ＝启动流转（应用层的恢复用例，对开局那条会话跑一次）：`runTui` 会在
    // **订阅之后、放开输入之前**跑它（渲染在订阅那一步之内——次序与「渲染前 / 后」无关，
    // 要紧的是**输入那一道闸**：恢复没跑完，回车不受理）
    // （装配纪律：恢复要发事件，外壳得先订上；反了就是用户能在恢复跑完前打字）
    // ⚠️ **`@magic/tui` 在这里才 import**（不放在文件顶上）——Ink ＋ React 那一整棵
    // 依赖树实测 **120.4ms**（`bench-boot.ts`），而 `--check` / `--script` 这两条路
    // **一帧都不画**，顶上那个静态 import 是让它们白付这笔账（`bun test` 同样白付）。
    // 起外壳这条路的账不变——它本来就要付。
    const { runTui } = await import('@magic/tui')
    const tui = await runTui(tuiOptions(assembly))
    await tui.waitUntilExit()
    return 0
  } finally {
    assembly.close()
  }
}

// **只有被当作入口跑时才真的跑**——`scriptOptions` 导出给用例锚，import 本文件不该起外壳
// （`bun src/cli.ts` / `bin` 都算「直接跑」，`import.meta.main` 为真）。
if (import.meta.main) process.exit(await main())
