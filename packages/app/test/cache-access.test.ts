/**
 * U41 返修 · 接入身份（缓存接口裁决）——判据：**改了接入就得换身份**，
 * 且身份里**没有凭据**。
 *
 * 这一层只算身份（缓存实现的 scoped 读写归缓存线）；这里钉的是**算法**：
 * 哪几件进身份、环境变量那一支为什么不落盘。
 */

import { describe, expect, test } from 'bun:test'
import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFingerprintOf, modelCacheAccessOf } from '../src/cache-access.ts'
import { removeDir, tempDir } from './tmp.ts'

const TOKEN = 'proc-token-1'

describe('配置来源', () => {
  test('身份含**六件**：路径（哪一个文件）＋ dev/ino（同一个 inode 吗）＋ 三个变更读数', () => {
    const dir = tempDir('magic-access-')
    try {
      const path = join(dir, 'config.json')
      writeFileSync(path, '{"a":1}', 'utf8')

      const fingerprint = configFingerprintOf(path)
      expect(fingerprint).toBeDefined()

      const access = modelCacheAccessOf({ provider: 'ds', config: fingerprint, processToken: TOKEN })
      expect(access.persistent).toBe(true)
      expect(access.id.startsWith('cfg:ds:')).toBe(true)
      // 逐件都在（顺序即「文件 → inode → 变更」）
      expect(access.id).toContain(String(fingerprint?.ino))
      expect(access.id).toContain(String(fingerprint?.mtimeNs))
      expect(access.id).toContain(String(fingerprint?.ctimeNs))
      expect(access.id).toContain(String(fingerprint?.size))
    } finally {
      removeDir(dir)
    }
  })

  /**
   * **反例**（裁决点名的那个）：一个**等长**、又**刻意保留 mtime** 的新文件，
   * 不能算出同一个身份——否则它换了认证却复用旧缓存。
   *
   * 只取「路径 ＋ mtime ＋ size」会在这里当场失败：三者一模一样。
   */
  test('等长且保留 mtime 的文件替换 ⇒ 身份**必须**变（dev/ino/ctimeNs 认它）', () => {
    const dir = tempDir('magic-access-')
    try {
      const path = join(dir, 'config.json')
      writeFileSync(path, '{"k":"aaaa"}', 'utf8') // 12 字节
      const before = configFingerprintOf(path)
      expect(before).toBeDefined()

      // 换一个**等长**的文件（内容不同），并把 mtime 摁回原值
      writeFileSync(path, '{"k":"bbbb"}', 'utf8')
      const seconds = Number(before!.mtimeNs) / 1e9
      utimesSync(path, seconds, seconds)

      const after = configFingerprintOf(path)
      const idOf = (f: ReturnType<typeof configFingerprintOf>) =>
        modelCacheAccessOf({ provider: 'ds', config: f, processToken: TOKEN }).id

      // 大小与 mtime 都被摁住了——**靠它们认不出来**
      expect(after?.size).toBe(before?.size)
      // 而身份**真的变了**（ino 或 ctimeNs 认出来了）
      expect(idOf(after)).not.toBe(idOf(before))
    } finally {
      removeDir(dir)
    }
  })
})

describe('环境变量来源', () => {
  test('没有可信身份 ⇒ `persistent: false`（**不落盘**）', () => {
    const access = modelCacheAccessOf({ provider: 'ds', processToken: TOKEN })

    expect(access.persistent).toBe(false)
    expect(access.id.startsWith('env:ds:')).toBe(true)
  })

  test('配置文件此刻不可观察（不在 / 读不了）⇒ 也走不落盘那一支', () => {
    const dir = tempDir('magic-access-')
    try {
      // 拿一个不存在的路径去取指纹
      expect(configFingerprintOf(join(dir, 'nope.json'))).toBeUndefined()
    } finally {
      removeDir(dir)
    }
  })
})
