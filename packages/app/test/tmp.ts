/**
 * 测试用地——**临时目录**（数据落点 · 工作区根 · 配置文件）。
 *
 * 每个用例一块沙地：数据该写哪儿、工作区认哪儿、配置从哪儿读——都在这里量。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 造一个空目录（`mkdtemp`——名字不撞车）。 */
export function tempDir(prefix = 'magic-app-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 用例收尾——删干净，不留垃圾。 */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** 把一份配置写进目录，返回路径。 */
export function writeConfig(dir: string, body: unknown): string {
  const path = join(dir, 'config.json')
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8')
  return path
}

/** 一份能用的配置（形制照冻结的字面）——各用例按需改字段。 */
export function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaultProvider: 'minimax',
    providers: {
      minimax: {
        baseURL: 'https://api.minimaxi.com/v1',
        apiKey: 'sk-test-not-a-real-key',
        model: 'MiniMax-M3',
      },
    },
    dataDir: '~/.magic',
    ...overrides,
  }
}
