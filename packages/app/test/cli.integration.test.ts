/** CLI 真子进程：help/version/离线 check 不启动 App，不开库或运行外部工具。 */

import { describe, expect, test } from 'bun:test'
import { existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { parseArgs, connectTerminal } from '../src/cli.ts'
import { cliGround, fakeApp } from './resident-cli-fixture.ts'
import { reopenApp } from '../src/run/spawn-manager.ts'

describe('resident-cli 短路径与终端接回参数', () => {

  test('--open-request UUID 与 session/switch/allow-all 通过真实 hello 转交，不伪造 session', async () => {
    const g = cliGround()
    const server = fakeApp(g)
    const request = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
    try {
      g.publish()
      const parsed = parseArgs(['resume', 'session-real', '--open-request', request, '--model', 'spell', '--allow-all'])
      const connection = await connectTerminal(parsed, { home: g.home, env: { PATH: '/work/bin', API_KEY: 'do-not-send' } })
      const hello = server.messages.find((message) => message.t === 'hello')!
      expect(hello).toMatchObject({ t: 'hello', session: 'session-real', openRequest: request, switch: { choice: 'spell' }, allowAll: true })
      expect(JSON.stringify(hello)).not.toContain('do-not-send')
      connection.client.close()

      const blank = await connectTerminal(parseArgs([]), { home: g.home, env: {} })
      const last = server.messages.filter((message) => message.t === 'hello').at(-1)!
      expect(last).not.toHaveProperty('session')
      expect(last).not.toHaveProperty('openRequest')
      blank.client.close()
    } finally { server.close(); g.close() }
  })

  test('重连按规范路径识别原实例：发现记录与原连接的软链接写法均不产生新工作', async () => {
    const g = cliGround()
    const server = fakeApp(g)
    const choice = join(g.root, 'choice')
    symlinkSync(g.root, choice, 'dir')
    const aliasBase = join(choice, 'selected/.magic')
    const opened: string[] = []
    try {
      // 首连规范化 base，发现文件仍保留声明写法，复现真实 /var 与 /private/var 差异。
      g.publish({ ...g.discovery, base: aliasBase })
      const first = await connectTerminal(parseArgs(['resume', 'session-existing']), { home: g.home, env: {} })
      expect(first.magic.base).toBe(aliasBase)
      first.client.close()
      const again = await reopenApp({
        home: g.home, env: {}, enginePath: g.identity.source,
        expectedInstance: { base: first.magic.base },
        connect: { session: 'session-existing' },
        control: async action => { opened.push(action); return { state: 'ready', base: g.base, record: g.discovery } },
      })
      again.client.close()
      // 反向写法与数据目录软链接也按相同规则归一，不维护另一套比较分支。
      g.publish()
      const canonical = await reopenApp({
        home: g.home, env: {}, enginePath: g.identity.source,
        expectedInstance: { base: aliasBase },
        connect: { session: 'session-existing' },
        control: async action => { opened.push(action); return { state: 'ready', base: g.base, record: g.discovery } },
      })
      canonical.client.close()
      const requests = server.messages.filter(message => message.t !== 'bye')
      expect(requests).toHaveLength(3)
      expect(requests.every(message => message.t === 'hello' && message.session === 'session-existing')).toBe(true)
      expect(opened).toEqual([])
      expect(existsSync(join(g.dataDir, 'records.db'))).toBe(false)
    } finally { server.close(); g.close() }
  })

  test('重连仍拒绝真正不同的基础目录或数据目录，hello 前终止且不创建目录或工作', async () => {
    const g = cliGround()
    const server = fakeApp(g)
    const opened: string[] = []
    const otherBase = join(g.root, 'other-base')
    const otherData = join(g.root, 'other-data')
    try {
      g.publish()
      for (const expectedInstance of [
        { base: otherBase },
        { base: otherData },
      ]) {
        await expect(reopenApp({
          home: g.home, env: {}, enginePath: g.identity.source, expectedInstance,
          connect: { session: 'session-existing' },
          control: async action => { opened.push(action); return { state: 'ready', base: g.base, record: g.discovery } },
        })).rejects.toThrow('数据实例已改变')
      }
      expect(server.messages).toEqual([])
      expect(opened).toEqual([])
      expect(existsSync(otherBase)).toBe(false)
      expect(existsSync(otherData)).toBe(false)
      expect(existsSync(join(g.dataDir, 'records.db'))).toBe(false)
    } finally { server.close(); g.close() }
  })
})
