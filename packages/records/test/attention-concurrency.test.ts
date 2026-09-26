import { expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttentionItem } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

test('注意事项真进程并发：稳定 id 仅一方插入，确认不互相覆盖，不丢未读', async () => {
  const dir = tempDataDir()
  const writers = 4
  const count = 120
  const go = join(dir, 'go')
  const children = Array.from({ length: writers }, (_, index) => {
    const ready = join(dir, `ready-${index}`)
    const proc = Bun.spawn([
      process.execPath, join(import.meta.dir, 'concurrent-attention-writer.ts'),
      dir, String(index), String(count), ready, go,
    ], { stdout: 'pipe', stderr: 'pipe' })
    return {
      proc, ready,
      stdout: new Response(proc.stdout).text(),
      stderr: new Response(proc.stderr).text(),
    }
  })

  try {
    const deadline = Date.now() + 10_000
    while (children.some((child) => !existsSync(child.ready))) {
      for (const child of children) {
        if (child.proc.exitCode !== null) {
          throw new Error(`并发子进程提前退出 ${child.proc.exitCode}：${await child.stderr}`)
        }
      }
      if (Date.now() > deadline) throw new Error('注意事项并发测试等待子进程报到超时')
      await Bun.sleep(5)
    }
    writeFileSync(go, '')

    const reports = await Promise.all(children.map(async (child) => {
      const code = await child.proc.exited
      const stdout = await child.stdout
      const stderr = await child.stderr
      if (code !== 0) throw new Error(`并发子进程失败 ${code}：${stderr || stdout}`)
      return JSON.parse(stdout) as { inserted: number }
    }))
    expect(reports.reduce((total, report) => total + report.inserted, 0)).toBe(count)

    const expected: AttentionItem[] = []
    for (let index = 0; index < count; index += 1) {
      const value: AttentionItem = {
        id: `shared:${index}`, session: 'same-session', kind: 'needs-you',
        fact: `event:${index}`, at: 1_700_000_000_000 + index,
        unread: index % 2 !== 0, delivered: index % 3 === 0,
      }
      expected.push(value)
      for (let writer = 0; writer < writers; writer += 1) {
        expected.push({
          ...value, id: `private:${writer}:${index}`, fact: `private:${writer}:${index}`,
          unread: true, delivered: false,
        })
      }
    }
    expected.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
    try {
      expect(store.attention.list()).toEqual(expected)
      expect(await store.listSessions()).toEqual([])
    } finally {
      store.close()
    }
  } finally {
    for (const child of children) if (child.proc.exitCode === null) child.proc.kill()
    await Promise.allSettled(children.map((child) => child.proc.exited))
    removeDataDir(dir)
  }
}, 30_000)
