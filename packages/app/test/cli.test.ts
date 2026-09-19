/**
 * U11 · 入口 —— 判据：**`magic` 可调用**（`bun run magic`）。
 *
 * 「可调用」取实证：**真开子进程跑**（不是 import 了事）。三面：
 * ① `--help` 与坏参数；② 配置有问题时响亮退场；③ **装配自检真跑得通**——
 * 全链构造一遍（配置 → 记录库 → 工作区 → 沙箱 → 网关 → 各域 → 控制域），
 * 数据目录都建出来了，然后干净收尾。
 *
 * 家目录用 `HOME` 注入（`os.homedir()` 认它），故不碰真的 `~/.magic`。
 * 假 key 只用于**构造**——网关构造不发请求（缺 key 会在构造期抛，那也在本用例的射程内）。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

type Run = { readonly stdout: string; readonly stderr: string; readonly exitCode: number }

async function run(home: string, ...args: readonly string[]): Promise<Run> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

/**
 * 装一块带配置的沙地（家目录＝`home`，配置文件在 `<home>/.magic/config.json`）。
 *
 * **数据落点也在这块沙地里**（`D24`——它只能在这儿）：早先这个夹具给的是**固定路径**
 * `/tmp/magic-cli-never`，**且不清理**——于是**新版本写过的库留在那儿，老版本的用例
 * 当场红**（库比程序新即拒开，`U26` 实测到 5 条，`rm -rf` 后全绿）。
 * 那 5 条红**是设计要的行为**，只是夹具踩在了它上面：**跑过什么版本，决定下一个人
 * 看到什么颜色**——红得没有信息量，只会训练人忽略红（与 `D17` 同族）。
 *
 * ⇒ **每次唯一**（`tempDir` 走 `mkdtemp`）＋ 收尾 `removeDir(home)`（库就埋在 home 里）。
 * 用例要另指落点就覆盖 `dataDir`——**但别指到固定路径去**。
 */
function stageWithConfig(overrides: Record<string, unknown> = {}): { home: string; dataDir: string } {
  const home = tempDir('magic-cli-')
  mkdirSync(join(home, '.magic'), { recursive: true })
  const dataDir = join(home, 'data')
  writeConfig(join(home, '.magic'), validConfig({ dataDir, ...overrides }))
  return { home, dataDir }
}

