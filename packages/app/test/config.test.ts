/**
 * U11 · 配置加载 —— 判据：**形制照读**（字面冻结）· **`dataDir` 前导 `~` 在加载时展开** ·
 * key 解析不在此处但**永不落日志**。
 *
 * 第 2 条是**跨域对证**：本文件既断言加载器把 `~` 展开，也断言**原样交给记录域会被它拒**
 * ——两处合起来才说明「展开必须发生在交给它之前」不是一句注释。
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { CONFIG_FILE, DEFAULT_DATA_DIR, apiKeyEnvVarOf } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { ConfigError, describeConfig, loadConfig } from '../src/index.ts'
import { removeDir, tempDir, validConfig, writeConfig } from './tmp.ts'

/** 家目录——注入值（契约层的展开函数不读环境，故由调用方给）。 */
const HOME = '/home/tester'

function loadFrom(body: unknown, extra: { path?: string } = {}) {
  const dir = tempDir('magic-config-')
  const path = extra.path ?? writeConfig(dir, body)
  try {
    return loadConfig({ path, home: HOME })
  } finally {
    removeDir(dir)
  }
}

describe('形制照读（字面冻结）', () => {
  test('三件落地——defaultProvider / providers / dataDir', () => {
    const loaded = loadFrom(validConfig())

    expect(loaded.providerId).toBe('minimax')
    expect(loaded.provider.model).toBe('MiniMax-M3')
    expect(loaded.provider.baseURL).toBe('https://api.minimaxi.com/v1')
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
    expect(withTraits.provider.traits).toEqual({ inlineThinking: { tag: 'think' } })

    const empty = loadFrom(
      validConfig({
        providers: { minimax: { baseURL: 'https://x/v1', model: 'm', traits: {} } },
      }),
    )
    // `{}` ＝**显式声明无特征**——不是「按常规处理」，故必须存在且为空对象
    expect(empty.provider.traits).toEqual({})

    const none = loadFrom(
      validConfig({ providers: { minimax: { baseURL: 'https://x/v1', model: 'm' } } }),
    )
    expect(none.provider.traits).toBeUndefined()
  })

  test('缺省配置文件落点＝契约的 CONFIG_FILE（不在 app 里重写一份字面量）', () => {
    expect(CONFIG_FILE).toBe('~/.magic/config.json')
    // 不传 path 时读 CONFIG_FILE——展开后即 `${HOME}/.magic/config.json`（此处置家目录探针）
    expect(() => loadConfig({ home: HOME })).toThrow(ConfigError)
    try {
      loadConfig({ home: HOME })
    } catch (error) {
      expect((error as ConfigError).path).toBe(join(HOME, '.magic/config.json'))
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

  test('dataDir 缺省——补契约的 DEFAULT_DATA_DIR 再展开', () => {
    const body = validConfig()
    delete body['dataDir']

    expect(DEFAULT_DATA_DIR).toBe('~/.magic')
    expect(loadFrom(body).config.dataDir).toBe(join(HOME, '.magic'))
  })

  test('展开**必须**在交给记录域之前——原样交过去会被拒（跨域对证）', () => {
    const dir = tempDir('magic-config-')
    try {
      // 家目录＝真目录，故展开后的落点是能真建的（沙地量，不碰真 ~/.magic）
      const loaded = loadConfig({
        path: writeConfig(dir, validConfig({ dataDir: '~/magic-data' })),
        home: dir,
      })
      expect(loaded.config.dataDir).toBe(join(dir, 'magic-data'))

      // 加载器展开后的值：记录域收下
      const store = createRecordsStore({ dataDir: loaded.config.dataDir })
      expect(store.paths.database).toBe(join(dir, 'magic-data/records.db'))
      store.close()

      // 字面 `~` 直通：记录域当场拒（它不展开——展开归加载器）
      expect(() => createRecordsStore({ dataDir: '~/.magic' })).toThrow(/不展开/)
    } finally {
      removeDir(dir)
    }
  })
})

describe('报错取「一声响」（不静默兜底）', () => {
  test('文件不存在——点名路径', () => {
    const dir = tempDir('magic-config-')
    try {
      expect(() => loadConfig({ path: join(dir, 'nope.json'), home: HOME })).toThrow(ConfigError)
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
      [
        validConfig({ providers: { minimax: { model: 'MiniMax-M3' } } }),
        /providers\.minimax\.baseURL 须是非空字符串/,
      ],
      [
        validConfig({ providers: { minimax: { baseURL: 'https://x/v1' } } }),
        /providers\.minimax\.model 须是非空字符串/,
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
