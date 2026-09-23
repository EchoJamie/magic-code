/**
 * U42 · **MAGIC_HOME 统一基础路径** —— 验收那一层：**真 CLI 的读写落点**。
 *
 * 判据不许只停在 helper 的返回值上（工单明写），故这里起的是**真 `cli.ts` 子进程**。
 * 场地也是照判据摆的：**两棵 `.magic` 同时在那儿**——一棵在 `$HOME` 下（老地方），
 * 一棵在 `$MAGIC_HOME` 下（新基址），两边放**分得开的**合成配置 / 数据 / 授权 / 技能。
 * 于是每一条断言都是二选一：读的、写的落在哪一棵里，一比就知道。
 *
 * 三块落点**互不重合**（这一点是判据成立的前提）：
 *
 *     <room>/ws    子进程的 cwd＝工作区根（**项目**那一类来源的来处）
 *     <room>/home  子进程的 `HOME`（**老树** `$HOME/.magic` 在那儿）
 *     <room>/base  子进程的 `MAGIC_HOME`（**新树** `<base>/.magic` 在那儿）
 *
 * ⚠️ 早先一版把老树摆在 `cwd` 上，于是它成了**项目**来源、自检里照样露头——判据就咬不住
 * 要验的那条路了（「用户技能从哪棵树上长出来」）。三块分开之后，露头即等于读错了树。
 *
 * 三条口径：
 * - **不设变量一字不变**——`cli.test.ts` 那一批既有用例就是它（那边一个字都没改）；
 * - **设了全落新树**——读写都是，且**老树一根毫毛都不动**（前后逐路径比）；
 * - **新树缺内容不回退老树**——沿既有缺失处理（报错点新树的路），不悄悄回老地方。
 *
 * ⚠️ 子进程环境**剔掉** `MAGIC_HOME` 与 `MAGIC_*_API_KEY`（显式给的除外）：不剔的话，
 * 跑测试的 shell 里那两位会让用例的落点与凭据随环境漂——而本文件恰恰拿落点当判据。
 * 模型端点用**环回夹具**（`ui/fixture.ts`），一个付费请求都不发。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { startFixture } from './ui/fixture.ts'
import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

type Run = { readonly stdout: string; readonly stderr: string; readonly exitCode: number }

/** 一块场地——三块落点互不重合（见文件头注）。 */
type Room = {
  readonly root: string
  /** 子进程的 cwd（工作区根——配置没写 `workspaceRoots` 时它是默认根）。 */
  readonly ws: string
  /** 子进程的 `HOME`——**老树**在这儿。 */
  readonly home: string
  /** 子进程的 `MAGIC_HOME`——**新树**在这儿。 */
  readonly base: string
  dispose(): void
}

function makeRoom(): Room {
  const root = tempDir('magic-home-')
  const ws = join(root, 'ws')
  const home = join(root, 'home')
  const base = join(root, 'base')
  for (const dir of [ws, home, base]) mkdirSync(dir, { recursive: true })

  return { root, ws, home, base, dispose: () => removeDir(root) }
}

