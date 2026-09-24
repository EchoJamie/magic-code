/**
 * U60 · **「还没接供应商」这一形**——装置那一侧 ＋ 那几句话。
 *
 * 两件事分开验（真 PTY 那三形在 `frames-u60-tui.ts`，这儿只钉**不靠终端就说得清**的那半）：
 *
 * 1. **装置**：沙地造得出**空配置**（0 供应商）的实例——这一形原先**造不出来**
 *    （`createSandbox` 写死一条合成 `local`），于是它一路没被验过；
 * 2. **那几句话**：同一件事在三处念（起手 · 提交被拦 · 删完之后），**各自只说别处没说的**
 *    ——这句话说不说得圆，是纯函数的事，不必起终端。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { loadConfig } from '../src/index.ts'
import { noModelAdvice, noModelNotice, noModelRefusal, providerRemovedNote } from '../src/assembly.ts'
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
      expect(loaded.config.dataDir).toBe(sandbox.dataDir)
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
      expect(raw['defaultProvider']).toBe('local')
      expect(Object.keys(raw['providers'] as Record<string, unknown>)).toEqual(['local'])

      const loaded = loadConfig({ path: sandbox.configPath, magic: magicAt(sandbox.home) })
      expect(loaded.providerId).toBe('local')
      expect(sandbox.dataDir).not.toBe(`${sandbox.home}/.magic`)
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
    expect(noModelNotice(READY)).toBeUndefined()
    expect(noModelRefusal(READY)).toBeUndefined()
    expect(providerRemovedNote('a', READY)).toBe('「a」已断开')
  })

  test('**缺什么 · 怎么接**：两形分开说（合成一句就得含糊）', () => {
    expect(noModelAdvice(UNCONFIGURED)).toContain('还没有接上供应商')
    expect(noModelAdvice(UNCONFIGURED)).toContain('/model connect')
    expect(noModelAdvice(UNSELECTED)).toContain('还没有选好走哪个模型')
    expect(noModelAdvice(UNSELECTED)).toContain('/model 挑一个')
    // **不说错话**：有连接时不许说「还没接供应商」
    expect(noModelAdvice(UNSELECTED)).not.toContain('还没有接上供应商')
  })

  test('**起手那一句**多一件「在哪儿」——报的是 `/model` 那一屏里真有的那一行', () => {
    expect(noModelNotice(UNCONFIGURED)).toBe(
      '还没有接上供应商——敲 /model connect 接一条（/model 那一屏第一条就是它）',
    )
    // 另一形没有「第一条就是它」那半（那一屏铺的是连接本身，不是接供应商那一行）
    expect(noModelNotice(UNSELECTED)).toBe('还没有选好走哪个模型——敲 /model 挑一个')
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
      noModelNotice(UNCONFIGURED),
      noModelNotice(UNSELECTED),
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
