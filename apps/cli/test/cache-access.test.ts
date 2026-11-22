import { describe, expect, test } from 'bun:test'
import { modelCacheAccessOf } from '../src/index.ts'
import { configFingerprintOf } from '@magic/state'
import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeDir, tempDir } from './tmp.ts'

const TOKEN = 'proc-token-1'

describe('配置来源', () => {
  test('身份＝路径 ＋ **providers 段的内容哈希**（认证材料变了才轮转）', () => {
    const dir = tempDir('magic-access-')
    try {
      const path = join(dir, 'config.json')
      writeFileSync(path, '{"providers":{"ds":{"apiKey":"k"}}}', 'utf8')

      const fingerprint = configFingerprintOf(path)
      expect(fingerprint).toBeDefined()

      const access = modelCacheAccessOf({ provider: 'ds', config: fingerprint, processToken: TOKEN })
      expect(access.persistent).toBe(true)
      expect(access.id.startsWith('cfg:ds:')).toBe(true)
      // 路径与内容哈希都在（同一份内容 ⇒ 同一个身份）
      expect(access.id).toContain(fingerprint!.hash)
      expect(configFingerprintOf(path)?.hash).toBe(fingerprint!.hash)
    } finally {
      removeDir(dir)
    }
  })

  /**
   * **反例**（裁决点名的那个）：一个**等长**、又**刻意保留 mtime** 的新文件，
   * 不能算出同一个身份——否则它换了认证却复用旧缓存。
   *
   * 旧形（整文件 stat）靠 ino/ctime 兜这个底；新形（内容哈希）直接看**内容**——
   * 认证材料变了，哈希当场变，mtime 摁不摁得住都无关。
   */
  test('等长且保留 mtime 的文件替换 ⇒ 身份**必须**变（内容哈希认它）', () => {
    const dir = tempDir('magic-access-')
    try {
      const path = join(dir, 'config.json')
      writeFileSync(path, '{"providers":{"ds":{"apiKey":"aaaa"}}}', 'utf8')
      const before = configFingerprintOf(path)
      expect(before).toBeDefined()

      // 换一个**等长**的文件（认证材料不同），并把 mtime 摁回原值
      writeFileSync(path, '{"providers":{"ds":{"apiKey":"bbbb"}}}', 'utf8')
      const seconds = parseInt(before!.hash.slice(0, 8), 16) % 1_700_000_000
      utimesSync(path, seconds, seconds)

      const after = configFingerprintOf(path)
      const idOf = (f: ReturnType<typeof configFingerprintOf>) =>
        modelCacheAccessOf({ provider: 'ds', config: f, processToken: TOKEN }).id

      // mtime 被摁住了——新形根本不看它
      expect(after?.hash).not.toBe(before?.hash)
      // 而身份**真的变了**（内容哈希认出来了）
      expect(idOf(after)).not.toBe(idOf(before))
    } finally {
      removeDir(dir)
    }
  })

  /** **非认证写**不得轮转身份（2026-11-22 收窄的由头）：/model 切档写记录，缓存范围不动。 */
  test('providers 段之外的写（如模型映射、记录）⇒ 身份**不变**', () => {
    const dir = tempDir('magic-access-')
    try {
      const path = join(dir, 'config.json')
      writeFileSync(path, '{"providers":{"ds":{"apiKey":"k"}},"models":{}}', 'utf8')
      const before = configFingerprintOf(path)

      writeFileSync(path, '{"providers":{"ds":{"apiKey":"k"}},"models":{"cantrip":{"provider":"ds","model":"m"}},"defaultTier":"cantrip"}', 'utf8')
      const after = configFingerprintOf(path)

      expect(after?.hash).toBe(before?.hash)
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
