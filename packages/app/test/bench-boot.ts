/**
 * 启动基准（U21 · **测量装置**，不是用例——`bun test` 不收它）。
 *
 * ## 量什么
 *
 * 「**启动到首帧**」拆成三段，各归各的账：
 *
 * | 段 | 里头是什么 | 归谁 |
 * | --- | --- | --- |
 * | **模块加载** | `import` 那一片（13 个包 ＋ Ink/React 的依赖图） | 打包 / 依赖面 |
 * | **装配** | `assemble()`——配置 · 记录库 · 工作区 · 沙箱 · 网关 · 各域 · 控制域 | 装配根 |
 * | **首帧** | `runTui()`——建壳 · Ink 挂上终端 · 画出第一屏 | 外壳 |
 *
 * 三段加起来＝**进程内**的「起手到看得见」。而**用户在终端里感受到的**那一个还要加上
 * Bun 自己的启动——那个只能从外面量（pty 数进程起到第一个字节，方法见本单元回报）。
 *
 * ## 走的是真路径
 *
 * `assemble()` 与 `runTui()` 都是产品那两个函数本身（不是照它们重写一遍）：流是假的
 * （不是终端就起不来），**别的全真**——真配置 · 真记录库 · 真控制面。
 *
 * ⚠️ **收尾用 `process.exit`**：Ink 挂上之后没有「按 ctrl+c」这一出，`waitUntilExit`
 * 会一直等。量完即走——这是**测量装置**的方便，不是产品行为。
 *
 * ## 跑法
 *
 * ```
 * FORCE_COLOR=0 bun packages/app/test/bench-boot.ts            # 默认 5 轮取中位
 * FORCE_COLOR=0 bun packages/app/test/bench-boot.ts --rounds 9
 * ```
 *
 * ⚠️ **一轮一进程**（这个文件自己 spawn 自己）。被逼出来的：头一版在一个进程里跑 5 轮，
 * 第二轮的 `import` 已经进了 Bun 的模块缓存 ⇒ **「模块加载」量到 0.0ms**，
 * 而 `合计` 又从一个固定的起点算 ⇒ 把前面每一轮都叠了进去（实测 338.8ms 全是假账）。
 * 启动这件事**只有冷的那一次算数**，故一轮必须是一个新进程。
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 进程内计时起点——**在动态 import 之前**（这一行以下才算得到加载那一段）。 */
const T0 = Bun.nanoseconds()

const ms = (from: number, to: number): number => (to - from) / 1e6

/** 假 stdout——Ink 只用得上这几个成员（同 `@magic/tui` 的 `terminal.ts`），**多记一个首帧时刻**。 */
class FakeTty extends EventEmitter {
  readonly isTTY = true
  readonly destroyed = false
  readonly writableEnded = false
  readonly columns = 110
  readonly rows = 40
  /** 第一次写出的时刻（纳秒）——**首帧就在这一刻**。 */
  firstWriteAt: number | null = null

  write = (_chunk: string): boolean => {
    this.firstWriteAt ??= Bun.nanoseconds()
    return true
  }
}

/** 假 stdin——`runTui` 只查 `isTTY`；Ink 要一个流才肯挂。 */
class FakeStdin extends EventEmitter {
  readonly isTTY = true
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => null
}

export type BootStages = {
  /** 进程内起点 → 依赖图加载完（毫秒）。 */
  readonly loadMs: number
  /** `assemble()` 本身（毫秒）。 */
  readonly assembleMs: number
  /** `runTui()` 起手 → 第一个字节写出（毫秒）。 */
  readonly firstFrameMs: number
  /** 三段之和——**进程内**的「起手到看得见」。 */
  readonly totalMs: number
}

