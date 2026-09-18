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
import type { ModelSelection, ModelSwitchRequest } from '@magic/model'
import { runTui } from '@magic/tui'
import { assemble } from './assembly.ts'
import type { Assembly } from './assembly.ts'
import { ConfigError, describeConfig } from './config.ts'
import { runShellScript } from './shell.ts'
import type { ShellScript } from './shell.ts'

const USAGE = `magic —— 软件工程智能体（首站）

用法：
  magic                          起外壳（TUI）——装配 → 接控制面 → 一屏
  magic --check                  装配自检（读 ~/.magic/config.json，全链构造一遍后收尾）
  magic --script <文件>          无人值守跑一段脚本，打印事件轨迹（JSONL）与摘要
  magic --provider <id>          开局走哪个供应商条目（providers 的键）
  magic --model <名>             开局用哪个模型（同一条目上换模型，可单用）
  magic --help                   本说明

脚本文件（JSON）：
  { "inputs": ["在 playground 里跑 ls", { "switch": { "provider": "minimax-m2" } }, "刚才那个文件还在吗"],
    "decisions": ["approve"] }
  —— inputs：按序走的步骤——裸字符串＝一条交代（等它收束再走下一步）；
     { "switch": { "provider"?, "model"? } } ＝**会话中途换模型**（换接缝下游：
     上下文不丢、后续轮次走新条目）。两件都不给＝不知道要换什么，当场报错停下。
     decisions：裁决答复（按询问次序取，用尽＝批准）。
     ⚠️ 无人值守替人批准是**验收装置的方便**，不是产品行为（阶段 1 一律人工门）。
`

type Args = {
  readonly help: boolean
  readonly check: boolean
  readonly script?: string | undefined
  /** 开局的换模型请求（`--provider` / `--model` 的落地）——两件都没给即 `undefined`。 */
  readonly switch?: ModelSwitchRequest | undefined
}

function parseArgs(argv: readonly string[]): Args {
  let script: string | undefined
  let check = false
  let provider: string | undefined
  let model: string | undefined

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
    throw new Error(`不认得的参数「${arg}」（见 magic --help）`)
  }

  return {
    help: false,
    check,
    script,
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
  let count = 0
  for await (const _entry of assembly.records.serviceFor(assembly.session).readEntries(assembly.session)) {
    count += 1
  }
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
  console.log(`  工作区根　${assembly.workspaceRoot}（首站单根＝启动目录）`)
  console.log(`  会话　　　${assembly.session}`)
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

async function runScript(assembly: Assembly, path: string): Promise<void> {
  const script = await readScript(path)

  const handle = await runShellScript(assembly.shell, script, {
    onEvent: (event: KernelEvent) => {
      // 瞬时增量（model.delta / tool.output.delta）不印——它们是渲染用的
      if (event.kind === 'model.delta' || event.kind === 'tool.output.delta') return
      console.log(JSON.stringify(event))
    },
    // 会话中途换模型的落点——就是装配手上那张注册表（本文件不另存一份状态）
    onSwitch: (request) => {
      const models = assembly.models
      if (models === undefined) {
        return { ok: false, reason: '这次装配没有供应商注册表（注入了替身网关）' }
      }
      const result = models.use(request)
      if (result.ok) {
        // 人在看的痕迹（事件流里不会有——换模型是接缝下游的事，不产事件）
        console.log(`—— 换模型：走 ${result.selection.provider}（${result.selection.model}）`)
      }
      return result
    },
  })

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
    // 启动目录＝工作区根（首站单根）
    assembly = assemble({ cwd: process.cwd() })
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`配置有问题：${error.message}`)
      return 1
    }
    throw error
  }

  try {
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
    // `boot` ＝启动流转（对开局会话跑一次恢复）：`runTui` 会在**订阅之后、渲染之前**跑它
    // （装配纪律：恢复要发事件，外壳得先订上；反了就是用户能在恢复跑完前打字）
    const tui = await runTui({ transport: assembly.shell, boot: () => assembly.boot() })
    await tui.waitUntilExit()
    return 0
  } finally {
    assembly.close()
  }
}

process.exit(await main())
