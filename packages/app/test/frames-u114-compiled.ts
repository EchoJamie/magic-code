import { strict as assert } from 'node:assert'
import { writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { startFixture } from './ui/fixture.ts'
import { createSandbox } from './ui/sandbox.ts'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'
const root = REPO_ROOT
const payload = root + '/.artifacts/macos/Magic Code.app/Contents/Helpers'
const binary = payload + '/magic-cli'
const engine = payload + '/magic-engine'
const fixture = startFixture({ turns: [{ kind: 'tool', name: 'exec', args: { cmd: 'printf U114_COMPILED_TOOL' } }, { kind: 'text', text: 'U114_COMPILED_COMPLETE', chunks: 1, chunkDelayMs: 10 }] })
const sandbox = createSandbox({ baseURL: fixture.baseURL, config: { motion: { reduced: true } } })
const install = Bun.spawn([engine, 'install', '--profile', 'terminal', '--payload', payload, '--home', sandbox.home], { stdout: 'pipe', stderr: 'pipe' })
const installation = JSON.parse(await new Response(install.stdout).text())
assert.equal(await install.exited, 0, installation.error)
const packagedBinary = installation.components.cli as string
const installedEngine = installation.components.engine as string
async function control(action: string) {
  const process = Bun.spawn([installedEngine, 'service', action, '--home', sandbox.home], { stdout: 'pipe', stderr: 'pipe' })
  const value = JSON.parse(await new Response(process.stdout).text())
  assert.equal(await process.exited, 0, value.error)
  return value
}
const host = await control('start')
const ui = await createUiSession({ fixture, sandbox, command: [packagedBinary], columns: 200, rows: 40, label: 'U114-独立编译程序实跑', artifacts: root + '/.ui-runs/u114' })
try {
  await ui.send('/help '); await ui.key('enter'); await ui.wait({ text: '可用命令' })
  assert.equal(ui.requests().length, 0)
  await ui.send('验证编译程序的实际模型与工具通路'); await ui.key('enter'); await ui.wait({ text: 'U114_COMPILED_COMPLETE' }); await ui.wait({ text: '○ 空闲' })
  await ui.capture({ label: '200-编译窗口与工具真实完成' })
  assert.equal(ui.requests().filter(r => r.path.endsWith('/chat/completions')).length, 2)
  writeFileSync(ui.runDir + '/u114-compiled-facts.json', JSON.stringify({ binary, binarySHA256: createHash('sha256').update(readFileSync(binary)).digest('hex'), host: host.record, facts: ui.facts(), requests: ui.requests(), build: 'bash scripts/macos/build.sh', proof: 'independent compiled CLI + Engine with in-process Agents; loopback fixture; real printf tool' }, null, 2))
  console.log(ui.runDir)
} finally { await ui.close({ keepSandbox: true }); await control('remove'); await fixture.stop() }
