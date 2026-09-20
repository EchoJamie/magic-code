#!/usr/bin/env bun
/**
 * 界面验收工具 · 命令行入口（U40）——**薄的一层**：解析参数、调用共用驱动。
 *
 * 本文件**不复制任何驱动逻辑**（驱动在 `test/ui/`）：这里只有「读哪几个参数、
 * 打哪几行字、退什么码」。三条子命令：
 *
 * ```
 * bun packages/app/scripts/ui.ts list                          # 场景一览
 * bun packages/app/scripts/ui.ts run <场景> [--out <目录>]      # 跑一组场景
 * bun packages/app/scripts/ui.ts serve [--out <目录>]           # 常驻：stdin 逐行 JSON ←→ stdout 逐行 JSON
 * ```
 *
 * ⚠️ 这是**研发设施**，不是产品命令：`magic --help` 里没有它，产品命令也不认它。
 */

import { createControl, runScenario, scenarioNames } from '../test/ui/index.ts'
import type { ScenarioName } from '../test/ui/index.ts'

const USAGE = `界面验收工具（开发命令，不是产品命令）

用法：
  bun packages/app/scripts/ui.ts list
      列出六组代表场景的名字。

  bun packages/app/scripts/ui.ts run <场景> [--out <目录>] [--quiet]
      跑一组场景：起真应用、敲键、等屏上的条件、留现场，最后打印现场目录与查看页路径。
      退出码 0 ＝ 全部判据通过；1 ＝ 有判据没过（失败现场照样留在 --out 下）。

  bun packages/app/scripts/ui.ts serve [--out <目录>]
      常驻控制进程（助手那条入口）：**标准输入逐行读 JSON 命令、标准输出逐行写 JSON 答复**。
      命令带 id，答复带同一个 id；命令一条一条来（前一条没答复，后面的排队）。
      **stdin 到头（EOF）就收摊**：自己起的应用与端点一个不留，现场留在 --out 下。

      ⚠️ stdin 的条件（实测，别想当然）——**tty:false 起的进程 stdin 当场就是关的**
      （接到 /dev/null），serve 会立刻收到 EOF 收摊，当不了持续入口。两条可用姿势：
        ① tty:true 的 exec 会话，直接把 JSON 行写进这个进程的 stdin（TTY 行输入实测可用）；
        ② 拿 cat 包一层：cat | bun packages/app/scripts/ui.ts serve --out <目录>
           （想让它一直活着就别给 Ctrl-D）。

参数：
  --out <目录>      产物根（缺省 <仓库>/.ui-runs；每次运行一个子目录，不覆盖旧的）
  --quiet           run 时不逐条打判据（只打结论）
`

type Args = {
  readonly command: string
  readonly rest: readonly string[]
  readonly flags: Record<string, string | true>
}

