/** 验证未配置模型连接时的启动、提示与本地操作。 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { loadConfig } from '../src/index.ts'
import { noModelAdvice, noModelRefusal, providerRemovedNote } from '../src/run/observation.ts'
import { createSandbox } from './ui/sandbox.ts'
import { magicAt } from './tmp.ts'

// —— 装置：沙地造得出「空配置」那一形 ——

describe('装置 · 沙地能造空配置的实例', () => {
  test('`provider: \'none\'`：配置文件**根本不落**——干净机器那一形', () => {
    const sandbox = createSandbox({ provider: 'none' })
    try {
      expect(existsSync(sandbox.configPath)).toBe(false)

      // 加载器走的是 ENOENT 那一支（首次运行就是这样）：一位供应商都没有，而**不报错**
      const loaded = loadConfig({ path: sandbox.configPath, magic: magicAt(sandbox.home) })
      expect(loaded.providerId).toBeUndefined()
      expect(Object.keys(loaded.config.providers)).toEqual([])
      // 数据目录回落到基础目录（配置里那一行本来就没写）——沙地照实跟它对齐
      expect(loaded.config).not.toHaveProperty('dataDir')
      expect(sandbox.dataDir).toBe(`${sandbox.home}/.magic`)
    } finally {
      sandbox.dispose()
    }
  })

  test('**能重复起**：两次各是一块独立的沙地，都起得来', () => {
    const one = createSandbox({ provider: 'none' })
    const two = createSandbox({ provider: 'none' })
    try {
      expect(one.root).not.toBe(two.root)
      expect(existsSync(one.workspace)).toBe(true)
      expect(existsSync(two.workspace)).toBe(true)
      expect(existsSync(one.configPath)).toBe(false)
      expect(existsSync(two.configPath)).toBe(false)
    } finally {
      one.dispose()
      two.dispose()
    }
  })

  test('**不牵动既有的合成配置那条路**：不传就是原来那一条（合成 `local`）', () => {
    const sandbox = createSandbox()
    try {
      expect(existsSync(sandbox.configPath)).toBe(true)
      const raw = JSON.parse(readFileSync(sandbox.configPath, 'utf8')) as Record<string, unknown>
      expect(raw['models']).toEqual(Object.fromEntries(['default', 'cantrip', 'spell', 'arcane'].map(choice => [choice, { provider: 'local', model: 'MiniMax-M3' }])))
      expect(Object.keys(raw['providers'] as Record<string, unknown>)).toEqual(['local'])

      const loaded = loadConfig({ path: sandbox.configPath, magic: magicAt(sandbox.home) })
      expect(loaded.providerId).toBe('local')
      expect(sandbox.dataDir).toBe(`${sandbox.home}/.magic`)
    } finally {
      sandbox.dispose()
    }
  })
})

// —— 那几句话：三处各自只说别处没说的 ——

describe('那几句话', () => {
  const UNCONFIGURED = { connections: 0, hasModel: false }
  const UNSELECTED = { connections: 2, hasModel: false }
  const READY = { connections: 1, hasModel: true }

  test('发得出去时**一个字都不说**（三处都是）', () => {
    expect(noModelAdvice(READY)).toBeUndefined()
    expect(noModelRefusal(READY)).toBeUndefined()
    expect(providerRemovedNote('a', READY)).toBe('「a」已断开')
  })

  test('启动提示使用可直接执行的接入命令，不引用旧列表顺序', () => {
    expect(noModelAdvice(UNCONFIGURED)).toBe(
      '还没有接上供应商——敲 /model connect 接一条',
    )
    // 另一形没有「第一条就是它」那半（那一屏铺的是连接本身，不是接供应商那一行）
    expect(noModelAdvice(UNSELECTED)).toBe('还没有选好走哪个模型——敲 /model 挑一个')
  })

  test('**提交被拦那一句**多一件「稿子去哪儿了」', () => {
    expect(noModelRefusal(UNCONFIGURED)).toBe(
      '还没有接上供应商——敲 /model connect 接一条（原稿在 ↑ 里）',
    )
    // ⚠️ 下一步要敲的是命令，故**稿子不占着输入行**——不还回去就得说清它在哪儿
    expect(noModelRefusal(UNCONFIGURED)).toContain('原稿在 ↑ 里')
  })

  test('**删完之后那一句**：先说刚发生的事，再接同一句实话', () => {
    expect(providerRemovedNote('local', UNCONFIGURED)).toBe(
      '「local」已断开，还没有接上供应商——敲 /model connect 接一条',
    )
    expect(providerRemovedNote('local', UNSELECTED)).toBe(
      '「local」已断开，还没有选好走哪个模型——敲 /model 挑一个',
    )
    // ⚠️ **不编「已换成别人」**：移除不替用户挑（静默级联正是要防的那件事）
    for (const state of [UNCONFIGURED, UNSELECTED, READY]) {
      expect(providerRemovedNote('local', state)).not.toContain('已换成')
    }
  })

  test('那几句里**没有内部词**（架构词 / 包名 / 字段名一律不留）', () => {
    const said = [
      noModelAdvice(UNCONFIGURED),
      noModelAdvice(UNSELECTED),
      noModelRefusal(UNCONFIGURED),
      noModelRefusal(UNSELECTED),
      providerRemovedNote('local', UNCONFIGURED),
      providerRemovedNote('local', UNSELECTED),
    ].join(' ')

    for (const word of ['@magic', '装配', '注册表', 'defaultProvider', 'providers', 'providerId']) {
      expect(said).not.toContain(word)
    }
  })
})
