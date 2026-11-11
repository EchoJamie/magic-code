import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { locateHost, readHostDiscovery, selectedHostConfig } from '../src/run/host-discovery.ts'
import { connectApp } from '../src/run/spawn-manager.ts'
import { cliGround } from './resident-cli-fixture.ts'

describe('Engine 发现与显式打开', () => {

  test('发现是只读：缺席、坏 JSON、缺字段均不创建或修复文件', () => {
    const g = cliGround()
    try {
      const location = locateHost({ home: g.home })
      expect(readHostDiscovery(location)).toBeUndefined()
      g.publish({ ...g.discovery, base: 'relative' })
      expect(() => readHostDiscovery(location)).toThrow('服务身份不完整')
      writeFileSync(g.discoveryPath, '{broken')
      expect(() => readHostDiscovery(location)).toThrow('不是有效 JSON')
      expect(readFileSync(g.discoveryPath, 'utf8')).toBe('{broken')
    } finally { g.close() }
  })

  test('未设 MAGIC_HOME 采用 Engine 已选 base；不再追加 .magic，也不读默认家的坏配置', () => {
    const g = cliGround()
    try {
      mkdirSync(join(g.home, '.magic'))
      writeFileSync(join(g.home, '.magic/config.json'), 'bad default config')
      const selected = selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: {} })
      expect(selected.magic.base).toBe(g.base)
      expect(selected.loaded.path).toBe(join(g.base, 'config.json'))
      expect(selected.loaded.config).not.toHaveProperty('dataDir')
      for (const configured of ['selected', dirname(g.base), '  selected/  ']) {
        expect(selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: { MAGIC_HOME: configured } }).magic.base).toBe(g.base)
      }
      // 原预期 → 新预期：消息里原来同时报**基础目录**与数据目录两半；U109 把守卫收窄成
      // **只比数据实例**（设计 `:99`/`:97` 说的就是「数据实例」「数据目录」）之后，消息里
      // 报的是**真正被比的那一位**。依据：U109 裁决（守卫只比 `dataDir`）。
      // **没变弱**：两条判据仍是「以那个理由拒绝」，且报出的正是**判据本身**——原来那两半里
      // 有一半（基础目录）根本不该参与比较。
      expect(() => selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: { MAGIC_HOME: 'elsewhere' } })).toThrow('CLI 基础目录=')
      expect(() => selectedHostConfig(g.discovery, { home: g.home, cwd: g.root, env: { MAGIC_HOME: 'elsewhere' } })).toThrow('Engine 基础目录=')
    } finally { g.close() }
  })
  test('未发布发现记录时也先核终端显式实例，差异不启动 Engine', async () => {
    const g = cliGround(), actions: string[] = []
    try {
      await expect(connectApp({ home: g.home, intent: 'open', env: { MAGIC_HOME: join(g.root, 'other') }, control: async action => {
        actions.push(action); return { state: 'stopped', base: g.base }
      } })).rejects.toThrow('数据实例不匹配')
      expect(actions).toEqual(['status'])
      expect(() => locateHost({ home: g.home, standalone: true })).toThrow('Engine 未安装')
    } finally { g.close() }
  })
})