describe('入口 magic', () => {
  test('`--help`——说清用法与脚本形制', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--help')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('magic —— 软件工程智能体')
      expect(result.stdout).toContain('--script')
      // 无人值守替人批准这件事要在用法里说破——别让它看着像产品行为
      expect(result.stdout).toContain('人工门')
    } finally {
      removeDir(home)
    }
  })

  test('坏参数——响亮退场（退 1，不是静默忽略）', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--nosuchflag')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('不认得的参数')
    } finally {
      removeDir(home)
    }
  })

  test('配置缺——报「配置有问题」并退 1', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home)

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('配置有问题')
      expect(result.stderr).toContain('config.json')
    } finally {
      removeDir(home)
    }
  })

  test('装配自检——全链构造一遍，数据落点真建出来', async () => {
    // dataDir 用**加载器展开得了的**写法的反面也用上：这里直接给绝对路径
    const { home, dataDir } = (() => {
      const home = tempDir('magic-cli-')
      mkdirSync(join(home, '.magic'), { recursive: true })
      const dataDir = join(home, 'data')
      writeConfig(join(home, '.magic'), validConfig({ dataDir }))
      return { home, dataDir }
    })()

    try {
      // 无参现在是「起真外壳」（要 TTY，测试跑不了）——自检改由 `--check` 触发
      const result = await run(home, '--check')

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('装配自检')
      expect(result.stdout).toContain(dataDir)
      // 模型名与「key 来处」都在自检里；key 本身不在（密钥纪律）
      expect(result.stdout).toContain('MiniMax-M3')
      expect(result.stdout).toContain('key 取自配置文件')
      expect(result.stdout).not.toContain('sk-test-not-a-real-key')
      // 外壳位如实交代（真外壳归 U09）
      expect(result.stdout).toContain('U09')
      // 权限规则：没配也要**明说**（那是阶段 1 姿态，不是漏配——用户得能分辨这两者）
      expect(result.stdout).toContain('权限规则　无（缺省＝一律问，阶段 1 姿态）')
      // 工具集：**从契约的冻结行现取**（第 18 轮补锚——此行曾写死「exec（阶段 1 唯一工具）」，
      // 工具集 v1 到站后它成了假话）；七件按表的次序
      expect(result.stdout).toContain('工具集　　exec / read / write / edit / grep / glob / ls（7 件')

      // 会话（U27 · 随批小修 6）：无会话是**常态**（D5：启动＝新会话，空手打开）——
      // 回执得说人话。**未处理的值不许印出来**：此前这里印的是字面 `undefined`（验收装置的瑕疵）。
      // 「整份回执里没有 `undefined`」是**跨行**的判据——将来哪一行再漏一个未处理值，这条也拦得住。
      expect(result.stdout).toContain('会话　　　（还没有会话——首条消息按下回车才开张）')
      expect(result.stdout).not.toContain('undefined')

      // 全链真构造过：库与 blob 目录都在
      expect(existsSync(join(dataDir, 'records.db'))).toBe(true)
      expect(existsSync(join(dataDir, 'blobs'))).toBe(true)
    } finally {
      removeDir(home)
    }
  })

  test('自检报权限规则——**被拒的条目连同缘由**（解析从严，但不静默丢弃）', async () => {
    const home = tempDir('magic-cli-')
    mkdirSync(join(home, '.magic'), { recursive: true })
    writeConfig(
      join(home, '.magic'),
      validConfig({
        dataDir: join(home, 'data'),
        // 第 2 条键名写错（`pth`）——权限域从严不收；用户得在自检里看得到这件事
        permissions: { rules: [{ tool: 'exec', op: 'read' }, { tool: 'exec', pth: '/w' }] },
      }),
    )

    try {
      const result = await run(home, '--check')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('权限规则　1 条（必闸禁区凌驾其上） · ⚠️ 被拒 1 条')
      expect(result.stdout).toContain('第 2 条')
      expect(result.stdout).toContain('pth')
    } finally {
      removeDir(home)
    }
  })

  test('**坏根**退 1 且是「配置有问题：」一行话——不是三段内部栈（U18 守护）', async () => {
    // 由头（本轮实测）：`workspaceRoots` 是**用户手写在配置文件里**的东西——路径打错
    // 一个字母就是配置事故。而执行域抛的是普通 `Error`（它不该认识 `ConfigError`），
    // 裸抛出去用户拿到的是「一句 error: ＋ 三段栈」，栈里还写着给开发者看的设计出处。
    // 故装配根转一道（`openWorkspace`），入口那条一行话的通道才接得上。
    //
    // ⚠️ **这条是守护**：倒回「裸抛」它当场红（`配置有问题：` 不见了、`at ` 栈出来）。
    const home = tempDir('magic-cli-')
    mkdirSync(join(home, '.magic'), { recursive: true })
    writeConfig(
      join(home, '.magic'),
      validConfig({ dataDir: join(home, 'data'), workspaceRoots: ['relative/nope'] }),
    )

    try {
      const result = await run(home, '--check')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('配置有问题：')
      expect(result.stderr).toContain('工作区根须是绝对路径')
      expect(result.stderr).toContain('第 1 条') // 多条根下用户得知道改哪一行
      // 栈是「说成程序异常」的样子——这一行把「报得有人看得懂」钉住
      expect(result.stderr).not.toContain('at normalizeRoot')
      expect(result.stdout).toBe('') // 自检一步都没走完，别印半份
    } finally {
      removeDir(home)
    }
  })

  test('`--script` 指向不存在的文件——退 1 并点名', async () => {
    const { home } = stageWithConfig()

    try {
      const result = await run(home, '--script', join(home, 'nope.json'))

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('脚本文件不存在')
    } finally {
      removeDir(home)
    }
  })
})