function parseArgs(argv: readonly string[]): Args {
  const [command = 'help', ...tail] = argv
  const rest: string[] = []
  const flags: Record<string, string | true> = {}

  for (let at = 0; at < tail.length; at += 1) {
    const arg = tail[at] as string
    if (!arg.startsWith('--')) {
      rest.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split('=')
    if (inline !== undefined) {
      flags[name as string] = inline
      continue
    }
    const next = tail[at + 1]
    if (name === 'quiet') {
      flags['quiet'] = true
      continue
    }
    if (next === undefined || next.startsWith('--')) {
      flags[name as string] = true
      continue
    }
    flags[name as string] = next
    at += 1
  }

  return { command, rest, flags }
}

/** 产物根缺省——仓库里的 `.ui-runs/`（`.gitignore` 已忽略），不是临时目录。 */
function artifactsOf(flags: Args['flags']): string | undefined {
  const out = flags['out']

  return typeof out === 'string' ? out : undefined
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  switch (args.command) {
    case 'list': {
      for (const name of scenarioNames()) await print(name)
      return 0
    }

    case 'run': {
      const name = args.rest[0]
      if (name === undefined) {
        await printErr('run 要给场景名（先跑 list 看有哪些）')
        return 1
      }
      if (!scenarioNames().includes(name as ScenarioName)) {
        await printErr(`不认得的场景「${name}」——有的是：${scenarioNames().join(' / ')}`)
        return 1
      }

      const quiet = args['quiet'] === true
      const artifacts = artifactsOf(args.flags)
      const result = await runScenario(name as ScenarioName, {
        ...(artifacts === undefined ? {} : { artifacts }),
        ...(quiet
          ? {}
          : {
              onCheck: (outcome) => {
                void print(`  ${outcome.ok ? '✓' : '✗'} ${outcome.what}${outcome.detail === '' ? '' : `（${outcome.detail}）`}`)
              },
            }),
      })

      await print('')
      await print(`${result.ok ? '通过' : '没过'} · ${result.name} · ${result.title}`)
      await print(`  依据　${result.anchors}`)
      await print(`  判据　${result.checks.filter((check) => check.ok).length}/${result.checks.length} 条通过`)
      if (result.failure !== undefined) {
        await print(`  挂在哪　${result.failure.what}：${result.failure.detail}`)
      }
      if (result.lastScreen !== undefined) {
        await print(`  最后那一眼：`)
        for (const line of result.lastScreen) await print(`    ${line}`)
      }
      for (const dir of result.runDirs) await print(`  现场　${dir}`)
      for (const viewer of result.viewers) await print(`  查看页　${viewer}`)

      return result.ok ? 0 : 1
    }

    case 'serve': {
      const face = createControl({
        ...(artifactsOf(args.flags) === undefined ? {} : { artifacts: artifactsOf(args.flags) as string }),
        // 诊断走 stderr，**绝不混进控制协议**（stdout 上只有 JSON 行）
        log: (line) => console.error(`[ui] ${line}`),
      })

      let chain: Promise<void> = Promise.resolve()
      const submit = (line: string): void => {
        // 一条一条来：正在处理的那条没答复之前，后面的排队（答复次序即请求次序）
        chain = chain.then(async () => {
          const reply = await face.handle(line)
          await Bun.write(Bun.stdout, `${reply}\n`)
        })
      }

      const shutdown = async (reason: string): Promise<void> => {
        console.error(`[ui] 收摊（${reason}）`)
        // 先把在途那条答完，再收摊——答复次序即请求次序，收摊不该把最后一句吞掉
        await chain
        await face.closeAll()
      }

      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          // ⚠️ 信号来了得**自己退场**：主流程正堵在那根 stdin 的读上（它只认 EOF），
          // 而挂了处理器之后信号本身不再杀进程——不 exit 就永远停在那儿
          // （实测：自动用例 finally 里 `serve.kill()` 之后进程不死，`await exited` 没回音）
          void shutdown(signal).then(() => process.exit(0))
        })
      }

      console.error('[ui] 控制通道就绪：stdin 逐行 JSON 命令 ←→ stdout 逐行 JSON 答复')

      // 命令源**只有 stdin 一根**（TTY 与管道同一支读法：TTY 那条由终端按行交上来）。
      // 管道那头关了 / TTY 上敲了 Ctrl-D ⇒ 循环自然退出 ⇒ 收摊
      const decoder = new TextDecoder()
      let buffered = ''
      for await (const chunk of process.stdin) {
        buffered += decoder.decode(chunk as Uint8Array, { stream: true })
        let at = buffered.indexOf('\n')
        while (at !== -1) {
          const line = buffered.slice(0, at)
          buffered = buffered.slice(at + 1)
          if (line.trim() !== '') submit(line)
          at = buffered.indexOf('\n')
        }
      }

      await shutdown('stdin 到头了')
      return 0
    }

    default: {
      await print(USAGE)
      return args.command === 'help' || args.command === '--help' ? 0 : 1
    }
  }
}

async function print(line: string): Promise<void> {
  await Bun.write(Bun.stdout, `${line}\n`)
}

async function printErr(line: string): Promise<void> {
  await Bun.write(Bun.stderr, `${line}\n`)
}

process.exit(await main())
