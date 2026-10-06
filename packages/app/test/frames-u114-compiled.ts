import { strict as assert } from 'node:assert'
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { startFixture } from './ui/fixture.ts'
import { createSandbox } from './ui/sandbox.ts'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'
import { startResidentHost } from './resident-host-fixture.ts'
const root = REPO_ROOT
const binary = root + '/.ui-runs/u114-build/magic'
const wrapper = root + '/.ui-runs/u114-build/compiled-host.ts'
const fixture = startFixture({ turns: [{ kind: 'tool', name: 'exec', args: { cmd: 'printf U114_COMPILED_TOOL' } }, { kind: 'text', text: 'U114_COMPILED_COMPLETE', chunks: 1, chunkDelayMs: 10 }] })
const sandbox = createSandbox({ baseURL: fixture.baseURL, config: { motion: { reduced: true } } })
const app = sandbox.root + '/Test Host.app'
mkdirSync(app + '/Contents/Helpers', { recursive: true })
const packagedBinary = app + '/Contents/Helpers/magic-runtime'
copyFileSync(binary, packagedBinary)
writeFileSync(app + '/Contents/Info.plist', '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.u114.controlled-test</string></dict></plist>')
// 只为复用持有生命管道的测试宿主；被测管理者、执行者和窗口都运行同一编译文件。
writeFileSync(wrapper, `const child=Bun.spawn([${JSON.stringify(packagedBinary)},...process.argv.slice(2)],{stdin:'inherit',stdout:'inherit',stderr:'inherit',cwd:process.cwd(),env:process.env});process.on('SIGTERM',()=>child.kill('SIGTERM'));process.exit(await child.exited)\n`)
const evidence = root + '/.ui-runs/u114/compiled-host-' + Date.now()
const host = await startResidentHost(sandbox, evidence, wrapper)
const ui = await createUiSession({ fixture, sandbox, command: [packagedBinary], columns: 200, rows: 40, label: 'U114-独立编译程序实跑', artifacts: root + '/.ui-runs/u114' })
try {
  await ui.send('/help '); await ui.key('enter'); await ui.wait({ text: '可用命令' })
  assert.equal(ui.requests().length, 0)
  await ui.send('验证编译程序的实际模型与工具通路'); await ui.key('enter'); await ui.wait({ text: 'U114_COMPILED_COMPLETE' }); await ui.wait({ text: '○ 空闲' })
  await ui.capture({ label: '200-编译窗口与工具真实完成' })
  assert.equal(ui.requests().filter(r => r.path.endsWith('/chat/completions')).length, 2)
  writeFileSync(ui.runDir + '/u114-compiled-facts.json', JSON.stringify({ binary, binarySHA256: createHash('sha256').update(readFileSync(binary)).digest('hex'), host: host.discovery, facts: ui.facts(), requests: ui.requests(), build: 'bun scripts/macos/build-helper.mjs <outfile>', proof: 'compiled CLI + compiled manager + compiled executor; loopback fixture; real printf tool' }, null, 2))
  console.log(ui.runDir)
} finally { await ui.close({ keepSandbox: true }); await host.close(); await fixture.stop() }
