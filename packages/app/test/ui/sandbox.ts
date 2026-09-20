/**
 * 界面验收 · 隔离沙地（U40）——**一次运行自己的一整套落点**。
 *
 * ## 为什么要整块换，而不是只换几个路径
 *
 * 这一层起的是**真 `cli.ts`**（不是进程内装配），它自己会去读 `~/.magic/config.json`、
 * 在 `~/.magic/grants.json` 记授权、按配置里的 `dataDir` 落库。三处**都由 `HOME` 推出来**
 * （`os.homedir()` → `loadConfig()` 的缺省家目录 → `GRANTS_FILE` 的 `~` 展开），
 * 故这一层其实只做一件事：**给子进程一个换过的 `HOME` ＋ 一个换过的 cwd**，
 * 配置 / 数据 / 授权 / 工作区就都落在 `mkdtemp` 出来的那一块里了。
 *
 * ⚠️ **不复制用户真实配置**（那是把真 key 抄进临时目录——还得记得删）。这里写的是
 * **合成配置**：假 key ＋ `baseURL` 指向 loopback 夹具（不起夹具时指向 `127.0.0.1:9`，
 * 一个请求都发不出去）。`MAGIC_<ID>_API_KEY` 一律从子进程环境里剔掉——
 * 「不继承真实供应商凭据」这一条只有在这一步办得到。
 *
 * ⚠️ **别把「换 HOME」当成可选项**：`bun test` 起在用户自己的 shell 里，少换这一处，
 * 用例就会去动他**真的** `~/.magic`（U22 在进程内装配那一层踩过一次，见 `support.ts`
 * 的 `makeStage` 注）。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { removeDir, tempDir, validConfig, writeConfig } from '../tmp.ts'

/** 假的 key——**故意一眼看得出是假的**（真要有人把它抄去用，抄不坏任何东西）。 */
export const FAKE_API_KEY = 'sk-fake-u40-not-a-real-key'

/** 起不了夹具时指的那个端点（`127.0.0.1:9` ＝ 丢弃端口，连不上、也不出网）。 */
export const DEAD_BASE_URL = 'http://127.0.0.1:9/v1'

/** 隔离沙地——四块落点 ＋ 一份交给子进程的环境。 */
export type Sandbox = {
  /** 本次运行的临时根（家目录、工作区、数据都在它下面）。 */
  readonly root: string
  /** 子进程的 `HOME`——配置与授权都从这儿推。 */
  readonly home: string
  /** 子进程的 cwd ＝ 工作区根（配置没写 `workspaceRoots` 时它就是默认根）。 */
  readonly workspace: string
  readonly dataDir: string
  /** 配置文件（`$HOME/.magic/config.json`——加载器的缺省落点，不是随手找个地方）。 */
  readonly configPath: string
  /** 授权文件落点（`$HOME/.magic/grants.json`）——点 `a` 时写的就是它。 */
  readonly grantsPath: string
  /** 交给子进程的环境（已剔凭据、已换 HOME）。 */
  readonly env: Record<string, string>
  dispose(): void
}

export type SandboxOptions = {
  /** 模型端点的 `baseURL`——夹具起好了就把它的地址给进来。 */
  readonly baseURL?: string
  /** 模型名——缺省 `MiniMax-M3`（容量内置表命中，状态行 ④ 有分母可看）。 */
  readonly model?: string
  /** 子进程的 `FORCE_COLOR`——缺省 `3`（真彩：帧要留色，查看页要有色可看）。 */
  readonly forceColor?: string
  /** 配置里额外加的键（如 `permissions.rules`）。 */
  readonly config?: Record<string, unknown>
}

/**
 * 造一块沙地——**目录先建好**，配置按合成形制写死。
 *
 * 工作区根须**已存在**（执行域取 realpath——宁可在装配期响亮失败），故 `ws/` 在这儿建。
 */
export function createSandbox(options: SandboxOptions = {}): Sandbox {
  const root = tempDir('magic-u40-')
  const home = join(root, 'home')
  const workspace = join(root, 'ws')
  const dataDir = join(root, 'data')

  let configPath: string
  try {
    for (const dir of [join(home, '.magic'), workspace, dataDir]) mkdirSync(dir, { recursive: true })

    // `writeConfig(dir, …)` 把 `config.json` 写进那个目录——故给它 `$HOME/.magic/`
    configPath = writeConfig(
      join(home, '.magic'),
      validConfig({
        defaultProvider: 'local',
        providers: {
          local: {
            baseURL: options.baseURL ?? DEAD_BASE_URL,
            apiKey: FAKE_API_KEY,
            model: options.model ?? 'MiniMax-M3',
          },
        },
        // 数据目录**写绝对路径**（不写 `~`）：这块沙地里的路径一眼看得出落在哪儿
        dataDir,
        ...options.config,
      }),
    )
  } catch (error) {
    // 半成品沙地由**创建者**自己删——抛出去之后没人知道这块目录落在哪儿
    removeDir(root)
    throw error
  }

  return {
    root,
    home,
    workspace,
    dataDir,
    configPath,
    grantsPath: join(home, '.magic', 'grants.json'),
    env: childEnv({ home, forceColor: options.forceColor ?? '3' }),
    dispose: () => removeDir(root),
  }
}

/**
 * 子进程环境——**父环境照抄，然后摘掉三处不该传下去的**。
 *
 * - `MAGIC_*_API_KEY`——真凭据。剔了它，`resolveApiKey` 就只剩配置里那把假 key 可用；
 * - `NO_COLOR`——它会让 chalk 落到 0 档，而帧要留色（`FORCE_COLOR` 已显式拧到 3 档）；
 * - `HOME`——换成沙地（本文件存在的理由）。
 *
 * 其余照抄（`PATH` 等）——子进程仍要是**真的那个 `bun`**。
 */
function childEnv(options: { home: string; forceColor: string }): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^MAGIC_.*_API_KEY$/.test(key)) continue
    if (key === 'NO_COLOR') continue
    env[key] = value
  }

  env['HOME'] = options.home
  env['FORCE_COLOR'] = options.forceColor
  // 终端名照真终端的来（Ink / chalk 按它判色档）——沙地不是「没有终端」，是「另一个终端」
  env['TERM'] = 'xterm-256color'

  return env
}