/** 起一次真入口——`magic` 给了就设 `MAGIC_HOME`（U42 那一位）。 */
async function runCli(options: {
  readonly room: Room
  readonly magic?: string
  readonly args: readonly string[]
}): Promise<Run> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === 'MAGIC_HOME') continue
    if (/^MAGIC_.*_API_KEY$/.test(key)) continue
    env[key] = value
  }

  const proc = Bun.spawn([process.execPath, CLI, ...options.args], {
    cwd: options.room.ws,
    env: {
      ...env,
      HOME: options.room.home,
      ...(options.magic === undefined ? {} : { MAGIC_HOME: options.magic }),
    },
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
 * 摆一棵「Magic 的树」——`<root>/.magic/config.json` ＋（可选）另指的 `dataDir`。
 *
 * `dataDir` 默认**把键拿掉**（＝缺省＝基础目录）：那正是 U42 之后最常见的形态，也是本文件
 * 最想验的那一条。要写别的落点就传 `dataDir`（含「写死老地方」那种旧形制）。
 *
 * ⚠️ `validConfig` 自带的 `dataDir: '~/.magic'` 要**删掉**——留着它就变成「旧形制」了，
 * 这一组用例嘴上说的「缺省」与实际写下的那份配置对不上（两种写法最后都落在基础目录，
 * 故门照绿、只是验错了东西：判据得咬住它自称的那一条）。
 */
function plantTree(
  root: string,
  over: {
    readonly provider: string
    readonly model: string
    readonly baseURL?: string
    readonly dataDir?: string
    readonly config?: Record<string, unknown>
  },
): string {
  const body = validConfig({
    defaultProvider: over.provider,
    providers: {
      [over.provider]: {
        baseURL: over.baseURL ?? 'http://127.0.0.1:9/v1',
        apiKey: 'sk-fake-u42-not-a-real-key',
        model: over.model,
      },
    },
    ...(over.dataDir === undefined ? {} : { dataDir: over.dataDir }),
    ...over.config,
  })

  if (over.dataDir === undefined) delete body['dataDir']

  mkdirSync(join(root, '.magic'), { recursive: true })
  return writeConfig(join(root, '.magic'), body)
}

/**
 * 一棵树里现有的全部路径（相对 `.magic`，排序）——「老树一根毫毛都没动」靠它比。
 *
 * 只数 `.magic` 那一棵：`bun` 子进程会往**换过的 `HOME`** 里写自己的编译缓存
 * （`Library/Caches/bun/…`），那是跑测试的系统账，不是 Magic 的落点——把它算进来，
 * 这条断言就变成了「Bun 别写缓存」（它做不到，也不是本项要管的事）。
 */
function snapshot(root: string): readonly string[] {
  const magicDir = join(root, '.magic')
  const found: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      found.push(relative(magicDir, path))
      if (entry.isDirectory()) walk(path)
    }
  }

  if (existsSync(magicDir)) walk(magicDir)
  return found.sort()
}

