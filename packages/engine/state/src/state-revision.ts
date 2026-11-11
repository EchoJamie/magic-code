/**
 * 配置 state 的修订记录——`<magic-home>/state-revision.json`。
 *
 * 配置文件仍是 `config.json`（用户配置不迁移、不改名）；本文件只记：
 * - `revision`：每次成功写入 +1；
 * - `lastKnownGood`：最后一次成功写入内容的 sha256（启动时用来判断当前文件是否仍是那一份）；
 * - `updatedAt`：epoch 毫秒。
 *
 * 写入走临时文件 + rename，权限 600。损坏不静默重置：读的人拿到错误，由调用方决定
 * 回退到上一份可用值还是拒绝启动。
 */
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const STATE_REVISION_FILE = 'state-revision.json'

export type StateRevision = {
  readonly revision: number
  readonly lastKnownGood: string
  readonly updatedAt: number
}

export function stateRevisionPathOf(configPath: string): string {
  return join(dirname(configPath), STATE_REVISION_FILE)
}

/** 读修订；文件不存在返回 `undefined`（首次启动）；损坏或形状不符抛出。 */
export function readStateRevision(path: string): StateRevision | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw new Error(`读不到 state 修订：${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`state 修订不是合法 JSON：${path}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`state 修订形状不符：${path}`)
  }
  const value = parsed as Record<string, unknown>
  const revision = value['revision']
  const lastKnownGood = value['lastKnownGood']
  const updatedAt = value['updatedAt']
  if (!Number.isSafeInteger(revision) || Number(revision) < 0 || typeof lastKnownGood !== 'string' || lastKnownGood === '' || !Number.isSafeInteger(updatedAt)) {
    throw new Error(`state 修订形状不符：${path}`)
  }
  return { revision: Number(revision), lastKnownGood, updatedAt: Number(updatedAt) }
}

/** 写修订（原子替换）。 */
export function writeStateRevision(path: string, revision: StateRevision): void {
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    writeFileSync(temp, `${JSON.stringify(revision, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** 文件内容的 sha256——只有内容，不含路径、时间或凭据名。 */
export function contentHashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 当前文件是否仍是记录里的 last-known-good。 */
export function isLastKnownGood(path: string, revision: StateRevision | undefined): boolean {
  if (revision === undefined) return false
  try {
    return contentHashOf(path) === revision.lastKnownGood
  } catch {
    return false
  }
}