/**
 * **`D24` · 夹具用固定路径且不清理**（U28）——判据锚的是「我要什么」：**跑两遍不互相污染**。
 *
 * 早先这个夹具拿固定路径 `/tmp/magic-cli-never` 当数据目录、且**不清理**：新版本写过的库
 * 留在那儿，老版本的用例当场红（**库比程序新即拒开**——那 5 条红本是设计要的行为，是夹具
 * 踩在了它上面）。**红得没有信息量**，只会训练人忽略红（同 `D17` 一族）。
 *
 * 两条正向判据：**每次唯一**（两次装出来的沙地不是一块）· **收尾不留库**。
 */
describe('U28 · 夹具沙箱化（D24）', () => {
  test('数据落点**每次唯一**，两遍各自跑通，收尾**不留库**', async () => {
    const first = stageWithConfig()
    const second = stageWithConfig()

    try {
      expect(first.dataDir).not.toBe(second.dataDir)
      // 第几遍跑、之前跑过什么版本，都不该改这一遍的颜色
      for (const sandbox of [first, second]) {
        const result = await run(sandbox.home, '--check')

        expect(result.exitCode).toBe(0)
        expect(existsSync(join(sandbox.dataDir, 'records.db'))).toBe(true) // 库真落在这块沙地里
      }
    } finally {
      removeDir(first.home)
      removeDir(second.home)
    }

    // 收尾删干净——下一遍（乃至下一个版本）看到的是一块空地，不是上一遍留下的库
    expect(existsSync(first.dataDir)).toBe(false)
    expect(existsSync(second.dataDir)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// U17 · 运行时切换的**启动参数**入口（`--provider` / `--model`）
// ═══════════════════════════════════════════════════════════════════════

/** 一份两条目的配置覆盖——甲是缺省、乙是「另一种跑法」（落点由沙地给，见 `stageWithConfig`）。 */
function twoProviders(): Record<string, unknown> {
  return {
    defaultProvider: 'alpha',
    providers: {
      alpha: { baseURL: 'https://alpha.example/v1', apiKey: 'sk-alpha-key12', model: 'alpha-1' },
      beta: { baseURL: 'https://beta.example/v1', apiKey: 'sk-beta-key12', model: 'beta-1' },
    },
  }
}

describe('入口 magic · 换模型的启动参数', () => {
  test('自检报供应商表——几条、当前走哪条', async () => {
    const { home, dataDir } = stageWithConfig(twoProviders())

    try {
      const result = await run(home, '--check')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('供应商表　2 条——alpha（alpha-1） · beta（beta-1）')
      expect(result.stdout).toContain('当前走 alpha（缺省 · 模型名取自请求）')
      expect(result.stdout).not.toContain('sk-alpha-key12')
      void dataDir
    } finally {
      removeDir(home)
    }
  })

  test('`--provider` 开局选中另一条——自检里如实说「本次走」', async () => {
    const { home } = stageWithConfig(twoProviders())

    try {
      const result = await run(home, '--check', '--provider', 'beta')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('—— 本次走 beta（beta-1）')
      expect(result.stdout).toContain('当前走 beta（beta-1）')
    } finally {
      removeDir(home)
    }
  })

  test('`--provider` 单给时取该条目的默认模型；`--model` 可单独用（同条目换模型）', async () => {
    const { home } = stageWithConfig(twoProviders())

    try {
      const byModel = await run(home, '--check', '--model', 'alpha-experimental')
      expect(byModel.exitCode).toBe(0)
      expect(byModel.stdout).toContain('—— 本次走 alpha（alpha-experimental）')
    } finally {
      removeDir(home)
    }
  })

  test('不认识的条目——退 1，缘由点名已注册的（打错字当场看得见有哪些）', async () => {
    const { home } = stageWithConfig(twoProviders())

    try {
      const result = await run(home, '--provider', 'betta')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('换模型不成功')
      expect(result.stderr).toContain('未知供应商「betta」——已注册：alpha / beta')
    } finally {
      removeDir(home)
    }
  })

  test('选项缺值——退 1（`--provider --check` 这类笔误不被当成名字）', async () => {
    const { home } = stageWithConfig(twoProviders())

    try {
      const result = await run(home, '--provider', '--check')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('--provider 缺值')
    } finally {
      removeDir(home)
    }
  })

  test('用法里写清了两个入口（启动参数 · 脚本步骤）', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--help')

      expect(result.stdout).toContain('--provider <id>')
      expect(result.stdout).toContain('--model <名>')
      expect(result.stdout).toContain('"switch"')
    } finally {
      removeDir(home)
    }
  })
})

/**
 * **`--session`**（U25 · 恢复入口）——审计第 1 条那个悬案：恢复的入口没有归处。
 *
 * 判据锚的是「我要什么」：**给一个 id，装配就接上那条会话**（「接着来是显式的」那半句，
 * 技术方案 · 会话与多会话）。它**由应用层受理**（`@magic/actions`）——本文件只验
 * 「id 进得来、落到了会话位上」；装载 ＋ 恢复 ＋ 重建那三件在 `test/recovery.test.ts` 与真跑里验。
 */
describe('入口 magic · 接续（`--session` · U25 恢复入口）', () => {
  test('用法里写清了这条入口（新增入口选项须在设计里登记的那条规矩）', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--help')

      expect(result.stdout).toContain('--session <id>')
      expect(result.stdout).toContain('恢复')
    } finally {
      removeDir(home)
    }
  })

  test('`--check --session <库里真有的 id>`——装配**开局就装载它**（自检里报出那条 id）', async () => {
    const { home, dataDir } = stageWithConfig()

    // 库里先**真**有一条会话（会话是**首写即建**的，D5——不写库＝不在库里）
    const store = createRecordsStore({ dataDir, workspace: [home] })
    store.setSessionTitle('s-picked-by-user', '真有一条', Date.now())
    store.close()

    try {
      const result = await run(home, '--check', '--session', 's-picked-by-user')

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('s-picked-by-user')
      // 空手那条话不出现——这次**有**会话（用户点了名）
      expect(result.stdout).not.toContain('还没有会话')
    } finally {
      removeDir(home)
    }
  })

  /**
   * **打错 id 不静默降级**（U28 · 台账随批小修 8）——今天的行为是：`--session s-typo`
   * 照 id 装载一条**空的**，用户以为接上了，其实没有。
   *
   * 判据锚的是「我要什么」：**库里没有这条会话就说没有**（报错退场），
   * 绝不「照 id 造一条新的」——那正是「以为接上了」的来处。
   *
   * ⚠️ **这条是守护**：倒回「照 id 装载」，它当场红（退 0 且印出那条 id 的自检）。
   */
  test('`--session <库里没有的 id>`——退 1 并点名，**不降级成新会话**', async () => {
    const { home } = stageWithConfig()

    try {
      const result = await run(home, '--check', '--session', 's-typo')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('没有这条会话')
      expect(result.stderr).toContain('s-typo')
      expect(result.stdout).toBe('') // 一步都不走——别印半份自检
    } finally {
      removeDir(home)
    }
  })

  test('选项缺值——退 1（`--session --check` 这类笔误不被当成 id）', async () => {
    const { home } = stageWithConfig()

    try {
      const result = await run(home, '--session', '--check')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('--session 缺值')
    } finally {
      removeDir(home)
    }
  })
})
