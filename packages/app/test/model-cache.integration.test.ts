/**
 * U41 · 模型信息缓存**落盘那一份** —— 判据：**文件名安全 · 仅本用户可读 · 原子替换 ·
 * 损坏可丢弃 · 按「连接 ＋ 接入身份」隔离**。
 *
 * 隔离那几条是「缓存接口裁决」的正题：**旧请求只碰旧范围，读只认当前范围**，
 * 两边根本不相遇——所以判据不问「这份还作不作数」，只问「读的是不是该读的那一份」。
 * 旧范围的文件残留在盘上没关系（可重建的缓存，不是当前范围的资料）。
 *
 * 全程**真文件**（临时目录），不拿内存端口冒充——这一层的价值恰恰在「跨进程共享的
 * 那份盘上状态」，内存实现证不了它。跨进程两条另起**真进程**
 * （`model-cache-child.ts`）。
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelCacheAccess, ModelInfoSnapshot } from '@magic/contracts'

import { MODEL_CACHE_DIR, createFileModelInfoCache } from '../src/model-cache.ts'

/** 一个接入身份——测试里的假值（真身份由装配按认证来源算，见回报）。 */
const access = (id: string, persistent = true): ModelCacheAccess => ({ id, persistent })

/** 连接 id ＋ 身份 → 落盘文件名（与实现同一把尺子：两段 sha256 前 16 字节 ＋ `.json`）。 */
function fileNameOf(providerId: string, accessId: string): string {
  const slug = (raw: string) =>
    createHash('sha256').update(raw, 'utf8').digest('base64url').slice(0, 22)
  return `${slug(providerId)}.${slug(accessId)}.json`
}

/** 一个一次性的数据目录（每个用例各一个，互不串）。 */
function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'magic-cache-'))
}

function filesOf(dataDir: string): readonly string[] {
  try {
    return readdirSync(join(dataDir, MODEL_CACHE_DIR))
  } catch {
    return []
  }
}

function snapshotOf(over: Partial<ModelInfoSnapshot> = {}): ModelInfoSnapshot {
  return {
    provider: 'ds',
    scope: 'deepseek@https://api.deepseek.com',
    fetchedAt: 1_000,
    models: [{ id: 'a' }],
    ...over,
  }
}

describe('跨进程 · 真进程真文件', () => {
  /** 另一进程：用**给定身份**真跑一趟真落盘（脚本见 `model-cache-child.ts`）。 */
  function runChild(dataDir: string, accessId: string): { readonly code: number | null } {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'model-cache-child.ts')], {
      env: { ...process.env, MC_DIR: dataDir, MC_ACCESS: accessId },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: child.exitCode }
  }

  test('旧进程写旧范围的文件，另一进程读当前范围读不到它', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      // 当前身份先写下一份
      await cache.replace(
        snapshotOf({ fetchedAt: Date.now(), models: [{ id: 'NEW-ENDPOINT-ONLY' }] }),
        access('cfg:new'),
      )

      // 另一进程带着**旧身份**真跑一趟并落盘（真进程、真文件）
      expect(runChild(dir, 'cfg:old').code).toBe(0)

      // 它写的是**它自己那份**——当前范围读到的仍是自己那份，不受影响
      expect((await cache.read('ds', access('cfg:new')))?.models).toEqual([
        { id: 'NEW-ENDPOINT-ONLY' },
      ])
      // 盘上确实多了一份旧身份的（不是「它压根没写」造出来的假绿）
      expect([...filesOf(dir)].sort()).toEqual(
        [fileNameOf('ds', 'cfg:new'), fileNameOf('ds', 'cfg:old')].sort(),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('一方的清理不碰另一方那份', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      await cache.replace(snapshotOf({ fetchedAt: 1, models: [{ id: 'NEW' }] }), access('cfg:new'))

      // 另一进程用自己的身份写完再清掉自己那份
      expect(runChild(dir, 'cfg:old').code).toBe(0)
      await cache.drop('ds', access('cfg:old'))

      // 新范围那份纹丝不动
      expect((await cache.read('ds', access('cfg:new')))?.models).toEqual([{ id: 'NEW' }])
      expect(filesOf(dir)).toEqual([fileNameOf('ds', 'cfg:new')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