/** 一处技能——`<tree>/.magic/skills/<name>/SKILL.md`（描述带名字，好认是哪一棵的）。 */
function plantSkill(root: string, name: string, note: string): void {
  const dir = join(root, '.magic', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${note}\n---\n\n${note}\n`,
    'utf8',
  )
}

describe('U42 · MAGIC_HOME 下的真 CLI', () => {
  test('设了基址——自检报的全是新树那几处（配置 · 数据 · 授权 · 用户技能）', async () => {
    const room = makeRoom()
    try {
      const oldConfig = plantTree(room.home, { provider: 'old', model: 'OLD-MODEL' })
      const newConfig = plantTree(room.base, { provider: 'fresh', model: 'NEW-MODEL' })
      plantSkill(room.home, 'old-skill', '老树里那一份')
      plantSkill(room.base, 'fresh-skill', '新树里那一份')

      const before = snapshot(room.home)
      const result = await runCli({ room, magic: room.base, args: ['--check'] })

      expect(result.exitCode).toBe(0)
      // 读的是新树那一份配置（老树那一份连碰都没碰）
      expect(result.stdout).toContain(newConfig)
      expect(result.stdout).not.toContain(oldConfig)
      // 数据 / 授权都从新基址派生
      expect(result.stdout).toContain(join(room.base, '.magic', 'records.db'))
      expect(result.stdout).toContain(join(room.base, '.magic', 'grants.json'))
      // 供应商与用户技能也取自新树（老树那两样一个字都不该露头）
      expect(result.stdout).toContain('NEW-MODEL')
      expect(result.stdout).not.toContain('OLD-MODEL')
      expect(result.stdout).toContain('fresh-skill')
      expect(result.stdout).not.toContain('old-skill')

      // **老树一根毫毛都没动**（没被读、没被写、也没被搬走）
      expect(snapshot(room.home)).toEqual(before)
    } finally {
      room.dispose()
    }
  })

  test('dataDir 缺省＝基础目录——真写在新树里（老树那边不落库）', async () => {
    const room = makeRoom()
    try {
      plantTree(room.home, { provider: 'old', model: 'OLD-MODEL' })
      plantTree(room.base, { provider: 'fresh', model: 'NEW-MODEL' })

      const before = snapshot(room.home)
      const result = await runCli({ room, magic: room.base, args: ['--check'] })

      expect(result.exitCode).toBe(0)
      // 自检报的是新树那一处，且**真建出来了**（自检这一步就开库）
      const database = join(room.base, '.magic', 'records.db')
      expect(result.stdout).toContain(database)
      expect(existsSync(database)).toBe(true)
      expect(existsSync(join(room.base, '.magic', 'blobs'))).toBe(true)

      // 老树：库与 blob 一个都不许出现
      expect(existsSync(join(room.home, '.magic', 'records.db'))).toBe(false)
      expect(snapshot(room.home)).toEqual(before)
    } finally {
      room.dispose()
    }
  })

  test('旧配置写死 `dataDir: "~/.magic"` **不构成例外**——落点仍是新基址', async () => {
    const room = makeRoom()
    try {
      plantTree(room.home, { provider: 'old', model: 'OLD-MODEL' })
      // 新树这一份是**旧形制**：数据目录写着老地方的那种字面写法
      plantTree(room.base, { provider: 'fresh', model: 'NEW-MODEL', dataDir: '~/.magic' })

      const result = await runCli({ room, magic: room.base, args: ['--check'] })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(join(room.base, '.magic', 'records.db'))
      // 「写死了就绕得过」不是一条路：老地方不许因此冒出一个库来
      expect(existsSync(join(room.home, '.magic', 'records.db'))).toBe(false)
    } finally {
      room.dispose()
    }
  })

  test('新基址下**缺内容不回退**——报错点的是新树那条路，不是老树', async () => {
    const room = makeRoom()
    try {
      plantTree(room.home, { provider: 'old', model: 'OLD-MODEL' })
      // 新树是空的——配置根本不在（`room.base` 目录建着，但里面什么都没有）

      const result = await runCli({ room, magic: room.base, args: ['--check'] })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('配置有问题')
      expect(result.stderr).toContain(join(room.base, '.magic', 'config.json'))
      // 老树那份配置**不许被顺手拿来顶上**（那正是「悄悄回老地方」）
      expect(result.stderr).not.toContain(join(room.home, '.magic', 'config.json'))
      expect(result.stdout).toBe('')
    } finally {
      room.dispose()
    }
  })

  test('缺密钥的提示指着**实际那一份**配置文件（不再是写死的 `~/.magic`）', async () => {
    const room = makeRoom()
    try {
      plantTree(room.home, { provider: 'old', model: 'OLD-MODEL' })
      // 新树这一份**没有 apiKey**（环境变量那条兜底也被统一剔掉了），造网关时当场报
      plantTree(room.base, {
        provider: 'fresh',
        model: 'NEW-MODEL',
        config: { providers: { fresh: { baseURL: 'http://127.0.0.1:9/v1', model: 'NEW-MODEL' } } },
      })

      const result = await runCli({ room, magic: room.base, args: ['--check'] })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('缺 apiKey')
      expect(result.stderr).toContain(join(room.base, '.magic', 'config.json'))
      // 写死的那串老落点不许再出现在提示里（`MAGIC_HOME` 指到别处时它是指错地方）
      expect(result.stderr).not.toContain('~/.magic')
    } finally {
      room.dispose()
    }
  })

  test('真跑一段脚本——**写**落新树（老树一个字节都不多）', async () => {
    const fixture = startFixture({ turns: [{ kind: 'text', text: '收到，我在。' }] })
    const room = makeRoom()
    try {
      plantTree(room.home, { provider: 'old', model: 'OLD-MODEL', baseURL: fixture.baseURL })
      plantTree(room.base, { provider: 'fresh', model: 'NEW-MODEL', baseURL: fixture.baseURL })

      const scriptPath = join(room.root, 'script.json')
      writeFileSync(scriptPath, JSON.stringify({ inputs: ['说一句话'] }), 'utf8')

      const before = snapshot(room.home)
      const result = await runCli({ room, magic: room.base, args: ['--script', scriptPath] })

      expect(result.exitCode).toBe(0)
      // 请求真发出去了（链子走通，不是「什么都没跑所以没写」）
      expect(fixture.requests().length).toBeGreaterThan(0)

      // **写**在新树：库与 blob 都在
      const database = join(room.base, '.magic', 'records.db')
      expect(existsSync(database)).toBe(true)
      expect(existsSync(join(room.base, '.magic', 'blobs'))).toBe(true)
      expect(result.stdout).toContain(database)

      // 老树：一个字节都没多（也没少）
      expect(existsSync(join(room.home, '.magic', 'records.db'))).toBe(false)
      expect(snapshot(room.home)).toEqual(before)
    } finally {
      await fixture.stop()
      room.dispose()
    }
  })
})
