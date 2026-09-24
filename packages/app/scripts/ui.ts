#!/usr/bin/env bun
/**
 * 界面验收工具 · 命令行入口（U40 · U51）——**薄的一层**：解析参数、调用共用驱动。
 *
 * 本文件**不复制任何驱动逻辑**（驱动在 `test/ui/`）：这里只有「读哪几个参数、
 * 打哪几行字、退什么码」。四条子命令：
 *
 * ```
 * bun packages/app/scripts/ui.ts list                              # 场景一览
 * bun packages/app/scripts/ui.ts run <场景> [--out <目录>]           # 跑一组场景（判据）
 * bun packages/app/scripts/ui.ts run <场景> --frames [--out <目录>]   # 同一趟：只驱动、只取帧，不判
 * bun packages/app/scripts/ui.ts script <步骤文件> [--out <目录>]     # 一趟脚本：一条命令跑完、自己收尾
 * bun packages/app/scripts/ui.ts serve [--out <目录>]               # 常驻：stdin 逐行 JSON ←→ stdout 逐行 JSON
 * ```
 *
 * ⚠️ 这是**研发设施**，不是产品命令：`magic --help` 里没有它，产品命令也不认它。
 *
 * ## 收尾：四条子命令都要「自己退」（U51 第三条）
 *
 * 这不是一句口号——规划侧第一轮就撞上「跑完了进程还赖着，只能手动 kill」。
 * 本文件这一层的规矩：
 *
 * 1. **子命令自己收自己的场**：`run` / `script` 的会话由各自的运行器在 `finally` 里关，
 *    `serve` 由 EOF / 信号 / 写失败 / 读不动四条路汇到 `shutdown`（见下）。
 * 2. **`main` 只在全都收完之后退**：`process.exit(await main())` 那一句在 `finally` 之后——
 *    异常那条路也一样收过场了（收场自己炸了也要退，且要说）。
 * 3. **出口只有一个**：本文件里除了那一句，**没有别处调 `process.exit`**
 *    （`serve` 的信号处理器那两处是「控制通道没了」的收场出口，收完就退）。
 *
 * ⚠️ 但**信号也拦不住 SIGKILL**：谁都清不了自己被杀之后的场（`研发/界面验收工具`·已知边界）。
 */

import { readFileSync } from 'node:fs'
import {
  createControl,
  parseSteps,
  runScenario,
  runScenarioFrames,
  runSteps,
  scenarioNames,
  summarizeRun,
} from '../test/ui/index.ts'
import type { ScenarioName, StepOutcome } from '../test/ui/index.ts'

