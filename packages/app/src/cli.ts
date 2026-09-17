#!/usr/bin/env bun
/**
 * `magic` —— 命令行入口（可执行名，技术方案 · 工程结构）。
 *
 * 两件活，都不承载逻辑：
 * - **默认**——装配一次，报一份自检（配置来处 · 数据落点 · 工作区根 · 会话 · 模型），
 *   然后收尾。装配成不成，本身就是一次全链体检：网关构造缺 key 即抛、工作区根不存在即抛、
 *   数据目录不可写即抛——都在这一跑里现形。
 * - **`--script <文件>`**——装配 → **接外壳位** → 按脚本放开输入 → 打印持久类事件的
 *   JSONL 轨迹（瞬时增量是渲染用的，塞进终端只会淹掉轨迹，故不印）。
 *
 * 外壳（TUI）归 U09——本入口把控制面外壳侧一端交出去的地方就是它的接入点（见 `./shell.ts`
 * 文件头注）。**本文件不含呈现逻辑**：只把协议消息原样印出来。
 */

import type { KernelEvent } from '@magic/contracts'
import { assemble } from './assembly.ts'
import type { Assembly } from './assembly.ts'
import { ConfigError, describeConfig } from './config.ts'
import { runShellScript } from './shell.ts'
import type { ShellScript } from './shell.ts'

const USAGE = `magic —— 软件工程智能体（首站）

用法：
  magic                  装配自检（读 ~/.magic/config.json，全链构造一遍后收尾）
  magic --script <文件>  无人值守跑一段脚本，打印事件轨迹（JSONL）与摘要
  magic --help           本说明

脚本文件（JSON）：
  { "inputs": ["在 playground 里跑 ls"], "decisions": ["approve"] }
  —— inputs：按序发出的交代；decisions：裁决答复（按询问次序取，用尽＝批准）。
     ⚠️ 无人值守替人批准是**验收装置的方便**，不是产品行为（阶段 1 一律人工门）。
`

type Args = { readonly help: boolean; readonly script?: string | undefined }

function parseArgs(argv: readonly string[]): Args {
  let script: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
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

  return { help: false, script }
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
  console.log('  外壳位　　@magic/tui 未到站（U09）——本步用脚本驱动：magic --script <文件>')
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
    if (args.script === undefined) {
      report(assembly)
      return 0
    }

    await runScript(assembly, args.script)
    return 0
  } finally {
    assembly.close()
  }
}

process.exit(await main())
