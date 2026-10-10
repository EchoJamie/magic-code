import { expect, test } from 'bun:test'
import { startTimeOf } from '../src/groups.ts'

test('同一真实进程的身份时刻不随查询进程时区改变', async () => {
  const actual = (await startTimeOf(process.pid))
  expect(actual).toBeNumber()
  if (actual === undefined) throw new Error('无法读取测试进程的真实启动时刻')
  const entry = new URL('../src/groups.ts', import.meta.url).pathname
  const readings = await Promise.all(['UTC', 'Asia/Shanghai', 'America/Los_Angeles'].map(async (zone) => {
    const child = Bun.spawn([process.execPath, '-e', `import { startTimeOf } from ${JSON.stringify(entry)}; console.log(await startTimeOf(${process.pid}));`], {
      env: { ...process.env, TZ: zone }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return Number(output.trim())
  }))
  expect(readings).toEqual([actual, actual, actual])
})
