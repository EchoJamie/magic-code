/**
 * 首字延迟（U21 · **测量装置**）——「回车 → 第一个字到手」。
 *
 * ## 这一跳拆成两段，别混作一谈
 *
 *     [回车] ──①外壳那一跳── [命令进内核] ──②模型那一跳（网络 + 供应商）── [第一个字]
 *
 * - **②** 不在本单元射程内：它是端点与网络的账，改多少外壳都不动它。这一段由**本探针**
 *   量（真配置 · 真注册表 · 真取件层 · 真端点）。
 * - **①** 归外壳：由 `@magic/tui` 的 `bench-stream.ts` 量（「投一条增量 → 上屏」）。
 *   两段相加才是用户按完回车之后等的那一下。
 *
 * ## 安全（**硬规矩**）
 *
 * 配置里那个 `apiKey` 是**真 key**——故：① 配置**复制**进一个临时家，
 * `dataDir`（写的是 `~/.magic`）随之展开到临时家 ⇒ **用户真库零写入**；
 * ② 跑完把临时家删掉（含那份带 key 的副本）；③ **报告只印耗时，不印 key、不印正文**。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/bench-first-token.ts --rounds 3
 * ```
 *
 * ⚠️ 会**真调一次模型**（每轮一条极短的交代）——那是要花钱的，故默认 3 轮、提示词极短。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KernelEvent } from '@magic/contracts'
import { resolveMagicHome } from '@magic/contracts'

/** 真配置的落点——**统一基础路径**下的那一份（U42：跟着 `MAGIC_HOME` 走，不再写死 `~/.magic`）。 */
const REAL_CONFIG = `${resolveMagicHome(process.env, homedir()).base}/config.json`

export type FirstToken = {
  /** 回车 → 命令进内核（本地那一段）。 */
  readonly submitMs: number
  /** 回车 → 第一个 `model.delta`（**含**端点与网络）。 */
  readonly firstTokenMs: number
}

/** 一次交代跑完，返回两段耗时（**不印任何正文**）。 */
export async function firstTokenOnce(prompt: string): Promise<FirstToken> {
  const home = join(tmpdir(), `magic-firsttoken-${process.pid}-${Date.now()}`)
  mkdirSync(join(home, '.magic'), { recursive: true })
  mkdirSync(join(home, 'ws'), { recursive: true })
  // **复制**配置（不是改写真的那份）；`dataDir: "~/.magic"` 展开到临时家
  writeFileSync(join(home, '.magic', 'config.json'), readFileSync(REAL_CONFIG))

  // **这一趟的基址就是临时家**（U42）：配置、`~` 展开、用户技能与授权全落在它底下
  // ——真家里那几样一处都不碰（本探针的硬规矩，见文件头注）。
  const magic = resolveMagicHome({}, home)

  const { assemble, loadConfig, attachShell } = await import('../src/index.ts')

  try {
    const assembly = assemble({
      cwd: join(home, 'ws'),
      magic,
      config: loadConfig({ path: join(home, '.magic', 'config.json'), magic }),
    })
    const handle = attachShell(assembly.shell, { timeoutMs: 60_000 })

    const armed = new Promise<number>((resolve) => {
      const off = assembly.shell.subscribe((event: KernelEvent) => {
        if (event.kind !== 'model.delta') return
        off()
        resolve(Bun.nanoseconds())
      })
    })

    const started = Bun.nanoseconds()
    handle.send({ type: 'input.submit', text: prompt })
    const submitted = Bun.nanoseconds()
    const arrived = await armed

    // **等这一轮收束再收摊**——头一版拿到第一个字就 dispose ＋ close，
    // 而模型那头还在吐：尾随的事件撞上已关的库，`appendEvent` 当场抛一串栈
    // （实测见过）。那串栈是**探针的账**，不是产品的。
    await handle.until((event) => event.kind === 'turn.end', 30_000).catch(() => {})
    handle.dispose()
    assembly.close()

    return {
      submitMs: (submitted - started) / 1e6,
      firstTokenMs: (arrived - started) / 1e6,
    }
  } finally {
    rmSync(home, { recursive: true, force: true }) // 带 key 的那份副本随此删掉
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--rounds')
  const rounds = at === -1 ? 3 : Number(process.argv[at + 1] ?? 3)
  const prompt = '只回一个字'

  const runs: FirstToken[] = []
  for (let index = 0; index < rounds; index += 1) {
    try {
      runs.push(await firstTokenOnce(prompt))
    } catch (error) {
      await Bun.write(Bun.stdout, `第 ${index + 1} 轮没跑成：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.floor(sorted.length / 2)] as number
  }

  await Bun.write(
    Bun.stdout,
    runs.length === 0
      ? '一轮都没跑成——端点不通 / key 无效都可能（本探针不编数）\n'
      : [
          '',
          `首字延迟（真端点 · ${runs.length} 轮取中位）`,
          `  回车 → 进内核    ${median(runs.map((run) => run.submitMs)).toFixed(1)}ms`,
          `  回车 → 第一个字  ${median(runs.map((run) => run.firstTokenMs)).toFixed(1)}ms`,
          '',
          '  ⚠️ 第二行几乎全是**端点与网络**的账——外壳那一跳另由',
          '     `@magic/tui` 的 bench-stream.ts 量（同一套读数里那份才是本单元的账）。',
          '',
        ].join('\n'),
  )

  process.exit(0)
}
