/**
 * U11 · 配置加载 —— 判据：**形制照读**（字面冻结）· **`dataDir` 前导 `~` 在加载时展开** ·
 * key 解析不在此处但**永不落日志**。
 *
 * 第 2 条是**跨域对证**：本文件既断言加载器把 `~` 展开，也断言**原样交给记录域会被它拒**
 * ——两处合起来才说明「展开必须发生在交给它之前」不是一句注释。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE_NAME, MAGIC_DIR, apiKeyEnvVarOf, resolveMagicHome } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { ConfigError, describeConfig, loadConfig } from '../src/index.ts'
import { magicAt, removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

/** 家目录——注入值（契约层的展开函数不读环境，故由调用方给）。 */
/** 工作区根（U26 起 `createRecordsStore` 必给）——本文件量的是数据落点，与归属无关。 */
const ROOTS = ['/work/alpha']

const HOME = '/home/tester'

function loadFrom(
  body: unknown,
  extra: { path?: string; magic?: ReturnType<typeof magicAt> } = {},
) {
  const dir = tempDir('magic-config-')
  const path = extra.path ?? writeConfig(dir, body)
  try {
    return loadConfig({ path, magic: extra.magic ?? magicAt(HOME) })
  } finally {
    removeDir(dir)
  }
}

