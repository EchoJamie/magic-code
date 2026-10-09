/** CLI 真子进程：help/version/离线 check 不启动 App，不开库或运行外部工具。 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'
import { parseArgs, connectTerminal } from '../src/cli.ts'
import { cliGround, fakeApp } from './resident-cli-fixture.ts'
import { reopenApp } from '../src/run/spawn-manager.ts'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

describe('resident-cli 短路径与终端接回参数', () => {
  test('help/version 无需可用配置或 App，离线 check 不执行 MCP 或创建库', async () => {
    const g = cliGround()
    try {
      mkdirSync(join(g.home, '.magic'))
      const config = join(g.home, '.magic/config.json')
      writeFileSync(config, 'bad config')
      g.publish({ invalid: true })
      for (const flag of ['--help', '-h', 'help', '--version', '-v']) {
        const result = await run(g.home, flag)
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe('')
      }
      const marker = join(g.root, 'mcp-was-started')
      const body = JSON.stringify({ providers: {}, dataDir: g.dataDir, mcp: { servers: {
        forbidden: { command: process.execPath, args: ['-e', `await Bun.write(${JSON.stringify(marker)}, "started")`] },
      } } })
      writeFileSync(config, body)
      expect((await run(g.home, '--check')).exitCode).toBe(0)
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(join(g.dataDir, 'records.db'))).toBe(false)
      expect(existsSync(join(g.home, '.magic/run'))).toBe(false)
      expect(readFileSync(config, 'utf8')).toBe(body)
    } finally { g.close() }
  })

  test('--open-request UUID 与 session/switch/allow-all 通过真实 hello 转交，不伪造 session', async () => {
    const g = cliGround()
    const server = fakeApp(g)
    const request = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
    try {
      g.publish()
      const parsed = parseArgs(['resume', 'session-real', '--open-request', request, '--model', 'spell', '--allow-all'])
      const connection = await connectTerminal(parsed, { home: g.home, env: { PATH: '/work/bin', API_KEY: 'do-not-send' } })
      const hello = server.messages.find((message) => message.t === 'hello')!
      expect(hello).toMatchObject({ t: 'hello', session: 'session-real', openRequest: request, switch: { choice: 'spell' }, allowAll: true, environment: { PATH: '/work/bin' } })
      expect(JSON.stringify(hello)).not.toContain('do-not-send')
      connection.client.close()

      const blank = await connectTerminal(parseArgs([]), { home: g.home, env: {} })
      const last = server.messages.filter((message) => message.t === 'hello').at(-1)!
      expect(last).not.toHaveProperty('session')
      expect(last).not.toHaveProperty('openRequest')
      blank.client.close()
    } finally { server.close(); g.close() }
  })

  test('重连按规范路径识别原实例：发现记录与原连接的软链接写法均不产生新工作', async () => {
    const g = cliGround()
    const server = fakeApp(g)
    const choice = join(g.root, 'choice')
    symlinkSync(g.root, choice, 'dir')
    const aliasBase = join(choice, 'selected/.magic')
    const opened: string[] = []
    try {
      // 首连规范化 base，发现文件仍保留声明写法，复现真实 /var 与 /private/var 差异。
      g.publish({ ...g.discovery, base: aliasBase })
      const first = await connectTerminal(parseArgs(['resume', 'session-existing']), { home: g.home, env: {} })
      expect(first.magic.base).toBe(aliasBase)
      first.client.close()
      const again = await reopenApp({
        home: g.home, env: {}, appPath: g.app,
        expectedInstance: { base: first.magic.base },
        connect: { session: 'session-existing' },
        openApplication: async app => { opened.push(app) },
      })
      again.client.close()
      // 反向写法与数据目录软链接也按相同规则归一，不维护另一套比较分支。
      g.publish()
      const canonical = await reopenApp({
        home: g.home, env: {}, appPath: g.app,
        expectedInstance: { base: aliasBase },
        connect: { session: 'session-existing' },
        openApplication: async app => { opened.push(app) },
      })
      canonical.client.close()
      const requests = server.messages.filter(message => message.t !== 'bye')
      expect(requests).toHaveLength(3)
      expect(requests.every(message => message.t === 'hello' && message.session === 'session-existing')).toBe(true)
      expect(opened).toEqual([])
      expect(existsSync(join(g.dataDir, 'records.db'))).toBe(false)
    } finally { server.close(); g.close() }
  })

  test('重连仍拒绝真正不同的基础目录或数据目录，hello 前终止且不创建目录或工作', async () => {
    const g = cliGround()
    const server = fakeApp(g)
    const opened: string[] = []
    const otherBase = join(g.root, 'other-base')
    const otherData = join(g.root, 'other-data')
    try {
      g.publish()
      for (const expectedInstance of [
        { base: otherBase },
        { base: otherData },
      ]) {
        await expect(reopenApp({
          home: g.home, env: {}, appPath: g.app, expectedInstance,
          connect: { session: 'session-existing' },
          openApplication: async app => { opened.push(app) },
        })).rejects.toThrow('App 数据实例已改变')
      }
      expect(server.messages).toEqual([])
      expect(opened).toEqual([])
      expect(existsSync(otherBase)).toBe(false)
      expect(existsSync(otherData)).toBe(false)
      expect(existsSync(join(g.dataDir, 'records.db'))).toBe(false)
    } finally { server.close(); g.close() }
  })

  test('终端请求 UUID 缺失、非法或用于离线路径时直接拒绝', async () => {
    const home = tempDir('magic-cli-')
    try {
      for (const argv of [
        ['--open-request'], ['--open-request', 'not-a-uuid'],
        ['--open-request', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '--check'],
      ]) {
        const result = await run(home, ...argv)
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain('--open-request')
      }
    } finally { removeDir(home) }
  })
})

type Run = { readonly stdout: string; readonly stderr: string; readonly exitCode: number }

async function run(home: string, ...args: readonly string[]): Promise<Run> {
  return runWith(home, {}, args)
}

async function runWith(
  home: string,
  extra: Record<string, string>,
  args: readonly string[],
): Promise<Run> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'MAGIC_HOME') continue
    env[key] = value
  }

  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: home,
    env: { ...env, HOME: home, ...extra },
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

function stageWithConfig(overrides: Record<string, unknown> = {}): { home: string; dataDir: string } {
  const home = tempDir('magic-cli-')
  mkdirSync(join(home, '.magic'), { recursive: true })
  const dataDir = join(home, '.magic')
  writeConfig(join(home, '.magic'), validConfig({ dataDir, ...overrides }))
  return { home, dataDir }
}

describe('入口 magic', () => {
  test('三种帮助入口输出一致，包含常用选项与示例', async () => {
    const home = tempDir('magic-cli-')
    try {
      const results = await Promise.all(['--help', '-h', 'help'].map(flag => run(home, flag)))
      for (const result of results) {
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout).toBe(results[0]!.stdout)
        expect(result.stdout).toContain('magic —— 软件工程智能体')
        expect(result.stdout).toContain('magic [选项]')
        expect(result.stdout).toContain('--script <file>')
        expect(result.stdout).toContain('示例：')
      }
    } finally {
      removeDir(home)
    }
  })

    test('`--help`——不出现 Markdown 标记 · 内部包名 · 架构词（守护）', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--help')

      expect(result.exitCode).toBe(0)
      for (const banned of ['**', '@magic/', '应用层', '接缝', '控制面', '装配', 'playground']) {
        expect(result.stdout).not.toContain(banned)
      }
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

    test('配置坏了——报「配置有问题」并退 1', async () => {
    const home = tempDir('magic-cli-')
    try {
      mkdirSync(join(home, '.magic'), { recursive: true })
      writeFileSync(join(home, '.magic', 'config.json'), '{ 这不是 JSON }', 'utf8')

      const result = await run(home, '--check')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('配置有问题')
      expect(result.stderr).toContain('config.json')
    } finally {
      removeDir(home)
    }
  })

    test('还没有配置——不报「配置有问题」（首次运行要能进入接入流程）', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home)

      expect(result.stderr).not.toContain('配置有问题')
    } finally {
      removeDir(home)
    }
  })

  test('离线检查——配置如实报告，数据落点不创建', async () => {
    // dataDir 用**加载器展开得了的**写法的反面也用上：这里直接给绝对路径
    const { home, dataDir } = (() => {
      const home = tempDir('magic-cli-')
      mkdirSync(join(home, '.magic'), { recursive: true })
      const dataDir = join(home, '.magic')
      writeConfig(join(home, '.magic'), validConfig({ dataDir }))
      return { home, dataDir }
    })()

    try {
      // 无参现在是「起真外壳」（要 TTY，测试跑不了）——自检改由 `--check` 触发
      const result = await run(home, '--check')

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('离线配置检查')
      expect(result.stdout).toContain(dataDir)
      // 模型名与「key 来处」都在自检里；key 本身不在（密钥纪律）
      expect(result.stdout).toContain('MiniMax-M3')
      expect(result.stdout).toContain('key 取自配置文件')
      expect(result.stdout).not.toContain('sk-test-not-a-real-key')
      // 外壳位如实交代（真外壳归 U09）
      expect(result.stdout).toContain('外部工具　未连接（离线检查）')
      // 权限规则：没配也要**明说**（U76 起那是常态——不在名单里的调用本来就不问，
      // 不是漏配；说清这件事，用户才不会以为自己少配了什么）
      expect(result.stdout).toContain('权限规则　0 条 · 被拒 0 条')
      // 工具集：**从契约的冻结行现取**（第 18 轮补锚——此行曾写死「exec（阶段 1 唯一工具）」，
      // 工具集 v1 到站后它成了假话）；七件按表的次序
      expect(result.stdout).not.toContain('工具集')

      // 会话（U27 · 随批小修 6）：无会话是**常态**（D5：启动＝新会话，空手打开）——
      // 回执得说人话。**未处理的值不许印出来**：此前这里印的是字面 `undefined`（验收装置的瑕疵）。
      // 「整份回执里没有 `undefined`」是**跨行**的判据——将来哪一行再漏一个未处理值，这条也拦得住。
      expect(result.stdout).not.toContain('会话请求')
      expect(result.stdout).not.toContain('undefined')

      // 离线只读：库与 blob 目录都不创建
      expect(existsSync(join(dataDir, 'records.db'))).toBe(false)
      expect(existsSync(join(dataDir, 'blobs'))).toBe(false)
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
      expect(result.stdout).toContain('权限规则　1 条 · 被拒 1 条')
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
        expect(existsSync(join(sandbox.dataDir, 'records.db'))).toBe(false) // 只读检查不创建库
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

function twoProviders(): Record<string, unknown> {
  return {
    models: {default: {provider: "alpha", model: 'alpha-1'}, cantrip: {provider: "beta", model: 'beta-1'}, spell: {provider: "alpha", model: 'alpha-1'}, arcane: {provider: "alpha", model: 'alpha-1'}},
    providers: {
      alpha: { vendor: 'minimax', baseURL: 'https://alpha.example/v1', apiKey: 'sk-alpha-key12' },
      beta: { vendor: 'minimax', baseURL: 'https://beta.example/v1', apiKey: 'sk-beta-key12' },
    },
  }
}

describe('入口 magic · 换模型的启动参数', () => {
  test('自检报供应商表——几条、当前走哪条', async () => {
    const { home, dataDir } = stageWithConfig(twoProviders())

    try {
      const result = await run(home, '--check')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('供应商表　2 条——alpha（alpha） · beta（beta）')
      expect(result.stdout).toContain('当前走 alpha')
      expect(result.stdout).not.toContain('sk-alpha-key12')
      void dataDir
    } finally {
      removeDir(home)
    }
  })

  test('`--provider` 开局选中另一条——自检里如实说「本次走」', async () => {
    const { home } = stageWithConfig(twoProviders())

    try {
      const result = await run(home, '--check', '--model', 'cantrip')

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
      const byModel = await run(home, '--check', '--model', 'spell')
      expect(byModel.exitCode).toBe(0)
      expect(byModel.stdout).toContain('—— 本次走 alpha（alpha-1）')
    } finally {
      removeDir(home)
    }
  })

  test('不认识的条目——退 1，缘由点名已注册的（打错字当场看得见有哪些）', async () => {
    const { home } = stageWithConfig(twoProviders())

    try {
      const result = await run(home, '--check', '--model', 'betta')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('--model 只能选择 default / cantrip / spell / arcane')
    } finally {
      removeDir(home)
    }
  })

  test('选项缺值——退 1（`--provider --check` 这类笔误不被当成名字）', async () => {
    const { home } = stageWithConfig(twoProviders())

    try {
      const result = await run(home, '--model', '--check')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('--model 缺值')
    } finally {
      removeDir(home)
    }
  })

  test('帮助列出启动选项，脚本格式指向 README', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--help')

      expect(result.stdout).not.toContain('--provider')
      expect(result.stdout).toContain('--model <tier>')
      expect(result.stdout).toContain('README.md「脚本（--script）」')
    } finally {
      removeDir(home)
    }
  })
})

describe('入口 magic · 接续（`resume` · U25 恢复入口）', () => {
  test('旧选项、缺少 id、重复 resume 和多余位置参数明确拒绝', () => {
    for (const argv of [
      ['--session', 's-old'], ['resume'], ['resume', ''], ['resume', '   '],
      ['resume', '-v'], ['resume', '--model', 'spell'],
      ['resume', 'one', 'resume', 'two'], ['resume', 'one', 'two'],
    ]) expect(() => parseArgs(argv)).toThrow()
    expect(parseArgs(['resume', "会话 ' 中文", '--model', 'spell']).session).toBe("会话 ' 中文")
    expect(parseArgs(['--model', 'spell', 'resume', 's-one']).session).toBe('s-one')
  })
  test('旧选项通过真实 CLI 退出，不连接 App', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--session', 's-old')
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('不认得的参数「--session」')
      expect(existsSync(join(home, '.magic'))).toBe(false)
    } finally { removeDir(home) }
  })

  test('用法里写清了这条入口（新增入口选项须在设计里登记的那条规矩）', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--help')

      expect(result.stdout).toContain('magic resume <id>')
      expect(result.stdout).not.toContain('--session')
      expect(result.stdout).toContain('输入后继续执行')
    } finally {
      removeDir(home)
    }
  })

  test('`--check resume` 只展示请求，不装载会话', async () => {
    const { home, dataDir } = stageWithConfig()

    // 库里先**真**有一条会话（会话是**首写即建**的，D5——不写库＝不在库里）
    const store = createRecordsStore({ dataDir, workspace: [home] })
    store.setSessionTitle('s-picked-by-user', '真有一条', Date.now())
    store.close()

    try {
      const result = await run(home, '--check', 'resume', 's-picked-by-user')

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('s-picked-by-user')
      // 空手那条话不出现——这次**有**会话（用户点了名）
      expect(result.stdout).not.toContain('还没有会话')
    } finally {
      removeDir(home)
    }
  })

    test('离线检查不声称校验过会话，也不创建同名会话', async () => {
    const { home } = stageWithConfig()

    try {
      const result = await run(home, '--check', 'resume', 's-typo')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('s-typo（离线检查不连接或校验会话）')
      expect(existsSync(join(home, 'data/records.db'))).toBe(false)
    } finally {
      removeDir(home)
    }
  })

  test('选项缺值——退 1（`resume --check` 这类笔误不被当成 id）', async () => {
    const { home } = stageWithConfig()

    try {
      const result = await run(home, 'resume', '--check')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('resume 缺值')
    } finally {
      removeDir(home)
    }
  })
})

describe('入口 magic · 全放行（`--allow-all` · U73）', () => {
  test('用法里写清了这条入口——**且写清了它只在起会话那一刻给**', async () => {
    const home = tempDir('magic-cli-')
    try {
      const result = await run(home, '--help')

      expect(result.stdout).toContain('--allow-all')
      expect(result.stdout).toContain('本次会话跳过所有操作确认')
      expect(result.stdout).toContain('仅启动时可用')
      expect(result.stdout).toContain('可跳过改权限和改属主等操作的确认')
      expect(result.stdout).toContain('不使用 --allow-all 时，改权限和改属主仍需确认')
      expect(result.stdout).toContain('删除规则仍直接拒绝，不受 --allow-all 影响')
      expect(result.stdout).not.toContain('包括删除')
      // ⚠️ **不叫 `mode`**（设计明文：「mode」这个词留给别的用途）——判的是**参数名**，
      // 故按**词**比、不按子串比：`--model` 那个词里本来就有 `--mode` 这四个字母加两个。
      expect(result.stdout.split(/\s+/u)).not.toContain('--mode')
    } finally {
      removeDir(home)
    }
  })

  test('敲得出来——不被当成坏参数（与 `--check` 同用即跑自检）', async () => {
    const { home } = stageWithConfig()

    try {
      const result = await run(home, '--allow-all', '--check')

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('不认得的参数')
    } finally {
      removeDir(home)
    }
  })

  test('**不带值**——多出来的那个词照旧是坏参数（它是一个开关，不是一个可点名的设置）', async () => {
    const home = tempDir('magic-cli-')

    try {
      // `--allow-all true` 这种写法不该被悄悄吃下：第二个词是**位置参数**，没人认它
      const result = await run(home, '--allow-all', 'true', '--check')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('不认得的参数')
    } finally {
      removeDir(home)
    }
  })
})
