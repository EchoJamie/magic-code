#!/usr/bin/env bun
/**
 * `magic` —— 命令行入口（可执行名，技术方案 · 工程结构）。
 *
 * 三件活，都不承载逻辑：
 * - **默认**——装配 → **起真外壳**（`@magic/tui`，U09）。装配根只做「接线 ＋ 起外壳」：
 *   **交互逻辑全在 `@magic/tui`**，本入口一行呈现都不写（装配视图第 5 步）。
 * - **`--script <文件>`**——装配 → 接**脚本化驱动**（`./shell.ts`）→ 按脚本放开输入 →
 *   打印持久类事件的 JSONL 轨迹（瞬时增量是渲染用的，塞进终端只会淹掉轨迹，故不印）。
 * - **`--check`**——装配一次并报一份自检（配置来处 · 数据落点 · 工作区根 · 会话 · 模型），
 *   然后收尾。装配成不成，本身就是一次全链体检：网关构造缺 key 即抛、工作区根不存在即抛、
 *   数据目录不可写即抛——都在这一跑里现形。
 */

import type { KernelEvent } from '@magic/contracts'
import { runTui } from '@magic/tui'
import { assemble } from './assembly.ts'
import type { Assembly } from './assembly.ts'
import { ConfigError, describeConfig } from './config.ts'
import { runShellScript } from './shell.ts'
import type { ShellScript } from './shell.ts'

const USAGE = `magic —— 软件工程智能体（首站）

用法：
  magic                  起外壳（TUI）——装配 → 接控制面 → 一屏
  magic --check          装配自检（读 ~/.magic/config.json，全链构造一遍后收尾）
  magic --script <文件>  无人值守跑一段脚本，打印事件轨迹（JSONL）与摘要
  magic --help           本说明

脚本文件（JSON）：
  { "inputs": ["在 playground 里跑 ls"], "decisions": ["approve"] }
  —— inputs：按序发出的交代；decisions：裁决答复（按询问次序取，用尽＝批准）。
     ⚠️ 无人值守替人批准是**验收装置的方便**，不是产品行为（阶段 1 一律人工门）。
`

type Args = { readonly help: boolean; readonly check: boolean; readonly script?: string | undefined }

function parseArgs(argv: readonly string[]): Args {
  let script: string | undefined
  let check = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true, check: false }
    if (arg === '--check') {
      check = true
      continue
    }
    if (arg === '--script') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--script 缺文件路径（见 magic --help）')
      }
      script = value
      i += 1
      continue
    }
    throw new Error(`不认得的参数「${arg}」（见 magic --help）`)
  }

  return { help: false, check, script }
}

/** 读脚本文件——`Bun.file` 是 fs 触达，本包（装配根）在守护的域外，用得起（见守护注）。 */
async function readScript(path: string): Promise<ShellScript> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`脚本文件不存在：${path}`)

  const parsed: unknown = JSON.parse(await file.text())
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`脚本须是对象：${path}`)

  const inputs = (parsed as { inputs?: unknown }).inputs
  if (!Array.isArray(inputs) || inputs.some((item) => typeof item !== 'string')) {
    throw new Error(`脚本的 inputs 须是字符串数组：${path}`)
  }

  return parsed as ShellScript
}

async function countEntries(assembly: Assembly): Promise<number> {
  let count = 0
  for await (const _entry of assembly.records.serviceFor(assembly.session).readEntries(assembly.session)) {
    count += 1
  }
  return count
}

/** 装配自检——**报「在哪、是谁」，不报 key**（key 永不落日志）。 */
function report(assembly: Assembly): void {
  console.log('magic —— 装配自检')
  console.log(`  ${describeConfig(assembly.config)}`)
  console.log(`  工作区根　${assembly.workspaceRoot}（首站单根＝启动目录）`)
  console.log(`  会话　　　${assembly.session}`)
  console.log(`  数据落点　${assembly.paths.database}`)
  console.log(`             ${assembly.paths.blobs}/`)
  console.log('  工具集　　exec（阶段 1 唯一工具——经沙箱 · 途中过闸门）')
  // 权限规则（阶段 2）——**规则真的接进闸门了**吗、有没有被拒的条目，自检里说清楚
  console.log(`  权限规则　${describeRules(assembly)}`)
  console.log('  外壳　　　@magic/tui（U09 已到站）——无参启动即起它；本自检由 --check 触发')
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
  })

  console.log(
    `—— 会话 ${assembly.session} · 事件 ${handle.events.length} 条 · ` +
      `条目 ${await countEntries(assembly)} 条 · 裁决 ${handle.decisions.length} 次`,
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
    if (args.script !== undefined) {
      await runScript(assembly, args.script)
      return 0
    }

    if (args.check) {
      report(assembly)
      return 0
    }

    // 默认：起真外壳——装配只做「接线 ＋ 起外壳」，交互逻辑全在 @magic/tui
    const tui = runTui({ transport: assembly.shell })
    await tui.waitUntilExit()
    return 0
  } finally {
    assembly.close()
  }
}

process.exit(await main())