describe('形制照读（字面冻结）', () => {
  test('三件落地——defaultProvider / providers / dataDir', () => {
    const loaded = loadFrom(validConfig())

    expect(loaded.providerId).toBe('minimax')
    // `provider` 可缺（U41：还没配过缺省连接的配置就是这样）——本用例的配置里它该在，
    // 故 `!` 是断言本身的一部分，不是绕过检查
    expect(loaded.provider!.model).toBe('MiniMax-M3')
    expect(loaded.provider!.baseURL).toBe('https://api.minimaxi.com/v1')
    expect(Object.keys(loaded.config.providers)).toEqual(['minimax'])
  })

  test('多供应商＝providers 加条目，形制不变', () => {
    const loaded = loadFrom(
      validConfig({
        providers: {
          minimax: { baseURL: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
          local: { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen' },
        },
      }),
    )

    expect(Object.keys(loaded.config.providers)).toEqual(['minimax', 'local'])
    expect(loaded.providerId).toBe('minimax')
  })

  test('traits 覆盖位——原样带出，「键在即接管」（`{}` 是合法值）', () => {
    const withTraits = loadFrom(
      validConfig({
        providers: {
          minimax: {
            baseURL: 'https://x/v1',
            model: 'some-model',
            traits: { inlineThinking: { tag: 'think' } },
          },
        },
      }),
    )
    expect(withTraits.provider!.traits).toEqual({ inlineThinking: { tag: 'think' } })

    const empty = loadFrom(
      validConfig({
        providers: { minimax: { baseURL: 'https://x/v1', model: 'm', traits: {} } },
      }),
    )
    // `{}` ＝**显式声明无特征**——不是「按常规处理」，故必须存在且为空对象
    expect(empty.provider!.traits).toEqual({})

    const none = loadFrom(
      validConfig({ providers: { minimax: { baseURL: 'https://x/v1', model: 'm' } } }),
    )
    expect(none.provider!.traits).toBeUndefined()
  })

  /**
   * D10 · 第 1 样的那一格——**漏带＝静默失效**（配置里写了窗长而加载器不接，
   * 状态行的分母就永远不出现，还不报错）。故此处钉两形 ＋ 坏值报错。
   */
  test('`contextWindow` 覆盖位——声明了才带出（正整数；不写＝不声明窗长）', () => {
    const declared = loadFrom(
      validConfig({
        providers: { minimax: { baseURL: 'https://x/v1', model: 'm', contextWindow: 200_000 } },
      }),
    )
    expect(declared.provider!.contextWindow).toBe(200_000)

    const none = loadFrom(
      validConfig({ providers: { minimax: { baseURL: 'https://x/v1', model: 'm' } } }),
    )
    // 不写就没有这一位——**不是 0、不是 NaN**（拿不到就说拿不到）
    expect(none.provider!.contextWindow).toBeUndefined()
    expect('contextWindow' in none.provider!).toBe(false)
  })

  /**
   * **落点随基础目录走**（U42）＋ **读不懂才报错**（U41）。
   *
   * U42 把「配置文件落点」从一个写死的字面量改成「基础目录 ＋ 文件名」两段
   * （`MAGIC_DIR` / `CONFIG_FILE_NAME`）——拼出来的绝对路径只剩 `resolveMagicHome` 一处。
   * U41 又改了触发条件：**文件不在不再是错**（首次运行就是这样，要能进入接入流程），
   * 故这一条改用一份**读不懂的内容**来验落点——报出来的 `path` 仍是它，判据没松。
   */
  test('缺省配置文件落点＝基础目录下的 config.json', () => {
    expect(MAGIC_DIR).toBe('.magic')
    expect(CONFIG_FILE_NAME).toBe('config.json')

    // 不传 path 时读它——展开后即 `<基础目录>/config.json`

    const dir = tempDir('magic-config-')
    try {
      mkdirSync(join(dir, '.magic'), { recursive: true })
      writeFileSync(join(dir, '.magic', 'config.json'), '{ 这不是 JSON }', 'utf8')

      expect(() => loadConfig({ magic: magicAt(dir) })).toThrow(ConfigError)
      try {
        loadConfig({ magic: magicAt(dir) })

      } catch (error) {
        expect((error as ConfigError).path).toBe(join(dir, '.magic', 'config.json'))
      }
    } finally {
      removeDir(dir)


    }
  })
})

describe('dataDir 解析', () => {
  test('前导 `~` 在加载时展开', () => {
    const loaded = loadFrom(validConfig({ dataDir: '~/.magic' }))
    expect(loaded.config.dataDir).toBe(join(HOME, '.magic'))
    expect(loaded.config.dataDir).not.toContain('~')
  })

  test('`~` 独用＝家目录本身', () => {
    expect(loadFrom(validConfig({ dataDir: '~' })).config.dataDir).toBe(HOME)
  })

  test('无 `~` 即字面路径（不猜、不拼）', () => {
    expect(loadFrom(validConfig({ dataDir: '/var/tmp/magic' })).config.dataDir).toBe(
      '/var/tmp/magic',
    )
    expect(loadFrom(validConfig({ dataDir: './rel' })).config.dataDir).toBe('./rel')
  })

  /**
   * **原锚**：`expect(DEFAULT_DATA_DIR).toBe('~/.magic')`——缺省值那时是契约里的一串字面路径。
   *
   * **为何变**（U42）：缺省不再是「写死的 `~/.magic`」，而是**基础目录本身**——同一个字面
   * 路径在 `MAGIC_HOME` 指到别处时会把人带回旧目录，正是要撤掉的那一类。
   *
   * **新锚**：缺省＝基础目录；不设 `MAGIC_HOME` 时仍是 `${HOME}/.magic`（旧行为一字不变），
   * 指了就落在指的那处。
   */
  test('dataDir 缺省——基础目录本身', () => {
    const body = validConfig()
    delete body['dataDir']

    expect(loadFrom(body).config.dataDir).toBe(join(HOME, '.magic'))

    const elsewhere = { home: HOME, base: '/tmp/magic-home-elsewhere/.magic' }
    expect(loadFrom(body, { magic: elsewhere }).config.dataDir).toBe(elsewhere.base)
  })

  test('展开**必须**在交给记录域之前——原样交过去会被拒（跨域对证）', () => {
    const dir = tempDir('magic-config-')
    try {
      // 家目录＝真目录，故展开后的落点是能真建的（沙地量，不碰真 ~/.magic）
      const loaded = loadConfig({
        path: writeConfig(dir, validConfig({ dataDir: '~/magic-data' })),
        magic: magicAt(dir),
      })
      expect(loaded.config.dataDir).toBe(join(dir, 'magic-data'))

      // 加载器展开后的值：记录域收下
      const store = createRecordsStore({ dataDir: loaded.config.dataDir, workspace: ROOTS })
      expect(store.paths.database).toBe(join(dir, 'magic-data/records.db'))
      store.close()

      // 字面 `~` 直通：记录域当场拒（它不展开——展开归加载器）
      expect(() => createRecordsStore({ dataDir: '~/.magic', workspace: ROOTS })).toThrow(/不展开/)
    } finally {
      removeDir(dir)
    }
  })
})

/**
 * U42 · **MAGIC_HOME：统一基础路径** —— 判据：**不设变量一字不变 · 设了全落在新目录 ·
 * 旧配置写死 `~/.magic` 也不构成例外 · 别的路径原义**。
 *
 * 本文件钉的是**解析与加载**那一层（基础目录怎么算出来、`dataDir` 怎么归位）；
 * 装配与真 CLI 那一层（授权文件 / 用户技能 / 读写落点）钉在 `magic-home.test.ts`。
 */
describe('MAGIC_HOME：统一基础路径（U42）', () => {
  const ENV = { MAGIC_HOME: '/tmp/magic-test' }
  const ELSEWHERE = resolveMagicHome(ENV, HOME)
  const dirOf = (raw: string): string =>
    loadFrom(validConfig({ dataDir: raw }), { magic: ELSEWHERE }).config.dataDir

  test('不设变量——基础目录＝家目录下的 .magic（旧行为一字不变）', () => {
    const magic = resolveMagicHome({}, HOME)

    expect(magic.home).toBe(HOME)
    expect(magic.base).toBe(join(HOME, '.magic'))
  })

  test('设了——基础目录＝它下面的 .magic；**家目录不动**（不修改系统 HOME）', () => {
    expect(ELSEWHERE.base).toBe('/tmp/magic-test/.magic')
    // `~` 仍指**真**家目录——`MAGIC_HOME` 换的是 Magic 的落点，不是家
    expect(ELSEWHERE.home).toBe(HOME)
  })

  test('空串 / 全空白＝没设（不是「基础目录是空串」那种荒唐落点）', () => {
    expect(resolveMagicHome({ MAGIC_HOME: '' }, HOME).base).toBe(join(HOME, '.magic'))
    expect(resolveMagicHome({ MAGIC_HOME: '   ' }, HOME).base).toBe(join(HOME, '.magic'))
  })

  test('前导 `~` 照全仓那把尺子展开；尾随 `/` 不改变所指', () => {
    expect(resolveMagicHome({ MAGIC_HOME: '~/base' }, HOME).base).toBe(join(HOME, 'base/.magic'))
    expect(resolveMagicHome({ MAGIC_HOME: '/tmp/x/' }, HOME).base).toBe('/tmp/x/.magic')
  })

  test('缺省配置文件落点跟着走——去读的是新目录下那一份', () => {
    // **原锚**（U42）：「读不到 ⇒ 抛 `ConfigError`，报出来的 `path` 是新落点」。
    // **为何变**（U41）：**文件不在不再是错**（首次运行就是这样，要能进入接入流程），
    //   故「拿报错看落点」这一手不成立了；判据本身（读的是新目录那份）一个字没动。
    // **新锚**：返回的 `path` 就是新落点——`loadConfig` 把它交出来，照读即可。
    expect(loadConfig({ magic: ELSEWHERE }).path).toBe('/tmp/magic-test/.magic/config.json')
  })

  test('dataDir 写死旧落点**不构成例外**——`~/.magic` 及其子路径归到基础目录', () => {
    expect(dirOf('~/.magic')).toBe(ELSEWHERE.base)
    expect(dirOf('~/.magic/')).toBe(ELSEWHERE.base) // 尾随斜杠同义
    expect(dirOf('~/.magic/data')).toBe(join(ELSEWHERE.base, 'data'))
    // **写全了的绝对路径**同样归位——「写死就绕得过」不是一条路
    expect(dirOf(join(HOME, '.magic'))).toBe(ELSEWHERE.base)
    expect(dirOf(join(HOME, '.magic', 'data', 'blobs'))).toBe(join(ELSEWHERE.base, 'data/blobs'))
  })

  test('**别的路径原义**——归位只认旧那一棵树（这处修法在相反情形下仍成立）', () => {
    // 用户自己另指的落点照旧：`~` 展开到**家**，不展开到 `MAGIC_HOME`
    expect(dirOf('~/other')).toBe(join(HOME, 'other'))
    expect(dirOf('/var/tmp/data')).toBe('/var/tmp/data')
    expect(dirOf('~')).toBe(HOME)
    expect(dirOf('./rel')).toBe('./rel')
    // 同前缀的**别的目录**不许误伤（判据是「落在旧那一棵树之下」，不是「以那串开头」）
    expect(dirOf('~/.magicX')).toBe(join(HOME, '.magicX'))
    expect(dirOf(join(HOME, 'x', '.magic'))).toBe(join(HOME, 'x', '.magic'))
  })

  test('不设变量时归位是**零变化**——同一份旧配置，展开结果与从前逐字相同', () => {
    expect(loadFrom(validConfig({ dataDir: '~/.magic' })).config.dataDir).toBe(join(HOME, '.magic'))
    expect(loadFrom(validConfig({ dataDir: '~/.magic/records' })).config.dataDir)
      .toBe(join(HOME, '.magic/records'))
  })

  test('配置里的**其它** `~` 不与基础目录相干——工作区根照旧展开到家', () => {
    const loaded = loadFrom(validConfig({ workspaceRoots: ['~/work'] }), { magic: ELSEWHERE })

    expect(loaded.config.workspaceRoots).toEqual([join(HOME, 'work')])
  })
})

describe('报错取「一声响」（不静默兜底）', () => {
  /**
   * U41 补锚：**文件不在 ≠ 配置坏**（设计 · 命令行与配置：「首次无配置/空连接允许进入
   * 接入流程」＋「损坏配置必须报告具体位置，不能当空配置覆盖」）。
   *
   * **原锚**：「文件不存在 ⇒ 抛 `ConfigError`」（首站：配置是启动的必需品）；
   * **为何变**：新装用户手上还没有那份文件，照旧一声响等于把人挡在门外；
   * **新锚**：缺文件 ⇒ **空配置**（`providers: {}` ＋ 契约的缺省数据目录），
   * 而坏内容照旧报错点名（下一条用例）——两件事分开，判据没松。
   */
  test('文件不存在——空配置（首次运行就是这样，不是错）', () => {
    const dir = tempDir('magic-config-')
    try {
      const loaded = loadConfig({ path: join(dir, 'nope.json'), magic: magicAt(HOME) })


      expect(loaded.config.providers).toEqual({})
      expect(loaded.providerId).toBeUndefined()
      expect(loaded.provider).toBeUndefined()
      // 数据目录仍按契约的缺省给（空配置也落得了账）——U42 起是**基础目录本身**
      expect(loaded.config.dataDir).toBe(join(HOME, '.magic'))


    } finally {
      removeDir(dir)
    }
  })

  test('不是合法 JSON', () => {
    expect(() => loadFrom('{ 这不是 JSON }')).toThrow(/不是合法 JSON/)
  })

  test('defaultProvider 不在 providers 里——点名已有的', () => {
    expect(() => loadFrom(validConfig({ defaultProvider: 'ghost' }))).toThrow(
      /defaultProvider「ghost」不在 providers 里——已配：minimax/,
    )
  })

  test('字段缺 / 空 / 类型不对——逐条点名到字段', () => {
    const cases: readonly [unknown, RegExp][] = [
      [validConfig({ defaultProvider: '' }), /defaultProvider 须是非空字符串/],
      [validConfig({ providers: {} }), /defaultProvider「minimax」不在 providers 里/],
      // U41 改判这两条的期望文案——**原锚**：「缺 `baseURL` / 缺 `model` ⇒ 各报一句
      // 『须是非空字符串』」；**为何变**：两条接入路径的必填项不同了——有 `vendor` 的连接
      // 由适配给地址、型号来自接口，两者都可省；没有 `vendor` 的兼容接入两者仍必给，
      // 但缺的是「接入方式没说清」而不是「这个字段类型不对」；**新锚**：兼容接入缺哪一件
      // 就报哪一件缺（并指出两条路怎么走），报错仍**点名到字段**、仍**不降级**。
      [
        validConfig({ providers: { minimax: { model: 'MiniMax-M3' } } }),
        /providers\.minimax 两样都没有/,
      ],
      [
        validConfig({ providers: { minimax: { baseURL: 'https://x/v1' } } }),
        /providers\.minimax\.model 没写/,
      ],
      [
        validConfig({
          providers: { minimax: { baseURL: 'https://x/v1', model: 'm', apiKey: 42 } },
        }),
        /providers\.minimax\.apiKey 须是字符串/,
      ],
      [
        validConfig({
          providers: { minimax: { baseURL: 'https://x/v1', model: 'm', traits: [] } },
        }),
        /providers\.minimax\.traits 须是对象/,
      ],
      [
        validConfig({
          providers: {
            minimax: { baseURL: 'https://x/v1', model: 'm', traits: { inlineThinking: {} } },
          },
        }),
        /providers\.minimax\.traits\.inlineThinking\.tag 须是非空字符串/,
      ],
      // 窗长写坏了**报错不降级**——宁可启动期一声响，也别拿一个假分母去画进度（D10）
      [
        validConfig({
          providers: { minimax: { baseURL: 'https://x/v1', model: 'm', contextWindow: '200k' } },
        }),
        /providers\.minimax\.contextWindow 须是正整数/,
      ],
      [
        validConfig({
          providers: { minimax: { baseURL: 'https://x/v1', model: 'm', contextWindow: 0 } },
        }),
        /providers\.minimax\.contextWindow 须是正整数/,
      ],
      [validConfig({ dataDir: 7 }), /dataDir 须是非空字符串/],
      [[1, 2, 3], /配置根 须是对象/],
    ]

    for (const [body, pattern] of cases) {
      expect(() => loadFrom(body)).toThrow(pattern)
    }
  })
})

describe('密钥纪律', () => {
  test('自检文本只说 key 的来处，不吐 key 本身', () => {
    const loaded = loadFrom(validConfig())
    const text = describeConfig(loaded)

    expect(text).toContain('key 取自配置文件')
    expect(text).not.toContain('sk-test-not-a-real-key')
  })

  test('配置里没有 key——自检报环境变量那名（且仍不吐任何值）', () => {
    const loaded = loadFrom(
      validConfig({ providers: { minimax: { baseURL: 'https://x/v1', model: 'm' } } }),
    )
    const text = describeConfig(loaded)

    expect(apiKeyEnvVarOf('minimax')).toBe('MAGIC_MINIMAX_API_KEY')
    expect(text).toContain('key 取自环境变量 MAGIC_MINIMAX_API_KEY')
  })

  test('环境变量名的映射规则取自契约（非字母数字 → `_`）', () => {
    expect(apiKeyEnvVarOf('my-vendor')).toBe('MAGIC_MY_VENDOR_API_KEY')
  })
})

/**
 * U18 · **工作区根列表**（阶段 3 加键）——判据：**形制在此判 · 语义归执行域**。
 *
 * 两半合起来才说明「分工不是一句注释」：
 * - 这里钉**形制**那半（须是非空字符串的数组）——JSON 的事；
 * - **语义**那半（绝对 / 存在 / 是目录 / 重复）钉在 `@magic/execution` 的
 *   `workspace.test.ts`——那要碰 fs，且**根的身份**（`realpath` 后）只有执行域说了算。
 *
 * ⚠️ **漏带＝静默失效**：配置里写了 `workspaceRoots` 而加载器不接，工作区就悄悄退回
 * 启动目录单根**且不报错**（同权限段那条教训）。故「加载器真把它带出来了」这一条
 * 必须有用例钉着，别顺手删。
 */
describe('工作区根列表（阶段 3 加键）', () => {
  test('键缺省 —— **不给这一位**（不是空数组）', () => {
    // 缺省与空数组是两件事：前者＝回落启动目录（阶段 1 姿态），后者＝「一条根都没有」。
    // 合成一个，装配就分不出「没配」与「配空了」——前者合法、后者是错。
    expect(loadFrom(validConfig()).config.workspaceRoots).toBeUndefined()
  })

  test('照读——顺序原样带出（**第一项＝默认根**，顺序即语义）', () => {
    const loaded = loadFrom(
      validConfig({ workspaceRoots: ['/work/a', '/work/b', '/work/c'] }),
    )

    expect(loaded.config.workspaceRoots).toEqual(['/work/a', '/work/b', '/work/c'])
  })

  test('单根＝一项的特例——不因只有一条而改成标量', () => {
    expect(loadFrom(validConfig({ workspaceRoots: ['/work/only'] })).config.workspaceRoots)
      .toEqual(['/work/only'])
  })

  /**
   * U27 · **根的 `~` 展开**（`U18` 待决 3）——判据：**照 `dataDir` 的先例在加载器展开**。
   *
   * 由头：根是**用户手写在配置文件里**的路径——手写就会写 `~/work`；而当相对路径拒
   * 只会让人困惑（「我明明指了个地方」）。展开的**落点**照 `dataDir`：加载器。
   * 执行域不展开这一条没变（`~` 不是绝对路径——`workspace.test.ts` 有相对的用例钉着）。
   */
  test('前导 `~` 在**加载时展开**——根不再被当成相对路径', () => {
    const loaded = loadFrom(validConfig({ workspaceRoots: ['~/work', '~', '/abs/keep'] }))

    expect(loaded.config.workspaceRoots).toEqual([
      join(HOME, 'work'), // `~/…` → 家目录之下
      HOME, // 裸 `~` ＝ 家目录自身
      '/abs/keep', // 无 `~` 即字面路径——原样
    ])
  })

  test('中段的 `~` 是**字面**——只有前导那一个展开（与 `dataDir` 同一把尺子）', () => {
    // 展开器**与 `dataDir` 是同一个**（契约 `expandHome`）——不是这里另写一套更宽的规则；
    // 这一条钉的就是「同源」：同一把尺子给同一个答案（`/a/~/b` 里的 `~` 是目录名，不是家目录）
    expect(loadFrom(validConfig({ workspaceRoots: ['/a/~/b'] })).config.workspaceRoots)
      .toEqual(['/a/~/b'])
  })

  test('不是数组 → 拒（报错点名到字段）', () => {
    expect(() => loadFrom(validConfig({ workspaceRoots: '/work/a' }))).toThrow(ConfigError)
    expect(() => loadFrom(validConfig({ workspaceRoots: '/work/a' }))).toThrow(/workspaceRoots/)
    expect(() => loadFrom(validConfig({ workspaceRoots: { 0: '/work/a' } }))).toThrow(/数组/)
  })

  test('条目不是非空字符串 → 拒，且点名到**第几项**', () => {
    expect(() => loadFrom(validConfig({ workspaceRoots: [123] }))).toThrow(/workspaceRoots\[0\]/)
    expect(() => loadFrom(validConfig({ workspaceRoots: ['/work/a', ''] })))
      .toThrow(/workspaceRoots\[1\]/)
  })

  test('**相对路径 / 不存在不在这一层判**——形制过了就交给执行域', () => {
    // 加载器判的是 JSON 形状；「是不是个真目录」它不碰 fs、也不该碰（一个真源在执行域）。
    // 故这两条**这里必须放行**——若这里就拒了，说明两处各判了一遍（分叉的开始）。
    expect(loadFrom(validConfig({ workspaceRoots: ['relative/nope'] })).config.workspaceRoots)
      .toEqual(['relative/nope'])
    expect(loadFrom(validConfig({ workspaceRoots: ['/definitely/not/here'] })).config.workspaceRoots)
      .toEqual(['/definitely/not/here'])
  })

  test('空数组**放行**——「零根」的拒归执行域（它才知道默认根取不出来）', () => {
    expect(loadFrom(validConfig({ workspaceRoots: [] })).config.workspaceRoots).toEqual([])
  })
})

/**
 * 项目规约的补充来源（阶段 3 · U32 加键）——判据：**形制从严 · `~` 展开 · 键真被带出来**。
 *
 * ⚠️ **漏带＝静默失效**：配置里点了名而加载器不接，那几份规约就悄悄读不进来**且不报错**
 * （同权限段 / 多根那两条教训）。故「加载器真把它带出来了」这一条必须有用例钉着，别顺手删。
 * 语义那一半（存不存在 / 是文件还是目录）归执行域的规约来源面——它才知道怎么读。
 */
describe('项目规约的补充来源（阶段 3 加键 · U32）', () => {
  test('键缺省 —— **不给这一位**（不是空数组）', () => {
    expect(loadFrom(validConfig()).config.rules).toBeUndefined()
    expect(loadFrom(validConfig({ rules: {} })).config.rules).toBeUndefined()
  })

  test('给了就原样带出来——**漏带＝静默失效**（这一条咬住加载器那一行）', () => {
    const loaded = loadFrom(validConfig({ rules: { sources: ['/shared/rules', '/other.md'] } }))

    expect(loaded.config.rules?.sources).toEqual(['/shared/rules', '/other.md'])
  })

  test('前导 `~` 与其余落点同一个展开器——`~` 不算绝对路径，得在加载时变成字面路径', () => {
    const loaded = loadFrom(validConfig({ rules: { sources: ['~/shared', '~', '/abs/keep'] } }))

    expect(loaded.config.rules?.sources).toEqual([join(HOME, 'shared'), HOME, '/abs/keep'])
    // 中间的 `~` 不是前导——字面保留（同 workspaceRoots 的口径）
    expect(
      loadFrom(validConfig({ rules: { sources: ['/a/~/b'] } })).config.rules?.sources,
    ).toEqual(['/a/~/b'])
  })

  test('形制不对**报错不降级**——对得上名字的是哪一处', () => {
    expect(() => loadFrom(validConfig({ rules: { sources: '/shared' } }))).toThrow(ConfigError)
    expect(() => loadFrom(validConfig({ rules: { sources: '/shared' } }))).toThrow(/rules\.sources/)
    expect(() => loadFrom(validConfig({ rules: { sources: [123] } }))).toThrow(/rules\.sources\[0\]/)
    expect(() => loadFrom(validConfig({ rules: { sources: ['/a', ''] } })))
      .toThrow(/rules\.sources\[1\]/)
  })

  test('空数组**放行**——「一个补充来源都不点名」是合法的（默认那两处来源照旧）', () => {
    expect(loadFrom(validConfig({ rules: { sources: [] } })).config.rules?.sources).toEqual([])
  })

  test('存不存在不在这里判——那是执行域的事（加载器只把用户写的那串变成它指的那个路径）', () => {
    expect(
      loadFrom(validConfig({ rules: { sources: ['/definitely/not/here'] } })).config.rules?.sources,
    ).toEqual(['/definitely/not/here'])
  })

  test('**linkSources 同一个形制、同一个展开器**——两处名册各带各的（2026-09-20 裁）', () => {
    const loaded = loadFrom(
      validConfig({ rules: { sources: ['/load-me'], linkSources: ['~/shared-link'] } }),
    )

    expect(loaded.config.rules?.sources).toEqual(['/load-me'])
    expect(loaded.config.rules?.linkSources).toEqual([join(HOME, 'shared-link')])

    // 只给一处时另一处**不给这一位**（不是空数组——同上面「键缺省」那条口径）
    expect(loadFrom(validConfig({ rules: { linkSources: ['/x'] } })).config.rules?.sources)
      .toBeUndefined()
    expect(() => loadFrom(validConfig({ rules: { linkSources: '/x' } })))
      .toThrow(/rules\.linkSources/)
  })
})

describe('外部工具服务器（U38 · `mcp` 段）', () => {
  test('键缺省 —— **不给这一位**（不是空对象：没配就是没配）', () => {
    expect(loadFrom(validConfig()).config.mcp).toBeUndefined()
  })

  test('照读——条目名是身份，命令 / 参数 / 环境原样带出', () => {
    const loaded = loadFrom(
      validConfig({
        mcp: {
          servers: {
            files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: { TOKEN: 'x' } },
            plain: { command: '/opt/tool' },
          },
        },
      }),
    )

    expect(Object.keys(loaded.config.mcp?.servers ?? {})).toEqual(['files', 'plain'])
    expect(loaded.config.mcp?.servers['files']).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { TOKEN: 'x' },
    })
    // 只给命令的条目：另两位**不给键**（不是空数组 / 空对象）
    expect(loaded.config.mcp?.servers['plain']).toEqual({ command: '/opt/tool' })
  })

  test('`servers` 缺省 ＝ 一条都不连（合法的「不配」）', () => {
    expect(loadFrom(validConfig({ mcp: {} })).config.mcp).toEqual({ servers: {} })
  })

  test('形制不对**报错不降级**——逐条点名到字段', () => {
    expect(() => loadFrom(validConfig({ mcp: 'nope' }))).toThrow(/mcp 须是对象/)
    expect(() => loadFrom(validConfig({ mcp: { servers: [] } }))).toThrow(/mcp\.servers/)
    // **原锚**：`/mcp\.servers\.a\.command/`（那时只有 stdio 一种接入，缺的那位就是它）；
    // **为何变**：U39 加了 HTTP，一个条目「两样都没有」是另一种错（不是只缺 command）；
    // **新锚**：那句错要说清**两样各是什么**。
    expect(() => loadFrom(validConfig({ mcp: { servers: { a: {} } } }))).toThrow(/两样都没有/)
    expect(() => loadFrom(validConfig({ mcp: { servers: { a: { command: 'x', args: 'oops' } } } })))
      .toThrow(/mcp\.servers\.a\.args/)
    expect(() => loadFrom(validConfig({ mcp: { servers: { a: { command: 'x', env: { K: 1 } } } } })))
      .toThrow(/mcp\.servers\.a\.env\.K/)
  })

  test('HTTP 条目——地址 ＋ 请求头（两种接入共用一张表 · U39）', () => {
    const loaded = loadFrom(
      validConfig({
        mcp: {
          servers: {
            remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
            plain: { url: 'https://example.com/mcp' },
          },
        },
      }),
    )

    expect(loaded.config.mcp?.servers['remote']).toEqual({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    })
    // 只给地址的条目：`headers` **不给键**（不是空对象）
    expect(loaded.config.mcp?.servers['plain']).toEqual({ url: 'https://example.com/mcp' })
  })

  test('两种接入**不许都给**；地址与请求头的形制照样逐条点名', () => {
    expect(() =>
      loadFrom(validConfig({ mcp: { servers: { a: { command: 'x', url: 'https://e/mcp' } } } })),
    ).toThrow(/只能是一种接入/)
    expect(() => loadFrom(validConfig({ mcp: { servers: { a: { url: '不是地址' } } } }))).toThrow(
      /mcp\.servers\.a\.url 不是一条能用的地址/,
    )
    expect(() =>
      loadFrom(validConfig({ mcp: { servers: { a: { url: 'https://e/mcp', headers: { K: 1 } } } } })),
    ).toThrow(/mcp\.servers\.a\.headers\.K/)
    // 头里放不下非 ASCII（Bun 的 fetch 当场拒，且报错会**回显那个值**——凭据不许走那条路）
    expect(() =>
      loadFrom(validConfig({ mcp: { servers: { a: { url: 'https://e/mcp', headers: { K: '中文' } } } } })),
    ).toThrow(/可见 ASCII/)
  })

  test('条目名不合规矩即拒——它要拼进工具名（`__` 是分隔符，别的符号供应商那边也不收）', () => {
    const bad = (name: string): boolean => {
      try {
        loadFrom(validConfig({ mcp: { servers: { [name]: { command: 'x' } } } }))
        return false
      } catch (error) {
        return error instanceof ConfigError
      }
    }

    expect(bad('a__b')).toBe(true) // 分隔符本身
    expect(bad('my server')).toBe(true) // 空格
    expect(bad('服务器')).toBe(true) // 非 ASCII（拼进工具名会散给供应商）
    expect(bad('-lead')).toBe(true) // 不是字母数字开头
    // 合规矩的几种：字母数字开头 ＋ `.` `_` `-`
    expect(loadFrom(validConfig({ mcp: { servers: { 'my-files.v2_x': { command: 'x' } } } })).config.mcp)
      .toBeDefined()
  })
})
