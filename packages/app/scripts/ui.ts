#!/usr/bin/env bun
/**
 * 界面验收工具 · 命令行入口（U40）——**薄的一层**：解析参数、调用共用驱动。
 *
 * 本文件**不复制任何驱动逻辑**（驱动在 `test/ui/`）：这里只有「读哪几个参数、
 * 打哪几行字、退什么码」。四条子命令：
 *
 * ```
 * bun packages/app/scripts/ui.ts list                                    # 场景一览
 * bun packages/app/scripts/ui.ts run <场景> [--out <目录>] [--quiet]      # 跑一组场景
 * bun packages/app/scripts/ui.ts serve [--control <目录>] [--out <目录>]   # 常驻：逐行 JSON
 * bun packages/app/scripts/ui.ts request --control <目录> '<JSON>'        # 向常驻进程发一条
 * ```
 *
 * ⚠️ 这是**研发设施**，不是产品命令：`magic --help` 里没有它，产品命令也不认它。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendReply,
  createControl,
  listControlDir,
  openFifoStream,
  prepareControlDir,
  runScenario,
  scenarioNames,
  sendRequest,
} from '../test/ui/index.ts'
import type { ControlDir, ScenarioName } from '../test/ui/index.ts'

const USAGE = `界面验收工具（开发命令，不是产品命令）

用法：
  bun packages/app/scripts/ui.ts list
      列出六组代表场景的名字。

  bun packages/app/scripts/ui.ts run <场景> [--out <目录>] [--quiet]
      跑一组场景：起真应用、敲键、等屏上的条件、留现场，最后打印现场目录与查看页路径。
      退出码 0 ＝ 全部判据通过；1 ＝ 有判据没过（失败现场照样留在 --out 下）。

  bun packages/app/scripts/ui.ts serve [--control <目录>] [--out <目录>]
      常驻控制进程：逐行读 JSON 命令、逐行写 JSON 答复。
      给了 --control <目录> ⇒ 命令源是那根 in.fifo（助手那条路：另起进程往里写）；
      没给 ⇒ 命令源是 stdin（管道），stdin 到头就收摊。

  bun packages/app/scripts/ui.ts request --control <目录> '<一行 JSON>' [--timeout <毫秒>]
      薄客户端：把这一行写进控制通道，等同一个 id 的答复，打印它，按 ok 退 0 / 1。

参数：
  --out <目录>      产物根（缺省 <仓库>/.ui-runs；每次运行一个子目录，不覆盖旧的）
  --control <目录>  控制目录（in.fifo · out.ndjson · seq · events.ndjson）
  --timeout <毫秒>  request 等答复的上限（缺省 30000）
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
      const control = args.flags['control']
      const events: string[] = []
      const controlDir: ControlDir | null =
        typeof control === 'string' ? prepareControlDir(control) : null
      const eventsPath = controlDir === null ? null : join(controlDir.dir, 'events.ndjson')
      if (eventsPath !== null) mkdirSync(controlDir?.dir as string, { recursive: true })

      const face = createControl({
        ...(artifactsOf(args.flags) === undefined ? {} : { artifacts: artifactsOf(args.flags) as string }),
        // 诊断走 stderr，**绝不混进控制协议**（stdout 上只有 JSON 行）
        log: (line) => console.error(`[ui] ${line}`),
        onEvent: (event) => {
          const line = JSON.stringify(event)
          events.push(line)
          if (eventsPath !== null) appendFileSync(eventsPath, `${line}\n`, 'utf8')
        },
      })

      let chain: Promise<void> = Promise.resolve()
      const submit = (line: string): void => {
        // 一条一条来：正在处理的那条没答复之前，后面的排队（答复次序即请求次序）
        chain = chain.then(async () => {
          const reply = await face.handle(line)
          await Bun.write(Bun.stdout, `${reply}\n`)
          if (controlDir !== null) appendReply(controlDir, reply)
        })
      }

      let stop: (() => void) | null = null
      const ended = new Promise<void>((resolve) => {
        stop = resolve
      })
      const shutdown = async (reason: string): Promise<void> => {
        console.error(`[ui] 收摊（${reason}）`)
        await chain
        await face.closeAll()
        stop?.()
      }

      if (controlDir !== null) {
        // FIFO 当 stdin：写端关了也不 EOF（读写打开），故**它不触发收摊**——
        // 收摊靠 `close` / SIGTERM / SIGINT（见文件头注与 README）
        openFifoStream(controlDir, submit)
        console.error(`[ui] 控制通道就绪：${controlDir.fifo}（答复写 ${controlDir.out}）`)
      }

      // ⚠️ 给了 `--control` 就**不接 stdin**：命令源已经定了是那根 FIFO——
      // 再挂一根 stdin 的话，后台起它时（stdin 是 /dev/null）当场就是一次 EOF，
      // 「收摊（stdin 到头了）」比第一条命令还早（实测踩过）
      if (controlDir === null && process.stdin.isTTY !== true) {
        // 管道那条 stdin：**EOF 就是收摊信号**（工单点名要的一条）
        void (async () => {
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
        })()
      } else if (controlDir === null) {
        await printErr('serve 要一根 stdin（管道）或一个 --control <目录>——两样都没有就无事可做')
        return 1
      }

      if (controlDir !== null) {
        console.error('[ui] 命令源＝控制目录那根 FIFO（stdin 不接）')
      }

      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          void shutdown(signal)
        })
      }

      await ended
      return 0
    }

    case 'request': {
      const control = args.flags['control']
      const line = args.rest[0]
      if (typeof control !== 'string') {
        await printErr('request 要给 --control <目录>（serve 起的那个控制目录）')
        return 1
      }
      if (line === undefined) {
        await printErr('request 要给一行 JSON，如 \'{"cmd":"capture","label":"看一眼"}\'')
        return 1
      }

      // 那一头不在了就**早点说**（别让人对着一行 JSON 发呆）
      if (!listControlDir(control).includes('in.fifo')) {
        await printErr(`控制目录里没有 in.fifo：${control}——先起 serve --control ${control}`)
        return 1
      }

      let command: Record<string, unknown>
      try {
        command = JSON.parse(line) as Record<string, unknown>
      } catch (error) {
        await printErr(`这不是合法 JSON：${String(error)}`)
        return 1
      }

      const timeoutMs = typeof args.flags['timeout'] === 'string' ? Number(args.flags['timeout']) : 30_000
      try {
        const { reply } = await sendRequest(
          { dir: control, fifo: join(control, 'in.fifo'), out: join(control, 'out.ndjson'), seq: join(control, 'seq') },
          command,
          timeoutMs,
        )
        await print(JSON.stringify(reply))

        return reply.ok ? 0 : 1
      } catch (error) {
        await printErr(error instanceof Error ? error.message : String(error))
        return 1
      }
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
