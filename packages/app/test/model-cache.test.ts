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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelCacheAccess, ModelInfoSnapshot } from '@magic/contracts'
import { assemble, attachShell, loadConfig } from '../src/index.ts'
import { MODEL_CACHE_DIR, createFileModelInfoCache } from '../src/model-cache.ts'
import { magicAt } from './tmp.ts'

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

const SAME_SCOPE = 'deepseek@https://api.deepseek.com'

// ═══════════════════════════════════════════════════════════════════════

describe('落盘形态', () => {
  test('文件名安全编码：id 里的 `/` · `..` · 中文都不会跑出缓存目录', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      const ids = ['../../etc/passwd', 'a/b', '中文连接名']

      for (const provider of ids) {
        await cache.replace(snapshotOf({ provider }), access('cfg:one'))
      }

      // 目录里只有那几个 .json，没有跑出层的子目录、也没有拿 id 原样当名字的
      const files = filesOf(dir)
      expect(files).toHaveLength(ids.length)
      for (const one of files) expect(one.endsWith('.json')).toBe(true)

      // 一个一个读得回来（编码可逆）
      for (const provider of ids) {
        expect((await cache.read(provider, access('cfg:one')))?.provider).toBe(provider)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('仅本用户可读写：文件 0600 · 目录 0700', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      await cache.replace(snapshotOf(), access('cfg:one'))

      const file = statSync(join(dir, MODEL_CACHE_DIR, fileNameOf('ds', 'cfg:one')))
      expect(file.mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, MODEL_CACHE_DIR)).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('原子替换：写完不留临时文件（读到的要么整份旧、要么整份新）', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      await cache.replace(snapshotOf(), access('cfg:one'))
      await cache.replace(snapshotOf({ fetchedAt: 2_000, models: [{ id: 'b' }] }), access('cfg:one'))

      expect(filesOf(dir)).toEqual([fileNameOf('ds', 'cfg:one')])
      expect(
        readFileSync(join(dir, MODEL_CACHE_DIR, fileNameOf('ds', 'cfg:one')), 'utf8'),
      ).toContain('"b"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('损坏可丢弃：读不懂 / 不成形都是「还没有」，不报错也不修复', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      const path = join(dir, MODEL_CACHE_DIR, fileNameOf('ds', 'cfg:one'))
      mkdirSync(join(dir, MODEL_CACHE_DIR), { recursive: true })

      writeFileSync(path, '{ 这不是 JSON')
      expect(await cache.read('ds', access('cfg:one'))).toBeUndefined()

      // 成形但缺关键位（没有 scope）——同样丢弃
      writeFileSync(path, JSON.stringify({ provider: 'ds', fetchedAt: 1, models: [] }))
      expect(await cache.read('ds', access('cfg:one'))).toBeUndefined()

      // 逐条只认有 id 的（那一格是调用时要送的名字）
      writeFileSync(
        path,
        JSON.stringify({
          provider: 'ds',
          scope: 's',
          fetchedAt: 1,
          models: [{ id: 'keep' }, { name: '没有 id' }, 'string 也不是一条'],
        }),
      )
      expect((await cache.read('ds', access('cfg:one')))?.models).toEqual([{ id: 'keep' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('`drop` 之后读面回到「还没有」；重复 drop 无害', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      await cache.replace(snapshotOf(), access('cfg:one'))
      await cache.drop('ds', access('cfg:one'))
      expect(await cache.read('ds', access('cfg:one'))).toBeUndefined()
      await cache.drop('ds', access('cfg:one'))
      expect(await cache.read('ds', access('cfg:one'))).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('范围隔离', () => {
  test('身份再长也落得下：文件名不随身份长度膨胀（真长路径）', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      // 真长身份：配置来源那串本来就是「路径 ＋ 纳秒 ＋ 大小」，路径深一点就上百字节
      const deep = join(
        ...Array.from({ length: 12 }, (_, i) => `segment-${i}-${'x'.repeat(40)}`),
      )
      const longId = `cfg:${'y'.repeat(60)}:${join(dir, deep, 'config.json')}:${Date.now()}000000:12345`
      expect(longId.length).toBeGreaterThan(200) // 它**真的**够长（`NAME_MAX` 通常 255）

      await cache.replace(snapshotOf({ models: [{ id: 'DEEP' }] }), access(longId))
      expect((await cache.read('ds', access(longId)))?.models).toEqual([{ id: 'DEEP' }])

      // 落下的那个文件名本身得在 `NAME_MAX` 之内
      for (const one of filesOf(dir)) expect(Buffer.byteLength(one, 'utf8')).toBeLessThan(255)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('**连接 id 也超长**：两段一起长也落得下（文件名恒为 50 字节）', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      const longProvider = `连接-${'z'.repeat(150)}`
      const longId = `cfg:${'w'.repeat(120)}:${'/very/deep/path/'.repeat(8)}config.json:1:2`

      await cache.replace(snapshotOf({ provider: longProvider, models: [{ id: 'BOTH' }] }), access(longId))
      expect((await cache.read(longProvider, access(longId)))?.models).toEqual([{ id: 'BOTH' }])

      const files = filesOf(dir)
      expect(files).toHaveLength(1)
      expect(files[0]?.length).toBe(50) // 22 + `.` + 22 + `.json`
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('数据目录很深也一样落得下（目录按需建）', async () => {
    const dir = tempDataDir()
    try {
      const deep = join(dir, ...Array.from({ length: 10 }, (_, i) => `d${i}-${'x'.repeat(20)}`))
      const cache = createFileModelInfoCache(deep)

      await cache.replace(snapshotOf({ models: [{ id: 'NESTED' }] }), access('cfg:one'))
      expect((await cache.read('ds', access('cfg:one')))?.models).toEqual([{ id: 'NESTED' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('等不到锁**抛出**（写入失败看得见，不静默丢）', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      // 别人先把锁占着不放（模拟另一个进程卡在写盘里）
      mkdirSync(join(dir, MODEL_CACHE_DIR), { recursive: true })
      writeFileSync(join(dir, MODEL_CACHE_DIR, `${fileNameOf('ds', 'cfg:one')}.lock`), '')

      await expect(cache.replace(snapshotOf(), access('cfg:one'))).rejects.toThrow(/等不到缓存锁/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

  test('读到的必须是当前范围：旧范围那趟无论何时落定，当前范围都读不到它', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)

      // 旧身份那份先写下 —— 用户随后换了认证（身份变），拿到新身份的那趟写下 NEW。
      // 两份**共用同一个 `scope`**：光看范围分不开它们，分开它们的是身份
      await cache.replace(
        snapshotOf({ scope: SAME_SCOPE, fetchedAt: Date.now(), models: [{ id: 'OLD-RANGE' }] }),
        access('cfg:old'),
      )
      await cache.replace(
        snapshotOf({ scope: SAME_SCOPE, fetchedAt: Date.now() + 1, models: [{ id: 'NEW-RANGE' }] }),
        access('cfg:new'),
      )

      // 当前身份读到的是自己那份；**旧那份取得得更晚也进不来**
      expect((await cache.read('ds', access('cfg:new')))?.models).toEqual([{ id: 'NEW-RANGE' }])
      // 反过来也一样，谁也不会串成别人的
      expect((await cache.read('ds', access('cfg:old')))?.models).toEqual([{ id: 'OLD-RANGE' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('清除只碰指定范围：drop 旧范围不动新范围那份', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      await cache.replace(snapshotOf({ scope: SAME_SCOPE, fetchedAt: 1, models: [{ id: 'OLD' }] }), access('cfg:old'))
      await cache.replace(snapshotOf({ scope: SAME_SCOPE, fetchedAt: 2, models: [{ id: 'NEW' }] }), access('cfg:new'))

      // 装配清的是「它那一刻的身份」那份
      await cache.drop('ds', access('cfg:old'))

      expect(await cache.read('ds', access('cfg:old'))).toBeUndefined()
      expect((await cache.read('ds', access('cfg:new')))?.models).toEqual([{ id: 'NEW' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('旧范围残留在盘上没关系：读到它等于没读到（不为删净它造迁移账）', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      await cache.replace(snapshotOf({ models: [{ id: 'STALE' }] }), access('cfg:old'))

      // 换了身份之后，旧那份**还在盘上**——但它已经不是任何人的当前资料
      expect((await cache.read('ds', access('cfg:new')))).toBeUndefined()
      // 也不该有人去「顺手清理」它：位置还在原处
      expect(filesOf(dir)).toEqual([fileNameOf('ds', 'cfg:old')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('同范围内并发：两个写者不丢更新、也不互相踩坏文件', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      const who = access('cfg:same')

      // 同一范围的两个写者同时写，各写各的一份（更旧的那份不该盖回更新的）
      const older = snapshotOf({ fetchedAt: 1_000, models: [{ id: 'OLDER' }] })
      const newer = snapshotOf({ fetchedAt: 2_000, models: [{ id: 'NEWER' }] })
      await Promise.all([cache.replace(older, who), cache.replace(newer, who)])

      // 不论谁先拿到锁，末了都该是更新的那份（且文件完整可读）
      expect((await cache.read('ds', who))?.models).toEqual([{ id: 'NEWER' }])
      // 锁与临时文件都收干净了
      expect(filesOf(dir)).toEqual([fileNameOf('ds', 'cfg:same')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('不落盘的那一类（`persistent: false`）：读不到共享盘、也写不下去', async () => {
    const dir = tempDataDir()
    try {
      const cache = createFileModelInfoCache(dir)
      await cache.replace(snapshotOf({ models: [{ id: 'ON-DISK' }] }), access('cfg:real'))

      const volatile = access('env:proc-1', false)
      // 环境变量来源的独立进程没有可验证的共同身份 ⇒ 不去读别人的东西
      expect(await cache.read('ds', volatile)).toBeUndefined()
      // 它自己也落不了盘
      await cache.replace(snapshotOf({ models: [{ id: 'SHOULD-NOT-LAND' }] }), volatile)
      await cache.drop('ds', volatile)

      expect(filesOf(dir)).toEqual([fileNameOf('ds', 'cfg:real')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('真装配 · 认证轮换', () => {
  /**
   * 装配一套真运行的 app（假端点 · 临时目录）——**不经网络、不读真配置**。
   *
   * 这一条补的是首验反例管不到的**前半截**：反例里 `drop` 是直接调的，于是
   * 「换认证之后旧在途不复活」在**真实保存路径**上成不成立（装配有没有在认证变更处
   * 调 `drop`）没被验过——那是这条链的前提，不是它的结论。
   */
  async function staged() {
    const root = mkdtempSync(join(tmpdir(), 'magic-cache-assembly-'))
    const ws = join(root, 'ws')
    mkdirSync(ws)
    const path = join(root, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: 'ds',
        providers: {
          ds: {
            vendor: 'deepseek',
            baseURL: 'http://fixture.invalid',
            apiKey: 'fake-old',
            model: 'deepseek-flash',
          },
        },
        dataDir: join(root, 'data'),
      }),
    )

    let release!: (r: Response) => void
    const gate = new Promise<Response>((resolve) => {
      release = resolve
    })
    let calls = 0
    const modelFetch = async (url: unknown) => {
      if (String(url).endsWith('/models')) {
        calls += 1
        // 第一趟（旧认证）挂住；换过认证之后再来的那趟立即回
        if (calls === 1) return gate
        return Response.json({ object: 'list', data: [{ id: 'AFTER-ROTATION', object: 'model' }] })
      }
      return new Response('{}', { status: 200 })
    }

    const assembly = assemble({
      cwd: ws,
      // U42：基础路径由 `magic` 一处给（`home:` 那个口已撤）
      config: loadConfig({ path, magic: magicAt(root) }),
      magic: magicAt(root),
      grantsFile: join(root, 'grants.json'),
      modelFetch,
    })
    const shell = attachShell(assembly.shell)
    await assembly.ready()

    type ShellCommand = Parameters<typeof shell.send>[0]
    async function command(
      type: ShellCommand['type'],
      reply: string,
      data: Record<string, unknown> = {},
    ): Promise<any> {
      const pending = shell.until((event: any) => event.kind === reply, 3000)
      shell.send({ ...data, type } as ShellCommand)
      return (await pending).data
    }

    return {
      assembly,
      root,
      command,
      release: (r: Response) => release(r),
      close() {
        shell.dispose()
        assembly.close()
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  /**
   * ⚠️ **待装配接线，这条现在必红**：装配还没把接入身份接上——
   * `assembly.ts` 的 `resolveConnection({ providerId, config })` 不传 `access`，
   * 而 `modelCache.drop(request.provider)` 仍按**旧签名**只传一个参数（运行到就 TypeError）。
   * 两处都在**调用线**的文件里，本线不改；**如实留红，不拿它凑绿**。
   */
  test('【待装配接线】换认证：旧认证那趟的迟到列表不得留在读面', async () => {
    const s = await staged()
    try {
      const stale = s.assembly.modelInfo.refresh('ds') // 旧认证发起一趟（挂住）
      await Bun.sleep(20)

      // **前半截直接看得见**：装配在保存认证时到底调没调 `drop`。
      // 少了这一句，「旧那份没复活」也可能只是恰巧——把前提当结论用是这一轮的老毛病
      const original = s.assembly.modelInfo.drop
      let dropped = 0
      ;(s.assembly.modelInfo as { drop(id: string): Promise<void> }).drop = (id: string) => {
        dropped += 1
        return original.call(s.assembly.modelInfo, id)
      }

      // 用户在这中间换了认证 —— 走**真实**的保存路径
      await s.command('provider.save', 'provider.catalog', { provider: 'ds', apiKey: 'fake-new' })
      expect(dropped).toBeGreaterThan(0)

      s.release(Response.json({ object: 'list', data: [{ id: 'OLD-RANGE-ONLY', object: 'model' }] }))
      await stale
      await Bun.sleep(10)

      // 判据不看「有没有快照」——这一读自己会为新认证再发起一趟（那是正确行为），
      // 拿它当判据会把两件事混起来。看的是：**旧认证那份在不在**
      const ids = s.assembly.modelInfo.read('ds').snapshot?.models.map((one) => one.id) ?? []
      expect(ids).not.toContain('OLD-RANGE-ONLY')
    } finally {
      s.close()
    }
  })
})

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
