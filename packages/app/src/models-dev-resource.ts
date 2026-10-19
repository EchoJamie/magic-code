import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MODELS_DEV_TTL_MS, MODELS_DEV_URL, parseModelsDev } from '@magic/model'
import type { FetchLike, ModelsDevResource, ModelsDevSnapshot } from '@magic/model'

export const MODELS_DEV_CACHE_FILE = join('cache', 'models.dev.json')
const inflight = new Map<string, Promise<boolean>>()
const failures = new Map<string, { at: number; reason: string }>()

/** 一份公共资源，按需从文件解析。无常驻轮询；成功原子替换，失败保留原文件。 */
export function createModelsDevResource(base: string, fetch: FetchLike, now: () => number = Date.now): ModelsDevResource {
  const file = join(base, MODELS_DEV_CACHE_FILE)
  const read = () => {
    let snapshot: ModelsDevSnapshot | undefined
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8'))
      if (Number.isFinite(cached.fetchedAt) && cached.fetchedAt > 0) snapshot = { fetchedAt: cached.fetchedAt, providers: parseModelsDev(cached.data) }
    } catch { /* 无文件或损坏时等待下一次按需刷新。 */ }
    const failure = failures.get(file)?.reason
    return { ...(snapshot === undefined ? {} : { snapshot }), ...(failure === undefined ? {} : { failure }) }
  }
  return {
    read,
    async refresh(force = false) {
      const running = inflight.get(file)
      if (running) return running
      if (!force) {
        const snapshot = read().snapshot
        if (snapshot && now() - snapshot.fetchedAt < MODELS_DEV_TTL_MS) return false
        const failure = failures.get(file)
        if (failure && now() - failure.at < 60_000) return false
      }
      const task = (async () => {
        const temp = `${file}.${crypto.randomUUID()}.tmp`
        try {
          const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data: unknown = await response.json()
          parseModelsDev(data)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(temp, JSON.stringify({ fetchedAt: now(), data }), { mode: 0o600 })
          renameSync(temp, file)
          failures.delete(file)
        } catch (error) {
          failures.set(file, { at: now(), reason: `Models.dev 刷新失败：${error instanceof Error ? error.message : '无法读取目录'}` })
        } finally { rmSync(temp, { force: true }) }
        return true
      })().finally(() => inflight.delete(file))
      inflight.set(file, task)
      return task
    },
  }
}
