import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { componentDirectory } from '../src/components.ts'
import { createSandbox, createUiSession, startFixture } from './ui/index.ts'
import { tempDir, removeDir } from './tmp.ts'

test('magic --settings 无 Engine 安装时使用共享默认目标，真实 PTY 保存偏好且不启动服务', async () => {
  const fixture = startFixture({ turns: [] }), sandbox = createSandbox({ baseURL: fixture.baseURL })
  const artifacts = tempDir('magic-offline-settings-'), parent = join(sandbox.root, 'selected')
  mkdirSync(join(parent, '.magic'), { recursive: true })
  writeFileSync(join(parent, '.magic/config.json'), JSON.stringify({ future: { retained: true } }))
  const directory = componentDirectory(sandbox.home)
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'engine.json'), JSON.stringify({ parent }))
  const { MAGIC_HOME: _explicit, ...env } = sandbox.env
  const ui = await createUiSession({ fixture, sandbox: { ...sandbox, env }, artifacts,
    command: [process.execPath, join(import.meta.dir, '../src/cli.ts'), '--settings'] })
  try {
    await ui.wait({ text: '本地设置' })
    await ui.send('/config '); await ui.key('enter'); await ui.wait({ text: '减少动效' })
    await ui.send('减少动效'); await ui.key('enter')
    const deadline = Date.now() + 3000
    while (!JSON.parse(readFileSync(join(parent, '.magic/config.json'), 'utf8')).motion?.reduced && Date.now() < deadline) await Bun.sleep(10)
    expect(JSON.parse(readFileSync(join(parent, '.magic/config.json'), 'utf8'))).toEqual({ future: { retained: true }, motion: { reduced: true } })
    await ui.wait({ text: '已保存' })
    await ui.key('esc', { until: { text: '已关 · Enter 切换' } })
    await ui.key('esc', { until: { absent: '筛选「减少动效」' } })
    await ui.send('不可执行的草稿', { until: { text: '不可执行的草稿' } })
    await ui.key('enter', { until: { text: '本地设置不发送任务，草稿已保留' } })
    const screen = (await ui.screen()).lines.map(line => line.text).join('\n')
    expect(screen).toContain('不可执行的草稿')
    expect(screen).not.toContain('Engine 未连接，这项运行操作暂不可用。')
    expect(fixture.requests()).toHaveLength(0)
    expect(existsSync(join(parent, '.magic/records.db'))).toBe(false)
    expect(existsSync(join(directory, 'runtime/host.json'))).toBe(false)
    expect(existsSync(join(directory, 'components.json'))).toBe(false)
  } finally { await ui.close(); await fixture.stop(); await sandbox.dispose(); removeDir(artifacts) }
}, 20000)
