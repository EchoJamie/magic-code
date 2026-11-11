import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editConfigFile } from '../src/save.ts'
import { readStateRevision, stateRevisionPathOf } from '../src/state-revision.ts'
import { subscribeState } from '../src/subscribe.ts'

const scraps: string[] = []

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magic-state-'))
  scraps.push(dir)
  return join(dir, 'config.json')
}

afterEach(() => {
  for (const dir of scraps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('配置 state 修订', () => {
  test('每次成功写入 revision+1，订阅者收到一次', async () => {
    const path = tempConfig()
    let notices = 0
    const off = subscribeState(path, revision => {
      notices += 1
      expect(revision).toBeGreaterThan(0)
    })
    try {
      const first = await editConfigFile({ path, update: raw => ({ ok: true, raw: { ...raw, step: 1 } }) })
      expect(first).toEqual({ ok: true })
      expect(readStateRevision(stateRevisionPathOf(path))?.revision).toBe(1)
      expect(notices).toBe(1)

      const second = await editConfigFile({ path, update: raw => ({ ok: true, raw: { ...raw, step: 2 } }) })
      expect(second).toEqual({ ok: true })
      expect(readStateRevision(stateRevisionPathOf(path))?.revision).toBe(2)
      expect(notices).toBe(2)
    } finally {
      off()
    }
  })

  test('修订文件损坏：拒绝写入，配置不动', async () => {
    const path = tempConfig()
    writeFileSync(path, '{"keep":true}\n', 'utf8')
    writeFileSync(stateRevisionPathOf(path), '{ 坏 }', 'utf8')
    const outcome = await editConfigFile({ path, update: raw => ({ ok: true, raw: { ...raw, changed: true } }) })
    expect(outcome.ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{"keep":true}\n')
  })
})
