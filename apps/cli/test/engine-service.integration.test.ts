import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { controlService, serviceLabel, type PlatformCommand } from '../src/run/engine-service.ts'
import { connectManager } from '../src/run/client.ts'
import { startFixture } from './ui/fixture.ts'
import { waitFor } from './resident-cli-fixture.ts'

test('Engine 自持平台托管：并发启动唯一、活动工作拒绝切换、失败目标保留、离线切换与旧代次拒绝', async () => {
  const home = mkdtempSync('/tmp/magic-service-'), next = join(home, 'next'), last = join(home, 'last')
  const fixture = startFixture({ turns: [{ kind: 'text', text: 'controlled-active-work', chunks: 80, chunkDelayMs: 250 }] })
  mkdirSync(join(home, '.magic'))
  writeFileSync(join(home, '.magic/config.json'), JSON.stringify({ providers: { local: { baseURL: fixture.baseURL, protocol: 'chat-completions', auth: 'none' } }, models: { default: { provider: 'local', model: 'fixture' } } }))
  let child: ReturnType<typeof Bun.spawn> | undefined, bootstraps = 0, failBootstrap = false
  let definition: { Label: string; ProgramArguments: string[]; RunAtLoad: boolean; KeepAlive: { SuccessfulExit: boolean }; WorkingDirectory: string; EnvironmentVariables?: unknown } | undefined
  const platform: PlatformCommand = async args => {
    if (args[0] === 'bootout') {
      if (child && child.exitCode === null) { child.kill('SIGTERM'); await child.exited }
      return 0
    }
    expect(args[0]).toBe('bootstrap'); bootstraps++
    definition = JSON.parse(Bun.spawnSync(['/usr/bin/plutil', '-convert', 'json', '-o', '-', args[2]!]).stdout.toString())
    if (failBootstrap) return 5
    child = Bun.spawn(definition!.ProgramArguments, { cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    return 0
  }
  let client: Awaited<ReturnType<typeof connectManager>>
  try {
    const starts = await Promise.all([controlService('start', { home }, platform), controlService('start', { home }, platform)])
    expect(starts.map(value => value.state)).toEqual(['ready', 'ready']); expect(bootstraps).toBe(1)
    expect(starts[0]!.record?.serviceInstance).toBe(starts[1]!.record?.serviceInstance)
    expect(definition).toMatchObject({ Label: serviceLabel(home), RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, WorkingDirectory: expect.stringContaining('magic-service-') })
    expect(definition).not.toHaveProperty('EnvironmentVariables')
    expect(definition!.ProgramArguments).toContain('serve'); expect(definition!.ProgramArguments).not.toContain('--app')
    const first = starts[0]!.record!
    client = await connectManager(first.socket, { cwd: home, expectedIdentity: first })
    if (!client) throw new Error('测试客户端未连接')
    let working = false
    client.onEvent(event => { if (event.kind === 'model.call.start') working = true })
    client.send({ type: 'input.submit', text: '保持一个受控在途请求' })
    await waitFor(() => working)
    const blocked = await controlService('switch', { home, parent: next }, platform)
    expect(blocked.state).toBe('failed'); expect(blocked.base).toBe(first.base); expect(bootstraps).toBe(1)
    client.close(); client = undefined
    expect((await controlService('stop', { home }, platform)).state).toBe('stopped')
    // 重新启动空闲实例，以覆盖切换时新目标启动失败仍保存选择。
    const idle = await controlService('start', { home }, platform)
    failBootstrap = true
    const failed = await controlService('switch', { home, parent: next }, platform)
    expect(failed.state).toBe('failed'); expect(failed.base).toBe(join(home, 'next/.magic').replace(/^\/tmp\//, '/private/tmp/'))
    expect((await controlService('status', { home }, platform)).base).toBe(failed.base)
    failBootstrap = false
    const restarted = await controlService('start', { home }, platform)
    expect(restarted.state).toBe('ready'); expect(restarted.base).toBe(failed.base)
    const count = bootstraps
    await expect(controlService('stop', { home, expected: idle.record! }, platform)).rejects.toThrow(/数据实例|代次/)
    expect((await controlService('status', { home }, platform)).state).toBe('ready')
    expect((await controlService('stop', { home }, platform)).state).toBe('stopped')
    const offline = await controlService('switch', { home, parent: last }, platform)
    expect(offline.state).toBe('stopped'); expect(bootstraps).toBe(count)
    await expect(controlService('start', { home, base: first.base }, platform)).rejects.toThrow('数据实例')
    expect(bootstraps).toBe(count)
    expect(readFileSync(join(home, 'Library/Application Support/Magic Code/engine.json'), 'utf8')).toContain('/last')
  } finally {
    client?.close()
    await controlService('remove', { home }, platform)
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await fixture.stop(); rmSync(home, { recursive: true, force: true })
  }
}, 30000)
