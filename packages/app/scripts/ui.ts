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

      // 收摊：EOF / 信号 / 答复送不出去 / 控制读不动了，四条路汇到它。**只开始一次**，
      // 而且后到的**共享同一份**——等到真正收完为止。
      //
      // ⚠️ 别退回成一个 `closed` 布尔：那只能说明「收摊**开始了**」。第二路（第二个信号、
      //    同一跳里的 EOF、写失败）进来会**立刻 resolve**，调用方的 `then(process.exit)`
      //    就抢在 `closeAll` 前头退场——应用半途没人管，成了新的残留（规划侧预查点名的这条）。
      let closing: Promise<void> | undefined
      const shutdown = (reason: string): Promise<void> => {
        if (closing !== undefined) return closing

        closing = (async () => {
          console.error(`[ui] 收摊（${reason}）`)
          // 先把在途那条答完，再收摊——答复次序即请求次序，收摊不该把最后一句吞掉。
          // ⚠️ 但**答复本身炸了不能掀掉清场**：扔掉的 reject 会让这一句之后的
          //    `closeAll` 整段跳过，应用就留在机器上。（这是**能留下残留的形状之一**；
          //    D26 现场那七个的确定来源是「旧探针没有可靠回收自己起的应用」，
          //    本条不在那个归因里——别拿它去顶那笔账。）
          await chain.catch(() => {})
          await face.closeAll()
        })()

        return closing
      }

      let chain: Promise<void> = Promise.resolve()
      const submit = (line: string): void => {
        // **收尾一旦开始就不再受理**：`shutdown` 存的是**它调用那一刻**的链，
        // 这一条要是在这之后追加进去，就会晚于 `closeAll` 落地——那期间要是有
        // `start`，新起的会话没人再收（收尾已经走完了）。控制通道的出口只有一个，
        // 这就是它。（别另起一套「收尾中队列」：那只是把同一件事记两处。）
        if (closing !== undefined) {
          console.error('[ui] 已在收摊——这一条不再受理')
          return
        }

        // 一条一条来：正在处理的那条没答复之前，后面的排队（答复次序即请求次序）
        chain = chain
          .then(async () => {
            const reply = await face.handle(line)
            await Bun.write(Bun.stdout, `${reply}\n`)
          })
          .catch((error: unknown) => {
            // 答复送不出去（stdout 断管）＝控制端没了：**收摊退场**。
            // 留着也只是个没人能再使唤、却还占着应用的进程。
            //
            // ⚠️ 这里**只能 `void`**（不能 `await`）：`shutdown` 会等 `chain` 落地，
            //    而这一跳正**在**那条链上——await 下去就是「等自己」，两边都不动。
            console.error(`[ui] 答复送不出去：${String(error)}`)
            void shutdown('答复送不出去（控制端断了）').then(
              () => process.exit(0),
              () => process.exit(1),
            )
          })
      }

      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          // ⚠️ 信号来了得**自己退场**：主流程正堵在那根 stdin 的读上（它只认 EOF），
          // 而挂了处理器之后信号本身不再杀进程——不 exit 就永远停在那儿
          // （实测：自动用例 finally 里 `serve.kill()` 之后进程不死，`await exited` 没回音）
          void shutdown(signal).then(
            () => process.exit(0),
            () => process.exit(1),
          )
        })
      }

      console.error('[ui] 控制通道就绪：stdin 逐行 JSON 命令 ←→ stdout 逐行 JSON 答复')

      // 命令源**只有 stdin 一根**（TTY 与管道同一支读法：TTY 那条由终端按行交上来）。
      // 管道那头关了 / TTY 上敲了 Ctrl-D ⇒ 循环自然退出 ⇒ 收摊
      const decoder = new TextDecoder()
      let buffered = ''
      try {
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
      } catch (error) {
        // 读控制通道本身出错（EIO 之类）也是「控制端没了」——**照收摊**。
        // ⚠️ 这条原先直接冒到顶层：`closeAll` 一步没跑，应用就留在了机器上
        //    （工单第 4 条点名的那条静态路径）。
        await shutdown(`控制通道读不动了：${String(error)}`)
        await printErr(`[ui] 控制通道读不动了：${String(error)}`)
        return 1
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

// ⚠️ **别把 `main` 那个 promise 直接交给 `process.exit`**：它 reject 时既没有退出码，
// 也没人把缘由说给人听（收场里已经清过一次场，这里只补一句为什么会退）。
try {
  process.exit(await main())
} catch (error) {
  await printErr(`[ui] 出错了：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
