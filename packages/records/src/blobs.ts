/**
 * blob 存储——**全仓唯一的 `blobs/` 写者**（技术方案 · 记录 · 标量口径 v0：写权唯一）。
 *
 * 三个决定：
 * 1. **内容寻址**——引用＝内容字节的 sha256（64 位十六进制）。同内容只落一份（去重），
 *    且引用自带校验位；键即内容，写入天然幂等。
 * 2. **原子落位**——先写临时文件再 `rename`：半截文件永远不会成为引用的目标。
 *    同内容并发写落点相同、字节相同，互踩无害（内容寻址的红利）。
 * 3. **引用不透明但可验**——契约说「消费方不得解析」（`ids.ts` · `BlobRef`），
 *    但**本包自己**须把住入口：非法引用（含路径穿越）在 `get` 处即拒，
 *    不让它变成一次任意的文件读。
 *
 * 阈值（何时算「大负载」）**不在本包**——技术方案 · 记录：转存由调用方
 * （工具分发）经 `RecordsService.blobs` 决定；记录域只负责「放得下、取得回」。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore } from '@magic/contracts'

/** blob 目录名——`<dataDir>/blobs/`（技术方案 · 记录 · 存储：数据落点）。 */
export const BLOBS_DIR = 'blobs'

/** 本包产出的引用形态（sha256 十六进制）。 */
const REF_PATTERN = /^[0-9a-f]{64}$/

/** 同进程内的临时名序号——避免并发写同内容时互踩临时文件。 */
let tempSeq = 0

export function createBlobStore(root: string): BlobStore {
  return {
    async put(data: Uint8Array | string): Promise<string> {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
      const ref = createHash('sha256').update(bytes).digest('hex')
      const target = join(root, ref)

      if (existsSync(target)) return ref

      const temp = join(root, `.${ref}.${process.pid}-${tempSeq++}.tmp`)
      await writeFile(temp, bytes)
      await rename(temp, target)

      return ref
    },

    async get(ref: string): Promise<Uint8Array> {
      if (!REF_PATTERN.test(ref)) {
        throw new Error(
          `非法 blob 引用：${JSON.stringify(ref)}——引用由本包产出（sha256 十六进制），` +
            `非本包形态一律拒读（引用不透明，但入口须把住）`,
        )
      }

      return new Uint8Array(await readFile(join(root, ref)))
    },
  }
}
