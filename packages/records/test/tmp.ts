/**
 * 测试用地——**临时数据目录**。
 *
 * 每个用例一个 `mkdtemp` 目录：既是隔离，也让「数据落点」判据可判定——
 * 库该写哪儿、不该写哪儿，都在这块沙地上量。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 造一个空的临时数据目录（尚不存在 `records.db` / `blobs/`）。 */
export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'magic-records-'))
}

/** 用例收尾——删干净，不留垃圾。 */
export function removeDataDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** 库文件落点（判据用常量，与实现各自独立——防实现改名后测试跟着漂）。 */
export function databasePathOf(dataDir: string): string {
  return join(dataDir, 'records.db')
}

/** 某处是否存在名为 `~` 的目录——「库不展开 `~`」的探针。 */
export function hasTildeDir(dir: string): boolean {
  return existsSync(join(dir, '~'))
}