/** 跑一轮，返回三段。 */
export async function bootOnce(): Promise<BootStages> {
  const root = join(tmpdir(), `magic-boot-${process.pid}-${Math.round(T0)}`)
  mkdirSync(join(root, 'ws'), { recursive: true })

  // 真配置（写到临时家目录里，走 `loadConfig` —— 与 `--check` 同一条路）
  const configPath = join(root, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultProvider: 'bench',
      providers: { bench: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'sk-bench-not-used', model: 'm' } },
      dataDir: join(root, 'data'),
    }),
  )

  // **统一基础路径**（U42）——这一处手写两件（`MAGIC_HOME` 不设时就是家目录下的 `.magic`）。
  // 为什么不 import 解析器：本文件量的是**加载耗时**，顶上多拉一个包会把这笔账记歪
  // （`T0` 之前的那一段不计量，而 `@magic/contracts` 本来是在下面那次动态 import 里才进来的）。
  const magic = { home: root, base: join(root, '.magic') } as const

  const beforeImport = Bun.nanoseconds()
  // 动态 import——静态 import 会被提升到模块顶部，那一段就量不到了
  const { assemble, loadConfig } = await import('../src/index.ts')
  const { runTui } = await import('@magic/tui')
  const loaded = Bun.nanoseconds()

  try {
    const assembly = assemble({
      cwd: join(root, 'ws'),
      config: loadConfig({ path: configPath, magic }),
      magic,
      prompt: { platform: 'darwin', date: '2026-09-19' },
    })
    const assembled = Bun.nanoseconds()

    const stdout = new FakeTty()
    const stdin = new FakeStdin()

    await runTui({
      transport: assembly.shell,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
    })
    const framed = stdout.firstWriteAt ?? Bun.nanoseconds()

    assembly.close()

    return {
      loadMs: ms(beforeImport, loaded),
      assembleMs: ms(loaded, assembled),
      firstFrameMs: ms(assembled, framed),
      totalMs: ms(T0, framed),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

/**
 * ⚠️ 用 `Bun.write` 而不是 `console.log` + `process.exit`：管道上的 `console.log`
 * 会缓冲，`process.exit` 一按就把还没落盘的输出**丢掉**（本装置踩过：只印出一个
 * 光标复位、数字一个字没有）。写完再走。
 */
async function print(line: string): Promise<void> {
  await Bun.write(Bun.stdout, `${line}\n`)
}

/** 一轮：跑一次冷启动，把三段印成一行（外层据它汇总）。 */
async function once(): Promise<void> {
  const stages = await bootOnce()
  await print(
    JSON.stringify({
      loadMs: Number(stages.loadMs.toFixed(2)),
      assembleMs: Number(stages.assembleMs.toFixed(2)),
      firstFrameMs: Number(stages.firstFrameMs.toFixed(2)),
      totalMs: Number(stages.totalMs.toFixed(2)),
    }),
  )
}

if (import.meta.main) {
  if (process.argv.includes('--once')) {
    await once()
    process.exit(0)
  }

  const at = process.argv.indexOf('--rounds')
  const rounds = at === -1 ? 5 : Number(process.argv[at + 1] ?? 5)

  // **一轮一进程**（见文件头注）——每轮拿到的都是冷的模块缓存
  const runs: BootStages[] = []
  for (let index = 0; index < rounds; index += 1) {
    const child = Bun.spawn([process.execPath, import.meta.path, '--once'], {
      stdout: 'pipe',
      stderr: 'inherit',
    })
    const text = await new Response(child.stdout).text()
    await child.exited

    const line = text.split('\n').find((row) => row.trim().startsWith('{'))
    if (line === undefined) continue
    runs.push(JSON.parse(line) as BootStages)
  }

  const pick = (key: keyof BootStages): string => `${median(runs.map((run) => run[key])).toFixed(1)}ms`

  await print('')
  await print(`启动到首帧（进程内 · ${runs.length} 轮取中位 · 一轮一进程）`)
  await print(`  模块加载    ${pick('loadMs')}`)
  await print(`  装配        ${pick('assembleMs')}`)
  await print(`  首帧        ${pick('firstFrameMs')}`)
  await print(`  ─────────────────`)
  await print(`  合计        ${pick('totalMs')}`)
  await print('')

  process.exit(0)
}
