import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MODELS_DEV_TTL_MS, MODELS_DEV_URL, parseModelsDev } from '@magic/model'
import type { FetchLike, ModelsDevResource } from '@magic/model'

export const MODELS_DEV_CACHE_FILE = join('cache', 'models.dev.json')
const inflight = new Map<string, Promise<boolean>>()
const failures = new Map<string, { at: number; reason: string }>()

/** 一份公共资源，按需从文件解析。无常驻轮询；成功原子替换，失败保留原文件。 */
export function createModelsDevResource(base: string, fetch: FetchLike, now: () => number = Date.now): ModelsDevResource {
  const file = join(base, MODELS_DEV_CACHE_FILE)
  /**
   * **解析结果按文件指纹记忆**——这条路径在每次模型请求上（选型校验 → `describe` →
   * `read()`），而一份资料 12MB 量级：无记忆化时每次请求都重付约 30ms 的
   * `JSON.parse` + `parseModelsDev`，且全程压在共享事件循环上。
   *
   * 有效性用 `mtimeMs + size` 判：文件被任何一方（本进程 refresh、同 base 的
   * 其他实例）原子替换后指纹必变，自动回到重读重解析。`statSync` 是微秒级，
   * 相比整份解析可忽略。
   *
   * ⚠️ 命中时交回**同一份** snapshot 对象（不逐次克隆）——消费方（`describe`、
   * 选型校验、目录渲染）都是只读用法；真要改，先拷贝。
   */
  /** `ModelsDevResource['read']` 的返回——类型未出模型包公开面，就地推导。 */
  type ModelsDevRead = ReturnType<ModelsDevResource['read']>
  let memo: { stamp: string; value: ModelsDevRead } | undefined
  const read = (): ModelsDevRead => {
    const failure = failures.get(file)?.reason
    const withFailure = (value: ModelsDevRead): ModelsDevRead =>
      failure === undefined ? value : { ...value, failure }
    try {
      const stat = statSync(file)
      const stamp = `${stat.mtimeMs}:${stat.size}`
      if (memo?.stamp === stamp) return withFailure(memo.value)
      const cached = JSON.parse(readFileSync(file, 'utf8'))
      if (Number.isFinite(cached.fetchedAt) && cached.fetchedAt > 0) {
        const value: ModelsDevRead = { snapshot: { fetchedAt: cached.fetchedAt, providers: parseModelsDev(cached.data) } }
        memo = { stamp, value }
        return withFailure(value)
      }
      memo = undefined
    } catch { /* 无文件或损坏时等待下一次按需刷新。 */ memo = undefined }
    return failure === undefined ? {} : { failure }
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
