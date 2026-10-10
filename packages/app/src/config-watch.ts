import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { LoadedConfig } from './config.ts'
import { configStamp } from './cache-access.ts'

/** 监听父目录以覆盖原子替换；关键业务入口仍各自读取权威配置。 */
export function watchConfig(path: string, load: () => LoadedConfig, apply: (config: LoadedConfig) => Promise<void>, failed: (error: unknown) => void): () => Promise<void> {
  let closed = false, dirty = false, previous: string | null | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  const changed = () => {
    dirty = true
    if (closed || flight) return
    flight = (async () => {
      while (dirty && !closed) {
        dirty = false
        const stamp = configStamp(path)
        if (stamp === previous) continue
        try {
          const loaded = load()
          await apply(loaded)
          previous = loaded.stamp ?? null
        } catch (error) { failed(error) }
      }
    })().finally(() => { flight = undefined })
  }
  const watcher = watch(dirname(path), (_event, file) => {
    if (file !== null && file.toString() !== basename(path)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(changed, 30)
  })
  watcher.on('error', failed)
  changed()
  return async () => { closed = true; watcher.close(); if (timer) clearTimeout(timer); await flight }
}