const USAGE = `界面验收工具（开发命令，不是产品命令）

用法：
  bun packages/app/scripts/ui.ts list
      列出场景的名字（内置那几支）。

  bun packages/app/scripts/ui.ts run <场景> [--out <目录>] [--quiet]
      跑一组场景：起真应用、敲键、等屏上的条件、**判那些判据**、留现场。
      退出码 0 ＝ 全部判据通过；1 ＝ 有判据没过（失败现场照样留在 --out 下）。

  bun packages/app/scripts/ui.ts run <场景> --frames [--out <目录>]
      **同一趟故事，一条判据都不判**——每个该判的地方取一帧、记下此刻的读数交给你。
      要帧的用这条；要判据的用上一条。两条互不替代。

  bun packages/app/scripts/ui.ts script <步骤文件> [--out <目录>] [--quiet]
      一趟脚本：**给一个步骤文件，一条命令跑完、自己收尾、帧与读数落盘**。
      步骤文件是一段 JSON——每一步就是 serve 认的那条命令的一条：

        { "label": "看看窄窗", "steps": [
            { "cmd": "start", "as": "甲", "cols": 100, "rows": 30,
              "turns": [{ "kind": "text", "text": "说一句长话" }] },
            { "cmd": "send", "session": "甲", "text": "说一句长话" },
            { "cmd": "key", "session": "甲", "key": "enter",
              "wait": { "text": "说一句长话" }, "timeoutMs": 20000 },
            { "cmd": "capture", "session": "甲", "label": "01-提交之后" },
            { "cmd": "resize", "session": "甲", "columns": 46, "rows": 30 },
            { "cmd": "capture", "session": "甲", "label": "02-窄窗" },
            { "cmd": "quit", "session": "甲" },
            { "cmd": "close", "session": "甲" }
        ] }

      命令就那几条：start / send / key / resize / wait / capture / quit / close / sessions
      （与 serve 同一套，学一次就够）。两处糖：start 可以写 "as" 给窗口起名；
      send / key 可以写 "wait" ＋ "timeoutMs" ＝「写一次，等这一下生效」；
      quit ＝ 照产品的方式退出（空闲连按两次 ctrl+c 那一路，你不必自己数两下），
      close ＝ 收摊并报「谁让它退的场」（答复里的 exit.by）。
      **本入口一条判据都不跑**——装置负责真实驱动 ＋ 如实取帧，判据归看帧的人。
      退出码 0 ＝ 步骤走完；1 ＝ 有一步没走成（现场照样留在 --out 下）。

  bun packages/app/scripts/ui.ts serve [--out <目录>]
      常驻控制进程（助手那条入口）：**标准输入逐行读 JSON 命令、标准输出逐行写 JSON 答复**。
      命令带 id，答复带同一个 id；命令一条一条来（前一条没答复，后面的排队）。
      **stdin 到头（EOF）就收摊**：自己起的应用与端点一个不留，现场留在 --out 下。

      ⚠️ stdin 的条件（实测，别想当然）——**tty:false 起的进程 stdin 当场就是关的**
      （接到 /dev/null），serve 会立刻收到 EOF 收摊，当不了持续入口。两条可用姿势：
        ① tty:true 的 exec 会话，直接把 JSON 行写进这个进程的 stdin（TTY 行输入实测可用）；
        ② 拿 cat 包一层：cat | bun packages/app/scripts/ui.ts serve --out <目录>
           （想让它一直活着就别给 Ctrl-D）。

      ⚠️ **要跑一段自己写的交互，别搭 FIFO——用上面的 script。** 那条路才是为它做的。

参数：
  --out <目录>      产物根（缺省 <仓库>/.ui-runs；每次运行一个子目录，不覆盖旧的）
  --frames          run 用：只驱动、只取帧，不跑判据
  --quiet           run / script 时不逐条打（只打结论）
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
    if (name === 'quiet' || name === 'frames') {
      flags[name] = true
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
  const artifacts = artifactsOf(args.flags)
  const quiet = args.flags['quiet'] === true

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

      return args.flags['frames'] === true
        ? runFramesOnly(name as ScenarioName, artifacts)
        : runChecks(name as ScenarioName, artifacts, quiet)
    }

    case 'script': {
      const path = args.rest[0]
      if (path === undefined) {
        await printErr('script 要给步骤文件（写法见 --help）')
        return 1
      }

      let steps
      try {
        steps = parseSteps(readFileSync(path, 'utf8'))
      } catch (error) {
        // 坏文件**当场说清楚**——别让它跑到一半才炸在一个看不懂的地方
        await printErr(`步骤文件读不动：${error instanceof Error ? error.message : String(error)}`)
        return 1
      }

      // 产物根：步骤文件里写的优先，其次是 `--out`（两处都没有就取仓库 `.ui-runs/`）
      const out = steps.out ?? artifacts
      const result = await runSteps(steps.steps, {
        ...(out === undefined ? {} : { artifacts: out }),
        ...(steps.checkout === undefined ? {} : { checkout: steps.checkout }),
        label: steps.label ?? path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/i, ''),
        ...(quiet
          ? {}
          : {
              onStep: (outcome) => {
                void printStep(outcome)
              },
            }),
      })

      await print('')
      await print(result.report)
      // 每个窗口那一趟的**自证那一行**（哪个提交 · 什么尺寸 · 有没有截断）
      for (const entry of result.sessionDirs) {
        await print(`  现场　${entry.session} · ${entry.runDir}`)
        await print(`        ${summarizeRun(entry.runDir)}`)
      }
      return result.ok ? 0 : 1
    }

    case 'serve': {
      const face = createControl({
        ...(artifacts === undefined ? {} : { artifacts }),
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

/** 判据那一路：跑场景，逐条打结论。 */
async function runChecks(name: ScenarioName, artifacts: string | undefined, quiet: boolean): Promise<number> {
  const result = await runScenario(name, {
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(quiet
      ? {}
      : {
          onCheck: (outcome) => {
            // 「已知未修」的照样打 ✗、照样显示实际读数——**不粉饰**，只在后面挂一句欠谁的
            const owed = outcome.knownOpen === undefined ? '' : `　← 已知未修 · 欠 ${outcome.knownOpen.defect}`
            void print(
              `  ${outcome.ok ? '✓' : '✗'} ${outcome.what}${outcome.detail === '' ? '' : `（${outcome.detail}）`}${owed}`,
            )
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
  for (const dir of result.runDirs) {
    await print(`  现场　${dir}`)
    await print(`        ${summarizeRun(dir)}`)
  }
  for (const viewer of result.viewers) await print(`  查看页　${viewer}`)

  return result.ok ? 0 : 1
}

/** 只驱动、只取帧那一路：**一条判据都不判**，把每一帧与它的读数交出来。 */
async function runFramesOnly(name: ScenarioName, artifacts: string | undefined): Promise<number> {
  const result = await runScenarioFrames(name, {
    ...(artifacts === undefined ? {} : { artifacts }),
    onCheck: () => {},
  })

  await print('')
  await print(`${result.ok ? '走完了' : '没走完'} · ${result.name} · ${result.title}（**只驱动、只取帧**）`)
  await print(`  依据　${result.anchors}`)
  await print(`  取景　${result.readings.length} 处`)
  await print('')

  for (const reading of result.readings) {
    const frame = reading.frame
    const where = frame === undefined ? '（没取到帧）' : `${frame.files.text}`
    const mark = reading.held ? '·' : '❔'
    await print(`  ${mark} ${reading.what}　${frame?.columns ?? ''}×${frame?.rows ?? ''}`)
    if (reading.detail !== '') await print(`      ${reading.detail}`)
    await print(`      帧　${where}`)
  }

  if (result.failure !== undefined) {
    await print('')
    await print(`  卡在哪　${result.failure.what}：${result.failure.detail}`)
  }
  await print('')
  await print(`  **判据归看帧的人**——上面一条结论都没下：哪条对、哪条不对，你自己看着办。`)
  for (const dir of result.runDirs) {
    await print(`  现场　${dir}`)
    await print(`        ${summarizeRun(dir)}`)
  }
  for (const viewer of result.viewers) await print(`  查看页　${viewer}`)

  return result.ok ? 0 : 1
}

async function printStep(outcome: StepOutcome): Promise<void> {
  const who = outcome.session === undefined ? '' : ` [${outcome.session}]`
  const detail = outcome.ok ? '' : `　${outcome.error?.message ?? '没过'}`

  await print(`  ${outcome.ok ? '✓' : '✗'} ${String(outcome.n).padStart(2)} ${outcome.cmd}${who}${detail}`)
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
