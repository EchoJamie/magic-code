/**
 * 跨进程取证的**那个子进程**（U41 · 缓存隔离）——由 `model-cache.test.ts` 用 `bun` 拉起。
 *
 * 它只做一件事：带着**给定的接入身份**真跑一趟模型信息获取、真落盘。落点与父进程共用
 * （`MC_DIR`），身份由 `MC_ACCESS` 给——于是「旧身份那份写不到新身份的读面上」这件事
 * 有一个**真进程、真文件**的对手盘，不拿内存端口冒充。
 *
 * 一般不手跑（由测试拉起）；手跑：
 *   MC_DIR=<数据目录> MC_ACCESS=<接入身份> bun packages/app/test/model-cache-child.ts
 */

import { createModelInfoService } from '@magic/model'
import { createFileModelInfoCache } from '../src/model-cache.ts'

const dir = process.env['MC_DIR']
if (dir === undefined || dir.length === 0) {
  console.error('缺少 MC_DIR')
  process.exit(2)
}

const accessId = process.env['MC_ACCESS']
if (accessId === undefined || accessId.length === 0) {
  console.error('缺少 MC_ACCESS')
  process.exit(2)
}

const cache = createFileModelInfoCache(dir)
const service = createModelInfoService({
  connections: () => [
    {
      id: 'ds',
      config: { vendor: 'deepseek', baseURL: 'http://new.invalid' },
      baseURL: 'http://new.invalid',
      apiKey: 'fake-new',
      access: { id: accessId, persistent: true },
    },
  ],
  cache,
  fetch: async () =>
    Response.json({ object: 'list', data: [{ id: 'NEW-ENDPOINT-ONLY', object: 'model' }] }),
  now: () => Date.now(),
})

const read = await service.refresh('ds')
if (read.snapshot === undefined) {
  console.error(`子进程没取到：${read.failure?.reason ?? '无失败缘由'}`)
  process.exit(3)
}

process.exit(0)
