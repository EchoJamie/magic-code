import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateService } from '../src/state-service.ts'

const scraps: string[] = []
afterEach(() => { for (const dir of scraps.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function ground(): { path: string; magic: { home: string; base: string } } {
  const root = mkdtempSync(join(tmpdir(), 'magic-state-service-'))
  scraps.push(root)
  const base = join(root, '.magic')
  mkdirSync(base, { recursive: true })
  const path = join(base, 'config.json')
  writeFileSync(path, JSON.stringify({ providers: { ds: { vendor: 'deepseek' } } }))
  return { path, magic: { home: root, base } }
}

describe('配置 state 服务', () => {
  test('用前解析：文件改了才重读，解析失败退回上一份可用值', () => {
    const g = ground()
    const state = createStateService({ path: g.path, magic: g.magic })
    expect(Object.keys(state.current().config.providers)).toEqual(['ds'])

    writeFileSync(g.path, JSON.stringify({ providers: { ds: { vendor: 'deepseek' }, mm: { vendor: 'minimax' } } }))
    const changed = state.resolveAtUse()
    expect(changed.degraded).toBe(false)
    expect(Object.keys(changed.config.config.providers).sort()).toEqual(['ds', 'mm'])

    writeFileSync(g.path, '{ 坏 JSON }')
    const broken = state.resolveAtUse()
    expect(broken.degraded).toBe(true)
    expect(Object.keys(broken.config.config.providers).sort()).toEqual(['ds', 'mm'])
  })

  test('写入提升修订并通知订阅者', async () => {
    const g = ground()
    const state = createStateService({ path: g.path, magic: g.magic })
    const seen: number[] = []
    const off = state.subscribe(revision => seen.push(revision))
    try {
      const result = await state.update({ update: raw => ({ ok: true, raw: { ...raw, statusLine: { cells: [] } } }) })
      expect(result.ok).toBe(true)
      expect(state.revision()).toBe(1)
      expect(seen).toEqual([1])
    } finally { off() }
  })
})
