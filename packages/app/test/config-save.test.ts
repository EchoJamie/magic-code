/**
 * U41 · 配置的写 —— 判据：**原子替换 · 只改点名字段 · 保留无关项 · 外部改过就拒写**。
 *
 * 一条底线：**凭据只进不出**——保存写它（那是它的落点），但任何文案里都没有它。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/index.ts'
import { removeProvider, saveProvider, configureModel } from '../src/config-save.ts'
import { magicAt, removeDir, tempDir, writeConfig } from './tmp.ts'

const READ = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

const PROVIDERS_OF = (path: string): Record<string, Record<string, unknown>> =>
  READ(path)['providers'] as Record<string, Record<string, unknown>>

describe('保存一条连接', () => {
  test('首次（还没有那份文件）能接上——写出来的东西**读得回来**', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = join(dir, 'config.json')

      expect(
        (await saveProvider({ path, request: { provider: 'ds', vendor: 'deepseek', apiKey: 'sk-x' } })),
      ).toEqual({ ok: true })

      // 同一把尺子读回来：一次配置加载应当接受它
      const loaded = loadConfig({ path, magic: magicAt(dir) })
      expect(loaded.config.providers['ds']).toEqual({ vendor: 'deepseek', apiKey: 'sk-x' })
      // 还没有默认选择（那是「设为默认」的事）
      expect(loaded.providerId).toBeUndefined()
    } finally {
      removeDir(dir)
    }
  })

  test('**只改点名的字段**：改名字不动凭据、不动别条连接', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, {
        models: {default: {provider: "a", model: 'm1'}, cantrip: {provider: "b", model: 'm2'}, spell: {provider: "a", model: 'm1'}, arcane: {provider: "a", model: 'm1'}},
        providers: {
          a: { vendor: 'minimax', baseURL: 'https://a/v1', apiKey: 'sk-secret-a' },
          b: { vendor: 'minimax', baseURL: 'https://b/v1', apiKey: 'sk-secret-b' },
        },
        dataDir: '~/.magic',
      })

      expect((await saveProvider({ path, request: { provider: 'a', name: '我的那条' } }))).toEqual({
        ok: true,
      })

      const providers = PROVIDERS_OF(path)
      expect(providers['a']).toEqual({
        baseURL: 'https://a/v1',
        apiKey: 'sk-secret-a', // **没被抹掉**（缺省＝不改）
        vendor: 'minimax',
        name: '我的那条',
      })
      expect(providers['b']).toEqual({ baseURL: 'https://b/v1', apiKey: 'sk-secret-b', vendor: 'minimax' })
    } finally {
      removeDir(dir)
    }
  })

  test('给空串 ⇒ **清掉那一位**（明确要抹掉）；凭据给空串即回到环境变量回退', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, {
        providers: { a: { vendor: 'deepseek', apiKey: 'sk-x', name: '旧名' } },
      })

      ;(await saveProvider({ path, request: { provider: 'a', name: '', apiKey: '' } }))

      const entry = PROVIDERS_OF(path)['a'] ?? {}
      expect('name' in entry).toBe(false)
      expect('apiKey' in entry).toBe(false)
      expect(entry['vendor']).toBe('deepseek') // 没点名的一律不动
    } finally {
      removeDir(dir)
    }
  })

  test('**保留无关项**：权限 / MCP / 未知键原样带过（只有 `providers` 被动过）', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, {
        providers: { a: { vendor: 'deepseek' } },
        permissions: { rules: [{ tool: 'read', path: 'src/**', op: 'allow' }] },
        mcp: { servers: { echo: { command: 'echo' } } },
        workspaceRoots: ['/work'],
        某个以后才认得的键: { 原样: true },
      })

      ;(await saveProvider({ path, request: { provider: 'a', vendor: 'deepseek' } }))

      const raw = READ(path)
      expect(raw['permissions']).toEqual({ rules: [{ tool: 'read', path: 'src/**', op: 'allow' }] })
      expect(raw['mcp']).toEqual({ servers: { echo: { command: 'echo' } } })
      expect(raw['workspaceRoots']).toEqual(['/work'])
      expect(raw['某个以后才认得的键']).toEqual({ 原样: true })
    } finally {
      removeDir(dir)
    }
  })

  test('文件权限 600（缓存与配置都只有本用户读得了）', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, { providers: {} })
      ;(await saveProvider({ path, request: { provider: 'a', vendor: 'deepseek' } }))

      // 只比权限那几位（掩码之外的位随平台而异）
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      removeDir(dir)
    }
  })
})

describe('拒写的两种情形', () => {
  test('坏内容 ⇒ 拒写并点名（**不当空配置覆盖**）', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = join(dir, 'config.json')
      writeFileSync(path, '{ 这不是 JSON }', 'utf8')

      const outcome = (await saveProvider({ path, request: { provider: 'a', vendor: 'deepseek' } }))
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.reason).toMatch(/不是合法 JSON/)
      // 原文件**一个字节没动**
      expect(readFileSync(path, 'utf8')).toBe('{ 这不是 JSON }')
    } finally {
      removeDir(dir)
    }
  })

  test('外部改过（文件指纹变了）⇒ 拒写，提示重新载入（不拿陈旧整份覆盖）', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, { providers: { a: { vendor: 'deepseek' } } })
      const loaded = loadConfig({ path, magic: magicAt(dir) })

      // 模拟「用户在编辑器里改过」——mtime 变了
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`, 'utf8')

      const outcome = (await saveProvider({
        path,
        expectedStamp: loaded.stamp,
        request: { provider: 'b', vendor: 'deepseek' },
      }))
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.reason).toMatch(/已被修改/)
    } finally {
      removeDir(dir)
    }
  })

  test('mtime 一致时照写（比对本身不该误伤正常保存）', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, { providers: { a: { vendor: 'deepseek' } } })
      const loaded = loadConfig({ path, magic: magicAt(dir) })

      expect(
        (await saveProvider({
          path,
          expectedStamp: loaded.stamp,
          request: { provider: 'a', name: '改个名' },
        })),
      ).toEqual({ ok: true })
    } finally {
      removeDir(dir)
    }
  })
})

describe('移除与设为默认', () => {
  test('仍被映射引用时拒绝移除；显式清除后可删，其他映射不变', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, { models: { default: { provider: 'a', model: 'm1' }, spell: { provider: 'b', model: 'm2' } }, providers: { a: { vendor: 'deepseek' }, b: { vendor: 'minimax' } } })
      const before = readFileSync(path, 'utf8')
      expect((await removeProvider({ path, provider: 'a' })).ok).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(before)
      writeFileSync(path, JSON.stringify({ ...READ(path), models: { spell: { provider: 'b', model: 'm2' } } }))
      expect((await removeProvider({ path, provider: 'a' }))).toEqual({ ok: true })
      expect(Object.keys(PROVIDERS_OF(path))).toEqual(['b'])
      expect(READ(path)['models']).toEqual({ spell: { provider: 'b', model: 'm2' } })
    } finally { removeDir(dir) }
  })

  test('删**最后一条**（它同时是默认）：删得掉——删到空是一条正经状态', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, {
        models: {},
        providers: { only: { vendor: 'deepseek' } },
      })

      expect((await removeProvider({ path, provider: 'only' }))).toEqual({ ok: true })
      expect(READ(path)).toEqual({ providers: {}, models: {} })
      // 空配置**读得回来**（U41 起 `providers` / `defaultProvider` 都可缺）
      const loaded = loadConfig({ path, magic: magicAt(dir) })
      expect(loaded.providerId).toBeUndefined()
      expect(Object.keys(loaded.config.providers)).toEqual([])
    } finally {
      removeDir(dir)
    }
  })

  test('没有那条连接：照旧拒（这不是「删得掉删不掉」的事，是它压根不在）', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, { providers: { a: { vendor: 'deepseek' } } })

      const refused = (await removeProvider({ path, provider: 'nope' }))
      expect(refused.ok).toBe(false)
      expect(refused.ok === false && refused.reason).toMatch(/没有「nope」这条连接/)
      expect(Object.keys(PROVIDERS_OF(path))).toEqual(['a'])
    } finally {
      removeDir(dir)
    }
  })

  test('保存 Default 只改映射；接入、覆盖和其他档位保持原样', async () => {
    const dir = tempDir('magic-save-')
    try {
      const provider = { vendor: 'deepseek', modelOverrides: { old: { limits: { maxInputTokens: 128 } } } }
      const path = writeConfig(dir, { providers: { a: provider }, models: { cantrip: { provider: 'a', model: 'old' } } })
      expect((await configureModel({ path, request: { choice: 'default', provider: 'a', model: 'new' } }))).toEqual({ ok: true })
      expect(PROVIDERS_OF(path)['a']).toEqual(provider)
      expect(READ(path)['models']).toEqual({ default: { provider: 'a', model: 'new' }, cantrip: { provider: 'a', model: 'old' } })
    } finally { removeDir(dir) }
  })

  test('保存 Cantrip 不改 Default；不在连接上写型号或思考设置', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, { providers: { a: { vendor: 'deepseek' } }, models: { default: { provider: 'a', model: 'main' } } })
      expect((await configureModel({ path, request: { choice: 'cantrip', provider: 'a', model: 'aux' } }))).toEqual({ ok: true })
      expect(READ(path)['models']).toEqual({ default: { provider: 'a', model: 'main' }, cantrip: { provider: 'a', model: 'aux' } })
      expect(PROVIDERS_OF(path)['a']).toEqual({ vendor: 'deepseek' })
      expect(READ(path)['webFetch']).toBeUndefined()
    } finally { removeDir(dir) }
  })

  test('不存在的接入不能保存为档位，原文件不变', async () => {
    const dir = tempDir('magic-save-')
    try {
      const path = writeConfig(dir, { providers: {} })
      const before = readFileSync(path, 'utf8')
      expect((await configureModel({ path, request: { choice: 'spell', provider: 'ghost', model: 'raw' } })).ok).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(before)
    } finally { removeDir(dir) }
  })
})
